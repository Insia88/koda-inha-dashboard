import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, logout } from './helpers.ts';

// 주소 오염(앞·뒤만 같은 가짜 주소) 대응 화면 검증. ab-01은 읽기만 하고, 이 파일에서 만든 주소·요청만 바꾼다.

const LABEL = 'E2E 유사 주소 점검';
const AB01_LABEL = '모의 거래소 A 입금 (USDC)';
const flip = (c: string, times = 1) => { let x = c; for (let i = 0; i < times; i++) x = ((parseInt(x, 16) + 1) % 16).toString(16).toUpperCase(); return x; };

/** ab-01의 앞 4자·뒤 6자는 그대로 두고 가운데를 모두 바꾼 모의 주소 */
async function poisonOfAb01(page: Page, times = 1) {
  const ab01: string = (await (await page.request.get('/api/addresses/ab-01')).json()).address;
  const body = ab01.replace('MOCK-EVM-', '');
  const poisonBody = body.slice(0, 4) + [...body.slice(4, -6)].map((c) => flip(c, times)).join('') + body.slice(-6);
  return { address: `MOCK-EVM-${poisonBody}`, middle: poisonBody.slice(16, 24), tail: poisonBody.slice(-6), ab01Middle: body.slice(16, 24) };
}

async function apiPost(page: Page, url: string, body: unknown) {
  const me = await (await page.request.get('/api/me')).json();
  const res = await page.request.post(url, { data: body, headers: { 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

/** 붙여넣기 이벤트가 막히는지(기본 동작 취소) 확인한다. */
function pasteBlocked(page: Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'PASTED');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
}

const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('유사 주소: 등록자는 비교를 보고 사유를 남기고, 승인자는 점검 결과·비교를 보고 메모와 함께 확인, 사용 중지 대화상자에 진행 중 요청 수', async ({ page }) => {
  // 1) 등록자: ab-01과 앞 4자·뒤 6자가 같은 주소 → 경고·글자 비교·사유 필수
  await loginAs(page, '한지수');
  const p = await poisonOfAb01(page);
  await page.goto('/addresses/new');
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await page.locator('#address').fill(p.address);
  await expect(page.getByText(`기존 주소 '${AB01_LABEL}'(사용 가능)와 앞 4자·뒤 6자가 같지만 가운데가 다릅니다.`)).toBeVisible();
  const cmp = page.getByRole('group', { name: new RegExp(`^입력한 주소와 기존 주소 '${AB01_LABEL.replace(/[()]/g, '\\$&')}'`) });
  await expect(cmp).toBeVisible();
  await expect(cmp).toContainText('같음');
  await expect(cmp).toContainText('다름');
  await expect(cmp).toContainText('앞 4자·뒤 6자 같음 · 가운데 30자 다름');
  await expect(cmp.locator('.cmp-same')).toHaveCount(20); // 두 줄 × (앞 4 + 뒤 6)
  await expect(cmp.locator('.cmp-diff')).toHaveCount(60); // 두 줄 × 가운데 30
  await expect(page.getByText(/안전합니다|안전한 주소/)).toHaveCount(0);

  await page.getByRole('textbox', { name: /^주소 이름/ }).fill(LABEL);
  await page.getByRole('textbox', { name: /^받는 곳/ }).fill('모의 유사 거래처');
  await expect(page.getByText(/가운데를 포함한 전체 글자를 받는 곳의 원본과/)).toBeVisible();
  await page.getByLabel(/주소 끝 6자리/).fill(p.tail);
  await page.getByLabel('원본 주소의 가운데 8자리 (고유부 17~24번째)').fill(p.middle);
  expect(await pasteBlocked(page, '#confirmTail')).toBe(true);
  expect(await pasteBlocked(page, '#confirmMiddle')).toBe(true);
  await page.getByLabel(/별도 연락 수단/).check();
  await page.getByLabel(/보증하지 않는다는/).check();
  await page.getByRole('button', { name: '확인 요청 보내기' }).click();
  const reason = page.getByRole('textbox', { name: /^비슷한 주소가 있는데도 등록하는 사유/ });
  await expect(reason).toBeFocused();
  await expect(reason).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#lookalikeReason-error')).toContainText('5자 이상');
  await expect(page.getByRole('alert').filter({ hasText: '비슷한 기존 주소가 있어 등록 사유가 필요합니다' })).toBeVisible();
  await reason.fill('거래처 재무팀에 전화로 전체 주소를 한 글자씩 확인했습니다');
  await page.getByRole('button', { name: '확인 요청 보내기' }).click();
  await expect(page.getByText('확인 요청을 보냈습니다')).toBeVisible();
  // 등록자 화면에도 비교 결과가 남는다
  await expect(page.getByRole('heading', { name: '비슷한 기존 주소' })).toBeVisible();
  await expect(page.getByText('거래처 재무팀에 전화로 전체 주소를 한 글자씩 확인했습니다')).toBeVisible();
  const detailUrl = new URL(page.url()).pathname;
  const id = detailUrl.split('/').pop()!;
  await logout(page);

  // 2) 승인자: 확인 카드에서 점검 결과·글자 비교를 보고, 메모 없이는 확인할 수 없다
  await loginAs(page, '오민재');
  await page.goto(detailUrl);
  const card = page.locator('section.card-action');
  await expect(card.getByRole('heading', { name: '주소 확인' })).toBeVisible();
  await expect(card.getByText(`기존 주소 '${AB01_LABEL}'(사용 가능)와 앞 4자·뒤 6자가 같지만 가운데가 다릅니다.`)).toBeVisible();
  const reviewCmp = card.getByRole('group', { name: new RegExp(`^이 주소와 기존 주소 '${AB01_LABEL.replace(/[()]/g, '\\$&')}'`) });
  await expect(reviewCmp).toBeVisible();
  await expect(reviewCmp).toContainText(AB01_LABEL);
  await expect(reviewCmp.locator('.cmp-diff')).toHaveCount(60);
  await expect(card.getByText(/가운데 8자리\(고유부 17~24번째\)를 입력한 뒤 확인합니다/)).toBeVisible();
  // 접근성 자동 검사(비교 표시 포함)
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

  await page.getByLabel('원본 주소의 끝 6자리').fill(p.tail);
  await page.getByLabel(/원본 주소의 가운데 8자리/).fill(p.ab01Middle); // 기존 주소의 가운데를 넣으면 거부
  expect(await pasteBlocked(page, '#tail')).toBe(true);
  expect(await pasteBlocked(page, '#middle')).toBe(true);
  await page.getByRole('button', { name: /사용 가능으로 확인/ }).click();
  const midInput = page.getByLabel(/원본 주소의 가운데 8자리/);
  await expect(midInput).toBeFocused();
  await expect(page.locator('#middle-error')).toContainText('가운데 글자와 일치하지 않습니다');
  await midInput.fill(p.middle);
  await page.getByRole('button', { name: /사용 가능으로 확인/ }).click();
  const note = page.getByRole('textbox', { name: /^확인 메모/ });
  await expect(note).toBeFocused();
  await expect(page.locator('#note-error')).toContainText('5자 이상');
  await note.fill('거래처 담당자와 전화로 가운데를 포함한 전체 주소를 대조했습니다');
  await page.getByRole('button', { name: /사용 가능으로 확인/ }).click();
  await expect(page.getByText('사용 가능', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '비슷한 기존 주소' })).toBeVisible();

  // 3) 390px 폭: 비교 표시가 가로로 넘치지 않는다
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('heading', { name: '비슷한 기존 주소' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  for (const box of await page.locator('.addr-compare').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) expect(box).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  await logout(page);

  // 4) 사용 중지 대화상자: 이 주소를 쓰는 진행 중 요청 수
  await loginAs(page, '한지수');
  const draft = await apiPost(page, '/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: id, amount: '1', purpose: 'E2E 유사 주소 진행 중 요청' });
  await logout(page);
  await loginAs(page, '윤가람');
  await page.goto(detailUrl);
  await page.getByRole('button', { name: '사용 중지' }).click();
  const dlg = page.getByRole('alertdialog', { name: '이 주소를 사용 중지할까요?' });
  await expect(dlg).toContainText('이 주소를 쓰는 진행 중 요청 1건은 승인할 수 없게 됩니다');
  await expect(dlg).toContainText('요청자가 취소하거나 승인자가 반려해야 예약 수량이 풀립니다');
  await dlg.getByRole('button', { name: '취소' }).click();
  expect((await (await page.request.get(`/api/addresses/${id}`)).json()).status).toBe('ACTIVE');
  await logout(page);

  // 정리: 이 파일에서 만든 요청을 취소한다
  await loginAs(page, '한지수');
  await apiPost(page, `/api/requests/${draft.id}/cancel`, { version: draft.version });
});

test('유사 주소 비교: 390px 폭 등록 화면에서도 가로로 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, '한지수');
  const p = await poisonOfAb01(page, 2);
  await page.goto('/addresses/new');
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await page.locator('#address').fill(p.address);
  await expect(page.getByRole('group', { name: /^입력한 주소와 기존 주소/ }).first()).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^비슷한 주소가 있는데도 등록하는 사유/ })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  for (const right of await page.locator('.addr-compare').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) expect(right).toBeLessThanOrEqual(390);
});
