import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, logout } from './helpers.ts';

// WP-11: 출금 전 점검(F8·F13·F14)과 승인 대상 지문(F10).
// 요청자: 작성 화면 미리 보기 → 검토 단계의 점검·진행 사유(없으면 서버가 거부) → 승인 요청 뒤 지문 안내.
// 승인자: 결정 카드에서 같은 지문, 점검 결과, 요청자 사유, 되돌릴 수 없음 안내. 화면에 보인 지문이 서버와 다르면 승인되지 않는다.
// 바꾸는 데이터: 이 파일에서 만든 요청(ab-07·ab-01·ab-02로 가는 요청)뿐이다. ab-07로 가는 요청은 승인되어 처리 완료된다.

const FINGERPRINT = /^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/;

async function apiPost(page: Page, url: string, body: unknown) {
  const me = await (await page.request.get('/api/me')).json();
  const res = await page.request.post(url, { data: body, headers: { 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  const json = await res.json();
  expect(res.ok(), JSON.stringify(json)).toBeTruthy();
  return json;
}

/** 요청자 세션으로 초안 → 검토(→ 승인 요청)까지 API로 만든다. */
async function makeRequest(page: Page, body: Record<string, unknown>, submit: boolean) {
  const draft = await apiPost(page, '/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', amount: '1', purpose: 'E2E 출금 전 점검', ...body });
  const rv = await apiPost(page, `/api/requests/${draft.id}/review`, { version: draft.version });
  if (!submit) return rv;
  return apiPost(page, `/api/requests/${draft.id}/submit`, {
    version: rv.version, confirmTail: String(rv.address.address).slice(-6), ackIrreversible: true,
    checkReasons: { first_use: 'E2E 거래처와 전화로 주소 전체를 대조했습니다' },
  });
}

/** 문서 가로 넘침(레이아웃 폭 기준)과, 화면 밖으로 밀려난 점검 항목·지문·입력. */
const measure = (page: Page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const off = [...document.querySelectorAll('.rc-item, .rc-intent, .rc-intent-value, .rc-reason, .card textarea, .card input, h1, .dl dd')]
    .filter((e) => e.getClientRects().length > 0)
    .map((e) => ({ cls: e.className, right: Math.round(e.getBoundingClientRect().right), text: (e.textContent ?? '').trim().slice(0, 16) }))
    .filter((r) => r.right > vw + 1);
  return { overflow: document.documentElement.scrollWidth - vw, off, items: document.querySelectorAll('.rc-item').length };
});

test('요청자: 작성 미리 보기와 검토 단계의 점검, 진행 사유가 없으면 거부, 승인 요청 뒤 지문 → 승인자: 같은 지문·점검·사유를 보고 승인', async ({ page }) => {
  await loginAs(page, '한지수');
  const ab07 = await (await page.request.get('/api/addresses/ab-07')).json();

  // 1) 작성 화면: 주소와 수량을 고르면 저장하기 전에 점검 미리 보기가 보인다.
  await page.goto('/requests/new');
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await page.locator('#addressId').selectOption('ab-07');
  await page.getByLabel(/수량/).fill('1500');
  await page.getByRole('textbox', { name: /^요청 목적/ }).fill('E2E 해외 결제 대행 정산');
  await expect(page.getByRole('heading', { name: '출금 전 점검 미리 보기' })).toBeVisible();
  const previewFirst = page.locator('.rc-item', { hasText: '처음 보내는 주소입니다' });
  await expect(previewFirst).toBeVisible();
  await expect(previewFirst.locator('.rc-outcome')).toHaveText('주의');
  await expect(previewFirst).toContainText('소액을 시험 전송');
  await expect(page.locator('.rc-item', { hasText: '과거 출금 부족' }).locator('.rc-outcome')).toHaveText('확인 불가');
  await page.getByRole('button', { name: '초안 저장 후 검토하기' }).click();
  await expect(page.getByText('초안을 저장했습니다')).toBeVisible();
  const url = page.url();

  // 2) 작성 중 상세: 지금 기준 점검(읽기 전용)과 검토 단계 안내
  await expect(page.getByRole('heading', { name: '출금 전 점검', exact: true })).toBeVisible();
  await expect(page.getByText('검토로 이동한 뒤 주의 항목마다 진행 사유를 적어야 승인 요청을 보낼 수 있습니다.')).toBeVisible();
  await page.getByRole('button', { name: '검토로 이동' }).click();

  // 3) 검토 단계: 확인 카드 안의 점검과 진행 사유. 사유 없이 보내면 서버가 거부하고 입력으로 포커스를 옮긴다.
  const card = page.locator('section.card-action');
  await expect(card.getByRole('heading', { name: '최종 검토 후 승인 요청' })).toBeVisible();
  await expect(card.getByRole('heading', { name: '출금 전 점검', exact: true })).toBeVisible();
  const reasonBox = card.getByRole('textbox', { name: /^진행 사유: 처음 보내는 주소입니다/ });
  await expect(reasonBox).toBeVisible();
  // 아이콘과 결과 글자를 함께 둔다(색만으로 구분하지 않는다)
  const firstItem = card.locator('.rc-item', { hasText: '처음 보내는 주소입니다' });
  await expect(firstItem.locator('svg.rc-icon')).toHaveCount(1);
  await expect(firstItem.locator('.rc-outcome')).toHaveText('주의');
  await expect(firstItem.locator('.rc-basis')).toContainText('기준:');
  await card.getByLabel(/원본 주소의 끝 6자리/).fill(String(ab07.address).slice(-6));
  await card.getByLabel(/되돌릴 수 없다는 점/).check();
  await card.getByRole('button', { name: '승인 요청 보내기' }).click();
  const refused = page.getByRole('alert').filter({ hasText: '진행 사유가 필요합니다' });
  await expect(refused).toBeVisible();
  await expect(refused).toContainText('승인자에게 함께 보입니다');
  await expect(reasonBox).toHaveAttribute('aria-invalid', 'true');
  await expect(reasonBox).toBeFocused();
  const reviewId = new URL(url).pathname.split('/').pop()!;
  expect((await (await page.request.get(`/api/requests/${reviewId}`)).json()).status).toBe('REVIEW'); // 아무것도 예약되지 않았다
  const reasonText = 'E2E 결제 대행사 재무팀과 등록된 번호로 통화해 주소 전체를 대조했습니다';
  await reasonBox.fill(reasonText);
  await card.getByRole('button', { name: '승인 요청 보내기' }).click();

  // 4) 승인 요청 뒤: 요청자에게 지문을 알려 주고, 저장된 점검 결과와 사유를 보인다.
  const sent = page.getByRole('status').filter({ hasText: '승인 요청을 보냈습니다' });
  await expect(sent).toBeVisible();
  const fp = (await sent.locator('.rc-intent-inline').textContent())!.trim();
  expect(fp).toMatch(FINGERPRINT);
  await expect(page.locator('.dl dd').filter({ hasText: fp })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '출금 전 점검 결과' })).toBeVisible();
  await expect(page.locator('.rc-reason').filter({ hasText: reasonText })).toBeVisible();
  const dto = await (await page.request.get(`/api/requests/${reviewId}`)).json();
  expect(dto.intentHashDisplay).toBe(fp);
  await logout(page);

  // 5) 승인자: 결정 카드에 같은 지문, 점검 결과와 요청자 사유, 되돌릴 수 없음 안내
  await loginAs(page, '오민재');
  await page.goto(url);
  const decide = page.locator('section.card-action');
  await expect(decide.getByRole('heading', { name: '승인 또는 반려' })).toBeVisible();
  const intent = decide.getByRole('group', { name: '승인 대상 지문' });
  await expect(intent.locator('.rc-intent-value')).toHaveText(fp);
  await expect(intent).toContainText('승인 요청 뒤 이 중 하나라도 바뀌면 지문이 달라져 승인되지 않습니다');
  await expect(decide.getByRole('heading', { name: '출금 전 점검 결과' })).toBeVisible();
  await expect(decide.locator('.rc-item', { hasText: '처음 보내는 주소입니다' }).locator('.rc-reason')).toContainText(reasonText);
  await expect(decide).toContainText('은행 착오송금처럼 되돌려 받는 절차도 없습니다');
  // 지문과 점검은 결정 버튼보다 먼저 읽힌다
  const order = await decide.evaluate((el) => {
    const pos = (s: string) => [...el.querySelectorAll('*')].indexOf(el.querySelector(s)!);
    return { intent: pos('.rc-intent'), checks: pos('.rc-list'), approve: pos('button.btn-primary') };
  });
  expect(order.intent).toBeLessThan(order.checks);
  expect(order.checks).toBeLessThan(order.approve);
  // 같은 지문이 두 번 보이지 않는다(정의 목록에는 쓰지 않는다)
  await expect(page.locator('.dl dt', { hasText: '승인 대상 지문' })).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await page.getByLabel(/받는 곳과 목적이/).check();
  await page.getByLabel(/근거 문서와 같습니다/).check();
  await page.getByLabel(/앞·뒤 묶음과 네트워크/).check();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.getByText('처리 중').first()).toBeVisible();
  await expect(page.locator('.timeline')).toContainText(`지문 ${fp}`);
});

test('승인자 화면에 보인 지문이 서버의 지문과 다르면 승인되지 않고(409), 원인과 행동을 보인다', async ({ page }) => {
  await loginAs(page, '한지수');
  const pending = await makeRequest(page, { addressId: 'ab-01', amount: '2' }, true);
  expect(pending.status).toBe('PENDING_APPROVAL');
  await logout(page);

  await loginAs(page, '서예린');
  // 화면이 받은 응답의 지문만 바꾼다(화면·전송 경로가 바뀐 상황을 흉내 낸다).
  await page.route(`**/api/requests/${pending.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    return route.fulfill({ response: res, json: { ...body, intentHash: 'f'.repeat(64), intentHashDisplay: 'FFFF FFFF FFFF FFFF' } });
  });
  await page.goto(`/requests/${pending.id}`);
  await expect(page.locator('.rc-intent-value')).toHaveText('FFFF FFFF FFFF FFFF');
  await page.getByLabel(/받는 곳과 목적이/).check();
  await page.getByLabel(/근거 문서와 같습니다/).check();
  await page.getByLabel(/앞·뒤 묶음과 네트워크/).check();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: '결정하려던 내용과 지금 요청의 승인 대상 지문이 다릅니다.' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('승인 대상 지문을 다시 확인한 뒤 결정하세요');
  expect((await (await page.request.get(`/api/requests/${pending.id}`)).json()).status).toBe('PENDING_APPROVAL');

  // 화면이 서버의 지문을 그대로 보이면 승인된다.
  await page.unroute(`**/api/requests/${pending.id}`);
  await page.reload();
  await expect(page.locator('.rc-intent-value')).toHaveText(pending.intentHashDisplay);
  await page.getByLabel(/받는 곳과 목적이/).check();
  await page.getByLabel(/근거 문서와 같습니다/).check();
  await page.getByLabel(/앞·뒤 묶음과 네트워크/).check();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  await expect(page.getByText('처리 중').first()).toBeVisible();
});

test.describe('390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('작성 미리 보기·검토 카드·결정 카드·감사 기록이 가로로 넘치지 않는다', async ({ page }) => {
    await loginAs(page, '한지수');
    // 작성 화면의 미리 보기(ab-02: USDC/Kaia, 처음 보내는 주소)
    await page.goto('/requests/new');
    await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
    await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('KAIA');
    await page.locator('#addressId').selectOption('ab-02');
    await page.getByLabel(/수량/).fill('1000');
    await expect(page.locator('.rc-item').first()).toBeVisible();
    let m = await measure(page);
    expect(m.overflow, '/requests/new').toBeLessThanOrEqual(1);
    expect(m.off, '/requests/new').toEqual([]);
    expect(m.items).toBe(5);
    page.once('dialog', (d) => void d.accept());
    await page.goto('/');
    await page.locator('#page-title').waitFor();

    // 검토 단계(진행 사유 입력이 있는 확인 카드)
    const review = await makeRequest(page, { assetCode: 'USDC', networkCode: 'KAIA', addressId: 'ab-02', amount: '1000' }, false);
    await page.goto(`/requests/${review.id}`);
    await expect(page.getByRole('textbox', { name: /^진행 사유: 처음 보내는 주소입니다/ })).toBeVisible();
    await page.waitForLoadState('networkidle');
    m = await measure(page);
    expect(m.overflow, 'review').toBeLessThanOrEqual(1);
    expect(m.off, 'review').toEqual([]);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);

    // 승인 요청 뒤 요청자 화면(지문은 정의 목록, 점검 결과는 카드)
    const pending = await apiPost(page, `/api/requests/${review.id}/submit`, {
      version: review.version, confirmTail: String(review.address.address).slice(-6), ackIrreversible: true,
      checkReasons: { first_use: 'E2E 파트너 재무팀과 전화로 주소 전체를 대조했습니다. 좁은 화면에서 긴 사유가 줄을 바꾸는지 함께 봅니다.' },
    });
    await page.goto(`/requests/${pending.id}`);
    await expect(page.locator('.dl dd .rc-intent-inline')).toHaveText(pending.intentHashDisplay);
    await page.waitForLoadState('networkidle');
    m = await measure(page);
    expect(m.overflow, 'pending (requester)').toBeLessThanOrEqual(1);
    expect(m.off, 'pending (requester)').toEqual([]);
    await logout(page);

    // 승인자 결정 카드
    await loginAs(page, '오민재');
    await page.goto(`/requests/${pending.id}`);
    await expect(page.locator('section.card-action .rc-intent-value')).toHaveText(pending.intentHashDisplay);
    await page.waitForLoadState('networkidle');
    m = await measure(page);
    expect(m.overflow, 'decide card').toBeLessThanOrEqual(1);
    expect(m.off, 'decide card').toEqual([]);
    // 정리: 이 요청을 반려해 예약 수량을 푼다
    await apiPost(page, `/api/requests/${pending.id}/reject`, { version: pending.version, reason: 'E2E 화면 점검용 요청 정리', intentHash: pending.intentHash });
    await logout(page);

    // 감사 기록(행동 이름은 화면·CSV 공용 이름)
    await loginAs(page, '문태호');
    await page.goto('/audit?pageSize=25');
    await page.locator('table tbody tr').first().waitFor();
    await page.waitForLoadState('networkidle');
    m = await measure(page);
    expect(m.overflow, '/audit').toBeLessThanOrEqual(1);
    await expect(page.locator('select option', { hasText: '승인 요청' }).first()).toBeAttached();
  });
});
