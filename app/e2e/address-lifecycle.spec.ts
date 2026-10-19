import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, logout } from './helpers.ts';

// 주소 수명 주기 보호(WP-10). E2E 서버는 기존 흐름을 위해 사용 대기 0시간(ADDRESS_COOLDOWN_HOURS=0)으로 뜬다.
// 사용 대기는 시드의 사용 대기 주소 ab-14(2시간 전 확인, 22시간 뒤 사용 가능)로 검사한다.
// 이 파일은 ab-14를 마지막 정지 검사에서 사용 중지로 바꾼다. 다른 시드 행은 읽기만 한다.

const COOLING_LABEL = '신규 거래처 L 정산 주소';
const TASK_TITLE = /새 받는 주소 1건이 사용 대기 중입니다 — 요청하지 않은 등록이면 정지하세요/;
const activeDialog = (page: Page) => page.locator('dialog[open]');
/** 레이아웃 폭 기준 가로 넘침(px) */
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** KST "YYYY-MM-DD HH:mm" (화면 표기와 같은 방식) */
function kst(iso: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

async function apiPost(page: Page, url: string, body: unknown) {
  const me = await (await page.request.get('/api/me')).json();
  const res = await page.request.post(url, { data: body, headers: { 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  return { status: res.status(), body: await res.json() };
}

async function dustSender(page: Page): Promise<string> {
  const r = await (await page.request.get('/api/activity?q=MOCK-TX-DUST01')).json();
  expect(r.items).toHaveLength(1);
  return r.items[0].counterpartyAddress as string;
}

test('사용 대기: 홈 알림 → 목록 필터 → 상세의 사용 가능 시각(KST)·남은 시간·다른 경로 확인 기록, 요청에는 쓸 수 없음', async ({ page }) => {
  await loginAs(page, '한지수');
  const ab14 = await (await page.request.get('/api/addresses/ab-14')).json();
  expect(ab14.status).toBe('COOLING_DOWN');

  // 홈: 정지 권한이 있는 사람에게 경고 할 일로 보인다.
  const task = page.getByRole('link', { name: TASK_TITLE });
  await expect(task).toBeVisible();
  await task.click();
  await expect(page).toHaveURL(/\/addresses\?status=COOLING_DOWN/);
  await expect(page.getByRole('combobox', { name: '상태' })).toHaveValue('COOLING_DOWN');
  await expect(page.getByRole('combobox', { name: '상태' }).locator('option', { hasText: '사용 대기' })).toHaveCount(1);
  await expect(page.getByText('사용 대기 중인 주소입니다')).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: COOLING_LABEL });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.badge')).toHaveText('사용 대기');
  await expect(row).toContainText(`${kst(ab14.activeFrom)}부터`);
  await expect(row).toContainText(/\((?:2[12])시간 \d+분 남음\)/);

  // 상세: 사용 가능 시각(KST)과 남은 시간, 진행 순서, 다른 경로 확인 기록
  await row.getByRole('link', { name: COOLING_LABEL }).click();
  await expect(page.getByRole('heading', { name: COOLING_LABEL, level: 1 })).toBeVisible();
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: '사용 대기 중입니다' }) });
  await expect(card).toContainText(`${kst(ab14.activeFrom)} (KST)부터 출금 요청에 쓸 수 있습니다.`);
  await expect(card).toContainText(/남은 시간 2[12]시간 \d+분/);
  await expect(card.locator('[aria-current="step"]')).toContainText('사용 대기');
  const dl = page.locator('dl.dl').first();
  await expect(dl).toContainText('받은 경로이메일');
  await expect(dl).toContainText('다시 확인한 경로미리 등록된 연락처로 전화');
  await expect(dl).toContainText('확인한 상대·연락처모의 거래처 L 재무팀 대표번호(거래처 등록 연락처)');
  await expect(page.getByRole('heading', { name: '사용 대기 중 정지' })).toBeVisible();
  await expect(page.getByText(/안전합니다|안전한 주소/)).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

  // 출금 요청: 요청 작성 화면이 쓰는 받는 주소 목록(사용 가능만)에 없고, 직접 보내도 거절된다.
  const forRequest = await (await page.request.get('/api/addresses?status=ACTIVE&assetCode=USDC&networkCode=ETHEREUM&sort=label')).json();
  expect(forRequest.items.map((x: any) => x.id)).toContain('ab-01');
  expect(forRequest.items.map((x: any) => x.id)).not.toContain('ab-14');
  const draft = await apiPost(page, '/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-14', amount: '1', purpose: '사용 대기 주소 요청 시도' });
  expect(draft.status).toBe(422);
  expect(draft.body.error.code).toBe('ADDRESS_NOT_ACTIVE');
  await logout(page);

  // 감사 담당자: 대기 상태는 보이지만 정지할 수 없고, 홈 알림도 없다.
  await loginAs(page, '문태호');
  await expect(page.getByRole('heading', { name: '지금 처리할 일' })).toBeVisible();
  await expect(page.getByRole('link', { name: TASK_TITLE })).toHaveCount(0);
  await page.goto('/addresses/ab-14');
  await expect(page.getByRole('heading', { name: '사용 대기 중입니다' })).toBeVisible();
  await expect(page.getByText('정지는 주소 등록·확인 담당자나 조직 관리자가 할 수 있습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '사용 대기 중 정지' })).toHaveCount(0);
});

test('390px: 바뀐 화면(홈·주소록·주소 상세·주소 등록·활동 내역)이 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, '한지수');
  await expect(page.getByRole('link', { name: TASK_TITLE })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await page.goto('/addresses?status=COOLING_DOWN');
  await expect(page.getByRole('row').filter({ hasText: COOLING_LABEL })).toContainText('남음');
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await page.goto('/addresses/ab-14');
  await expect(page.getByRole('heading', { name: '사용 대기 중 정지' })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  for (const right of await page.locator('.lc-steps li, .lc-cooldown, .lc-stop').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) expect(right).toBeLessThanOrEqual(390);

  await page.goto('/addresses/new');
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await page.locator('#address').fill('MOCK-EVM-' + '7777888899990000AAAABBBBCCCCDDDDEEEEFFFF');
  await expect(page.getByRole('combobox', { name: /^받은 경로/ })).toBeEnabled();
  await page.getByRole('combobox', { name: /^받은 경로/ }).selectOption('in_person');
  await page.getByRole('combobox', { name: /^다시 확인한 경로/ }).selectOption('in_person');
  await expect(page.getByText('받은 경로와 같은 경로입니다. 주소를 받은 경로와 다른 경로로 다시 확인하세요.')).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await page.goto('/activity?q=MOCK-TX-DUST01');
  await expect(page.getByText('주소 오염 의심', { exact: true })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  for (const right of await page.locator('.lc-poison, .lc-poison .addr-code').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) expect(right).toBeLessThanOrEqual(390);
});

test('주소 오염 의심: 0원 입금에 위험 배지·설명, 보낸 주소에 복사 버튼 없음, 그 주소로는 등록할 수 없음', async ({ page }) => {
  await loginAs(page, '한지수');
  const sender = await dustSender(page);
  await page.goto('/activity?type=deposit&pageSize=100');
  const row = page.getByRole('row').filter({ hasText: '주소 오염 의심' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.badge-danger')).toHaveText('주소 오염 의심');
  await expect(row).toContainText('+0 USDC');
  await expect(row).toContainText('0원·소액 입금으로 거래 내역에 비슷한 주소를 남기는 공격에서 자주 보이는 기록입니다.');
  await expect(row).toContainText('앞 4자·뒤 6자가 같습니다');
  await expect(row).toContainText('이 주소를 복사해 쓰지 말고');
  await expect(row.locator('.lc-poison-addr .addr-code')).toHaveAttribute('aria-label', `보낸 주소 ${sender}`);
  await expect(row.locator('.lc-poison-addr .addr-chunk')).toHaveCount(10); // 고유부 40자 전체를 4자씩
  await expect(row.getByRole('button')).toHaveCount(0); // 복사 버튼 없음
  // 다른 입금 행에는 표시가 없다.
  await expect(page.locator('.lc-poison')).toHaveCount(1);

  // 거래 내역의 주소를 그대로 등록하려 하면 막힌다.
  await page.goto('/addresses/new');
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await page.locator('#address').fill(sender);
  await expect(page.getByText('최근 0원·소액 입금을 보낸 주소와 같습니다. 주소 오염 공격에서 자주 보이는 패턴이라 등록할 수 없습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '확인 요청 보내기' })).toBeDisabled();
});

test('사용 대기 중 정지: 사유 없이 누르면 사유 입력으로 안내, 대화상자(취소 초기 포커스·Escape) 뒤 확정하면 바로 사용 중지', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/addresses/ab-14');
  const trigger = page.getByRole('button', { name: '사용 대기 중 정지' });
  const reason = page.getByRole('textbox', { name: /^정지 사유/ });

  // 사유 없음: 대화상자를 열지 않고 사유 입력으로 포커스
  await trigger.click();
  await expect(activeDialog(page)).toHaveCount(0);
  await expect(reason).toBeFocused();
  await expect(reason).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#stop-reason-error')).toHaveText('정지 사유를 5자 이상 입력하세요.');

  const text = '등록을 요청한 적이 없는 주소라 정지합니다';
  await reason.fill(text);
  await trigger.click();
  const dialog = page.getByRole('alertdialog', { name: '이 주소의 사용 대기를 정지할까요?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '취소' })).toBeFocused();
  await expect(dialog).toContainText(text);
  await expect(dialog).toContainText('되돌릴 수 없습니다');
  await page.keyboard.press('Escape');
  await expect(activeDialog(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect((await (await page.request.get('/api/addresses/ab-14')).json()).status).toBe('COOLING_DOWN');

  await trigger.click();
  await dialog.getByRole('button', { name: '정지', exact: true }).click();
  await expect(activeDialog(page)).toHaveCount(0);
  await expect(page.getByText('사용 대기 중인 주소를 정지했습니다')).toBeVisible();
  await expect(page.locator('.page-header .badge')).toHaveText('사용 중지');
  await expect(page.locator('dl.dl').first()).toContainText(`정지 사유${text}`);
  await expect(page.getByText(`사용 대기 중 정지: ${COOLING_LABEL}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: '사용 대기 중 정지' })).toHaveCount(0);
  const after = await (await page.request.get('/api/addresses/ab-14')).json();
  expect(after).toMatchObject({ status: 'DISABLED', disabled: { reason: text } });
  const dash = await (await page.request.get('/api/dashboard')).json();
  expect(dash.tasks.find((t: any) => t.kind === 'cooling_addresses').count).toBe(0);
});
