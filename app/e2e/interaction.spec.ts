import { expect, test, type Page, type Route } from '@playwright/test';
import { loginAs } from './helpers.ts';

// 검수 review-20261019-0130 대응: 앱 대화상자, 작성 중 보호, 필드 오류·입력 유지, 공통 검색, 소유권(native select/date), 전역 계약.

async function apiPost(page: Page, url: string, body: unknown) {
  const me = await (await page.request.get('/api/me')).json();
  const res = await page.request.post(url, { data: body, headers: { 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

const activeDialog = (page: Page) => page.locator('dialog[open]');
const focusInDialog = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('dialog[open]'));

async function fillRequestForm(page: Page, amount = '3') {
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await page.getByLabel(/받는 주소/).selectOption({ label: '모의 거래소 A 입금 (USDC) — 모의 거래소 A' });
  await page.getByLabel(/수량/).fill(amount);
  await page.getByRole('textbox', { name: /^요청 목적/ }).fill('E2E 입력 유지 확인');
}

test('요청 취소: 앱 대화상자 초기 포커스·Tab 순환·Escape·포커스 복귀·실패 유지·중복 확정 방지', async ({ page }) => {
  await loginAs(page, '한지수');
  const draft = await apiPost(page, '/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '1', purpose: 'E2E 취소 대화상자' });
  await page.goto(`/requests/${draft.id}`);
  let nativeDialogs = 0;
  page.on('dialog', () => { nativeDialogs += 1; });

  const trigger = page.getByRole('button', { name: '요청 취소' });
  await trigger.click();
  const dlg = page.getByRole('alertdialog', { name: '이 출금 요청을 취소할까요?' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(draft.refNo);
  await expect(dlg).toContainText('다시 열 수 없습니다');
  await expect(dlg.getByRole('button', { name: '돌아가기' })).toBeFocused();
  // 배경은 inert: 모달 밖 요소는 포커스를 받을 수 없다
  expect(await page.evaluate(() => { const a = document.querySelector<HTMLElement>('#sidenav a')!; a.focus(); return document.activeElement === a; })).toBe(false);
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); expect(await focusInDialog(page)).toBe(true); }
  await page.keyboard.press('Shift+Tab');
  expect(await focusInDialog(page)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(activeDialog(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => { const a = document.querySelector<HTMLElement>('#sidenav a')!; a.focus(); const ok = document.activeElement === a; return ok; })).toBe(true);
  await trigger.focus();

  // 실패: 대화상자 유지 + 원인·복구 안내, 요청은 그대로
  await page.route('**/api/requests/*/cancel', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '처리 중 오류가 발생했습니다.', action: '잠시 후 다시 시도하세요.' }, requestId: 'e2e00000' }) }));
  await page.keyboard.press('Enter');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: '요청 취소' }).click();
  await expect(dlg.getByRole('alert')).toContainText('처리 중 오류가 발생했습니다.');
  await expect(dlg).toBeVisible();
  await page.unroute('**/api/requests/*/cancel');

  // 처리 중: 두 번 눌러도 한 번만 전송, 처리 중에는 Escape로 닫히지 않음
  let posts = 0;
  await page.route('**/api/requests/*/cancel', async (r) => { posts += 1; await new Promise((res) => setTimeout(res, 800)); await r.continue(); });
  const confirmBtn = dlg.getByRole('button', { name: /요청 취소|처리 중/ });
  await confirmBtn.click();
  await confirmBtn.click({ force: true });
  await expect(dlg).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeVisible();
  await expect(activeDialog(page)).toHaveCount(0, { timeout: 5000 });
  expect(posts).toBe(1);
  await expect(page.getByText('취소', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '요청 취소' })).toHaveCount(0);
  await expect(page.locator('#page-title')).toBeFocused();
  expect(nativeDialogs).toBe(0);
});

test('목록에서 상세로 이동: 불러오기가 끝난 뒤 화면 제목으로 포커스(클릭·키보드), 그 사이 사용자가 옮긴 포커스는 그대로 둔다', async ({ page }) => {
  await loginAs(page, '오민재');
  // 상세 조회를 늦춰 '불러오는 중' 화면(제목 없음)을 반드시 거치게 한다. 클릭한 링크는 이때 사라진다.
  let delay = 400;
  const slow = async (r: Route) => { await new Promise((res) => setTimeout(res, delay)); await r.continue().catch(() => {}); };
  await page.route(/\/api\/(addresses|requests)\/[^/?]+$/, slow);
  const title = page.locator('#page-title');
  const loading = page.locator('main .state-loading');

  // 주소록 → 주소 상세(클릭)
  await page.goto('/addresses');
  await expect(page.getByRole('heading', { name: '보낼 곳 주소록' })).toBeVisible();
  await page.getByRole('link', { name: '모의 거래소 A 입금 (USDC)' }).click();
  await expect(page).toHaveURL(/\/addresses\/ab-01$/);
  await expect(title).toHaveText('모의 거래소 A 입금 (USDC)');
  await expect(title).toBeFocused();

  // 주소록 → 주소 상세(키보드 Enter)
  await page.goto('/addresses');
  const link = page.getByRole('link', { name: '모의 거래소 A 입금 (XRP)' });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/addresses\/ab-04$/);
  await expect(title).toHaveText('모의 거래소 A 입금 (XRP)');
  await expect(title).toBeFocused();

  // 결재 및 요청 → 요청 상세(클릭)
  await page.goto('/requests');
  const req = page.locator('a.req-item').first();
  const reqHref = (await req.getAttribute('href'))!;
  await req.click();
  await expect(page).toHaveURL(new RegExp(`${reqHref}$`));
  await expect(title).toHaveText(/^출금 요청 WR-/);
  await expect(title).toBeFocused();

  // 홈 → 진행 중 요청 상세(키보드 Enter)
  await page.goto('/');
  const progress = page.locator('a.progress-item').first();
  await progress.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/requests\/[^/]+$/);
  await expect(title).toHaveText(/^출금 요청 WR-/);
  await expect(title).toBeFocused();

  // 불러오는 동안 사용자가 다른 곳으로 포커스를 옮겼다면, 제목이 나타나도 포커스를 빼앗지 않는다.
  delay = 1500;
  await page.goto('/addresses');
  await page.getByRole('link', { name: '모의 거래소 A 입금 (USDC)' }).click();
  await expect(loading).toBeVisible();
  const home = page.getByRole('link', { name: '홈' });
  await home.focus();
  await expect(title).toHaveText('모의 거래소 A 입금 (USDC)');
  await expect(home).toBeFocused();
  await page.unroute(/\/api\/(addresses|requests)\/[^/?]+$/, slow);
});

test('주소 사용 중지: 대상·되돌릴 수 없음 표시, 취소 시 변경 없음, 확정 시 상태 변경', async ({ page }) => {
  await loginAs(page, '윤가람');
  await page.goto('/addresses/ab-12');
  const trigger = page.getByRole('button', { name: '사용 중지' });
  await trigger.click();
  const dlg = page.getByRole('alertdialog', { name: '이 주소를 사용 중지할까요?' });
  await expect(dlg).toContainText('모의 거래소 J 입금 (Kaia)');
  await expect(dlg).toContainText('되돌릴 수 없습니다');
  // 이 주소를 쓰는 진행 중 요청 수(서버 값 기준)
  const open: number = (await (await page.request.get('/api/addresses/ab-12')).json()).openRequestCount;
  await expect(dlg).toContainText(open > 0 ? `이 주소를 쓰는 진행 중 요청 ${open}건은 승인할 수 없게 됩니다` : '지금 이 주소를 쓰는 진행 중 요청은 없습니다');
  await expect(dlg.getByRole('button', { name: '취소' })).toBeFocused();
  await dlg.getByRole('button', { name: '취소' }).click();
  await expect(trigger).toBeFocused();
  expect((await (await page.request.get('/api/addresses/ab-12')).json()).status).toBe('ACTIVE');
  await trigger.click();
  await dlg.getByRole('button', { name: '사용 중지' }).click();
  await expect(page.getByText('주소를 사용 중지했습니다')).toBeVisible();
  await expect(activeDialog(page)).toHaveCount(0);
  expect((await (await page.request.get('/api/addresses/ab-12')).json()).status).toBe('DISABLED');
});

test('작성 중 이탈: 인앱 이동 확인(계속 작성/버리기), 깨끗한 폼은 바로 이동, 저장 성공 뒤 경고 없음, 창 닫기 beforeunload', async ({ page }) => {
  await loginAs(page, '한지수');
  // 깨끗한 폼은 확인 없이 이동
  await page.goto('/requests/new');
  await page.getByRole('link', { name: '보낼 곳 주소록' }).click();
  await expect(page).toHaveURL(/\/addresses$/);
  await expect(activeDialog(page)).toHaveCount(0);

  await page.goto('/requests/new');
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('link', { name: '보낼 곳 주소록' }).click();
  const dlg = page.getByRole('alertdialog', { name: '작성 중인 내용이 있습니다' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('button', { name: '계속 작성' })).toBeFocused();
  await dlg.getByRole('button', { name: '계속 작성' }).click();
  await expect(page).toHaveURL(/\/requests\/new$/);
  await expect(page.getByRole('combobox', { name: /^자산/ })).toHaveValue('USDC');
  // 폼 안의 취소 링크도 같은 확인을 거친다
  await page.getByRole('link', { name: '취소' }).click();
  await dlg.getByRole('button', { name: '작성 내용 버리기' }).click();
  await expect(page).toHaveURL(/\/requests$/);

  // 저장 성공 뒤에는 경고 없이 상세로 이동, 이후 이동도 자유
  await page.goto('/requests/new');
  await fillRequestForm(page);
  await page.getByRole('button', { name: '초안 저장 후 검토하기' }).click();
  await expect(page.getByText('초안을 저장했습니다')).toBeVisible();
  await expect(activeDialog(page)).toHaveCount(0);
  // 저장 버튼은 화면과 함께 사라진다. 포커스는 문서 맨 앞이 아니라 새 화면의 제목에 있다.
  await expect(page.locator('#page-title')).toBeFocused();
  // 같은 화면 안의 수정 취소: 바꾼 내용이 있을 때만 확인
  await page.getByRole('button', { name: '내용 수정' }).click();
  await page.getByRole('button', { name: '수정 취소' }).click();
  await expect(activeDialog(page)).toHaveCount(0);
  await page.getByRole('button', { name: '내용 수정' }).click();
  await page.getByRole('textbox', { name: /^요청 목적/ }).fill('수정 중인 목적');
  await page.getByRole('button', { name: '수정 취소' }).click();
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: '계속 작성' }).click();
  await expect(page.getByRole('textbox', { name: /^요청 목적/ })).toHaveValue('수정 중인 목적');
  await page.getByRole('button', { name: '수정 취소' }).click();
  await dlg.getByRole('button', { name: '작성 내용 버리기' }).click();
  await expect(page.getByRole('button', { name: '내용 수정' })).toBeVisible();
  await page.getByRole('link', { name: '홈' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(activeDialog(page)).toHaveCount(0);

  // 머리글의 '출금 요청 작성'(A1)도 같은 이탈 확인을 거친다: 계속 작성은 입력을 지키고, 버리기를 고르면 작성 화면으로 간다.
  await page.goto('/addresses/new');
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('banner').getByRole('link', { name: '출금 요청 작성' }).click();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole('button', { name: '계속 작성' })).toBeFocused();
  await dlg.getByRole('button', { name: '계속 작성' }).click();
  await expect(page).toHaveURL(/\/addresses\/new$/);
  await expect(page.getByRole('combobox', { name: /^자산/ })).toHaveValue('USDC');
  await page.getByRole('banner').getByRole('link', { name: '출금 요청 작성' }).click();
  await dlg.getByRole('button', { name: '작성 내용 버리기' }).click();
  await expect(page).toHaveURL(/\/requests\/new$/);
  await expect(page.getByRole('heading', { name: '출금 요청 작성', level: 1 })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('link', { name: '출금 요청 작성' })).toHaveCount(0); // 작성 화면 자체에는 두지 않는다

  // 창 닫기: 작성 중일 때만 표준 beforeunload
  await page.goto('/addresses/new');
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('BTC');
  const seen: string[] = [];
  page.on('dialog', async (d) => { seen.push(d.type()); await d.accept(); });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => seen).toContain('beforeunload');
});

test('작성 화면 beforeunload는 깨끗할 때 뜨지 않는다', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/addresses/new');
  await page.getByRole('combobox', { name: /^자산/ }).click();
  const seen: string[] = [];
  page.on('dialog', async (d) => { seen.push(d.type()); await d.accept(); });
  await page.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 500));
  expect(seen).toEqual([]);
});

test('폼 오류: aria-invalid·aria-describedby·첫 오류 포커스, 네트워크/서버 오류·세션 만료 뒤 입력 유지', async ({ page, context }) => {
  await loginAs(page, '한지수');
  await page.goto('/requests/new');
  await page.getByRole('button', { name: '초안 저장 후 검토하기' }).click();
  const asset = page.getByRole('combobox', { name: /^자산/ });
  await expect(asset).toBeFocused();
  await expect(asset).toHaveAttribute('aria-invalid', 'true');
  await expect(asset).toHaveAttribute('aria-describedby', /assetCode-error/);
  await expect(page.locator('#assetCode-error')).not.toBeEmpty();

  await fillRequestForm(page, '1.1234567');
  await page.getByRole('button', { name: '초안 저장 후 검토하기' }).click();
  const amountInput = page.getByLabel(/수량/);
  await expect(amountInput).toBeFocused();
  await expect(amountInput).toHaveAttribute('aria-invalid', 'true');
  await expect(amountInput).toHaveAttribute('aria-describedby', 'amount-hint amount-error');
  await expect(page.locator('#amount-error')).toContainText('소수점 아래 6자리까지만');
  await amountInput.fill('4');

  // 네트워크 끊김 → 입력 유지
  await page.route('**/api/requests', (r) => (r.request().method() === 'POST' ? r.abort('internetdisconnected') : r.continue()));
  await page.getByRole('button', { name: '초안 저장 후 검토하기' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '서버에 연결하지 못했습니다' })).toBeVisible();
  await expect(page.getByText('입력한 내용은 화면에 남아 있습니다')).toBeVisible();
  await page.unroute('**/api/requests');
  // 서버 오류 → 입력 유지, 요청 번호 안내
  await page.route('**/api/requests', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '처리 중 오류가 발생했습니다.', action: '잠시 후 다시 시도하세요.' }, requestId: 'abcd1234ffff' }) }) : r.continue()));
  await page.getByRole('button', { name: '초안 저장 후 검토하기' }).click();
  await expect(page.getByText('요청 번호 abcd1234')).toBeVisible();
  await page.unroute('**/api/requests');
  await expect(amountInput).toHaveValue('4');
  await expect(page.getByRole('textbox', { name: /^요청 목적/ })).toHaveValue('E2E 입력 유지 확인');

  // 세션 만료 → 같은 계정 재로그인 대화상자, 화면·입력 유지 후 저장 성공
  // 메뉴 배지는 /api/dashboard를 15초마다 다시 읽는다(Layout). 쿠키를 지운 뒤 그 갱신이 먼저 401을 받으면
  // 저장을 누르기 전에 같은 대화상자가 떠 버튼을 가린다. 갱신 응답 직후에 쿠키를 지워, 저장 클릭이 먼저 401을 받게 한다.
  await page.waitForResponse((r) => new URL(r.url()).pathname === '/api/dashboard' && r.status() === 200, { timeout: 20_000 });
  await context.clearCookies();
  await page.getByRole('button', { name: '초안 저장 후 검토하기' }).click();
  const re = page.getByRole('alertdialog', { name: '로그인 세션이 만료되었습니다' });
  await expect(re).toBeVisible();
  await expect(page).toHaveURL(/\/requests\/new$/);
  const again = re.getByRole('button', { name: '한지수(으)로 다시 로그인' });
  await expect(again).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(re).toBeVisible(); // 안전한 선택이 재로그인이므로 Escape로 입력을 버리지 않는다
  await again.click();
  await expect(activeDialog(page)).toHaveCount(0);
  await expect(amountInput).toHaveValue('4');
  await page.getByRole('button', { name: '초안 저장 후 검토하기' }).click();
  await expect(page.getByText('초안을 저장했습니다')).toBeVisible();
  await expect(page.getByText('E2E 입력 유지 확인').first()).toBeVisible();
});

test('주소 등록 오류: 끝자리 불일치 시 해당 입력으로 포커스, 나머지 입력 유지', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/addresses/new');
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  const addr = 'MOCK-EVM-' + '1111222233334444555566667777888899990000';
  await page.locator('#address').fill(addr);
  await expect(page.locator('#address')).toHaveCSS('resize', 'none');
  await page.getByRole('textbox', { name: /^주소 이름/ }).fill('E2E 포커스 확인');
  await page.getByRole('textbox', { name: /^받는 곳/ }).fill('모의 포커스 거래처');
  await page.getByLabel(/주소 끝 6자리/).fill('123456');
  await page.getByLabel(/가운데 8자리/).fill('55556666');
  await page.getByRole('combobox', { name: /^받은 경로/ }).selectOption('email');
  await page.getByRole('combobox', { name: /^다시 확인한 경로/ }).selectOption('registered_phone');
  await page.getByRole('textbox', { name: /^확인한 상대·연락처/ }).fill('모의 거래처 재무팀 대표번호');
  await page.getByLabel(/별도 연락 수단/).check();
  await page.getByLabel(/보증하지 않는다는/).check();
  await page.getByRole('button', { name: '주소 등록', exact: true }).click();
  const tail = page.getByLabel(/주소 끝 6자리/);
  await expect(tail).toBeFocused();
  await expect(tail).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#address')).toHaveValue(addr);
  await expect(page.getByRole('textbox', { name: /^주소 이름/ })).toHaveValue('E2E 포커스 확인');
  // 끝자리를 고친 뒤 가운데가 틀리면 가운데 입력으로 포커스, 나머지 입력 유지
  await tail.fill('990000');
  const middle = page.getByLabel(/가운데 8자리/);
  await middle.fill('55550000');
  await page.getByRole('button', { name: '주소 등록', exact: true }).click();
  await expect(middle).toBeFocused();
  await expect(middle).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#confirmMiddle-error')).toContainText('가운데 글자와 일치하지 않습니다');
  await expect(tail).toHaveValue('990000');
  await expect(page.locator('#address')).toHaveValue(addr);
});

test('공통 검색: debounce, Enter 즉시, 한국어 IME 조합 중 조회 없음, 지우기 버튼·Escape, 늦은 응답이 최신 결과를 덮지 않음', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/addresses');
  await expect(page.getByRole('heading', { name: '보낼 곳 주소록' })).toBeVisible();
  const qs: string[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname === '/api/addresses') qs.push(u.searchParams.get('q') ?? ''); });
  const box = page.getByRole('searchbox', { name: '주소 검색' });

  // 빠른 입력은 마지막 값으로 한 번만 조회
  await box.click();
  await page.keyboard.type('USDC', { delay: 60 });
  await expect(page).toHaveURL(/q=USDC/);
  await page.waitForTimeout(400);
  expect(qs.filter((q) => q && q !== 'USDC')).toEqual([]);
  expect(qs.filter((q) => q === 'USDC').length).toBe(1);

  // 지우기 버튼: 즉시 반영, 입력으로 포커스
  await page.getByRole('button', { name: '검색어 지우기' }).click();
  await expect(box).toHaveValue('');
  await expect(box).toBeFocused();
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByRole('button', { name: '검색어 지우기' })).toHaveCount(0);

  // Enter는 debounce(300ms)를 기다리지 않는다. 테스트 실행기 쪽 시계(브라우저 왕복 포함)로 재면 부하가 걸린 실행에서
  // 흔들리므로, 페이지 안에서 Enter keydown부터 주소(URL) 갱신까지의 시간을 잰다.
  await page.evaluate(() => {
    const w = window as unknown as { __enterAt?: number; __urlAt?: number };
    delete w.__enterAt; delete w.__urlAt;
    document.addEventListener('keydown', (e) => { if (e.key === 'Enter') w.__enterAt ??= performance.now(); }, { capture: true });
    for (const k of ['pushState', 'replaceState'] as const) {
      const orig = history[k].bind(history);
      history[k] = (data: unknown, unused: string, url?: string | URL | null) => {
        if (String(url ?? '').includes('q=XRP')) w.__urlAt ??= performance.now();
        return orig(data, unused, url);
      };
    }
  });
  await page.keyboard.type('XRP');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/q=XRP/);
  const t = await page.evaluate(() => { const w = window as unknown as { __enterAt?: number; __urlAt?: number }; return { enter: w.__enterAt, url: w.__urlAt }; });
  expect(t.enter, 'Enter keydown을 기록하지 못했습니다').toBeDefined();
  expect(t.url, '주소 갱신을 기록하지 못했습니다').toBeDefined();
  expect(t.url! - t.enter!).toBeLessThan(250);
  // Escape로 지우기
  await page.keyboard.press('Escape');
  await expect(box).toHaveValue('');
  await expect(page).not.toHaveURL(/q=/);

  // IME 조합 중에는 URL·서버 조회 없음, 조합 확정 뒤 반영
  await page.waitForTimeout(400);
  qs.length = 0;
  const cdp = await page.context().newCDPSession(page);
  await box.focus();
  await cdp.send('Input.imeSetComposition', { text: 'ㄱ', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: '거', selectionStart: 1, selectionEnd: 1 });
  await page.waitForTimeout(700);
  await expect(box).toHaveValue('거');
  expect(qs).toEqual([]);
  await expect(page).not.toHaveURL(/q=/);
  await cdp.send('Input.insertText', { text: '거' });
  await cdp.send('Input.imeSetComposition', { text: '래', selectionStart: 1, selectionEnd: 1 });
  await page.waitForTimeout(700);
  expect(qs).toEqual([]);
  await cdp.send('Input.insertText', { text: '래' });
  await expect(box).toHaveValue('거래');
  await expect(page).toHaveURL(/q=%EA%B1%B0%EB%9E%98/);
  // 주소(URL)는 화면 전환(transition)이 그려지기 전에 먼저 바뀌고, 조회는 그 뒤 그려진 화면이 보낸다(A2b, docs/traceability.md).
  // 그래서 주소가 바뀐 직후 바로 세지 않고 조회 요청이 기록될 때까지 기다린다. 조회가 한 번뿐인지는 그대로 본다.
  await expect.poll(() => qs).toEqual(['거래']);

  // 늦게 도착한 이전 검색 결과가 최신 결과를 덮지 않는다
  await page.route('**/api/addresses?*q=USDC*', async (r) => { await new Promise((res) => setTimeout(res, 1500)); await r.continue().catch(() => {}); });
  await page.getByRole('button', { name: '검색어 지우기' }).click();
  await page.keyboard.type('USDC');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '검색어 지우기' }).click();
  await page.keyboard.type('XRP');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: /모의 거래소 A 입금 \(XRP\)/ })).toBeVisible();
  await page.waitForTimeout(1800);
  await expect(page.getByRole('link', { name: /모의 거래소 A 입금 \(XRP\)/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /모의 거래소 A 입금 \(USDC\)/ })).toHaveCount(0);
  await expect(page).toHaveURL(/q=XRP/);
  await page.unroute('**/api/addresses?*q=USDC*');

  // 상세 갔다가 돌아와도 검색어 유지
  await page.getByRole('link', { name: /모의 거래소 A 입금 \(XRP\)/ }).click();
  await page.getByRole('link', { name: '← 주소록' }).click();
  await expect(box).toHaveValue('XRP');
});

test('native select·date: 키보드 조작, ko-KR 날짜 입력, 좁은 폭에서 넘침 없음', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/requests');
  const order = page.getByRole('combobox', { name: '정렬' });
  await order.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL(/order=asc/);

  await page.goto('/activity');
  const from = page.getByLabel('시작일');
  await from.click();
  await page.keyboard.type('2026');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('01');
  await page.keyboard.type('15');
  await expect(from).toHaveValue('2026-01-15');
  await expect(page).toHaveURL(/from=2026-01-15/);
  await expect(page.getByLabel('종료일')).toHaveAttribute('min', '2026-01-15');
  // 확정 중간값(2026-01-01)으로 서버 조회가 일어나지 않았어야 한다
  const to = page.getByLabel('종료일');
  const seen: string[] = [];
  page.on('request', (rq) => { const u = new URL(rq.url()); if (u.pathname === '/api/activity' && u.searchParams.get('to')) seen.push(u.searchParams.get('to')!); });
  await to.focus();
  await page.keyboard.type('2026');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('1231');
  await expect(page).toHaveURL(/to=2026-12-31/);
  // 주소 갱신 직후 조회가 나가기까지 잠깐 걸릴 수 있으므로 기다리되, 중간값 조회가 없었는지는 그대로 본다.
  await expect.poll(() => seen).toEqual(['2026-12-31']);
  // 필터 초기화는 날짜 입력도 비운다
  await page.getByRole('button', { name: '필터 초기화' }).first().click();
  await expect(from).toHaveValue('');
  await expect(to).toHaveValue('');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/activity?from=2026-01-01&to=2026-12-31');
  await expect(page.getByRole('heading', { name: '자산 활동 내역' })).toBeVisible();
  for (const name of ['시작일', '종료일']) {
    const b = (await page.getByLabel(name).boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(390);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('전역 계약: 경로별 문서 제목, 스크롤바 기준, 공통 textarea, 복사 실패 안내, 좁은 홈의 자산 요약 위치', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true });
  });
  await loginAs(page, '오민재');
  await expect(page).toHaveTitle(/자산 현황 · KODA 법인 대시보드/);
  await page.goto('/requests');
  await expect(page).toHaveTitle('결재 및 요청 · KODA 법인 대시보드 (개발 환경)');
  await page.goto('/audit');
  await expect(page).toHaveTitle('권한 없음 · KODA 법인 대시보드 (개발 환경)');
  const sb = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); return { w: cs.scrollbarWidth, c: cs.scrollbarColor }; });
  expect(sb.w).toBe('thin');
  expect(sb.c).not.toBe('auto');

  await page.goto('/requests?view=to_approve');
  await page.getByRole('link', { name: /WR-000003/ }).click();
  await page.getByRole('button', { name: '복사' }).first().click();
  await expect(page.getByText('복사하지 못했습니다. 브라우저의 클립보드 권한을 확인하거나 주소를 직접 선택해 복사하세요.')).toBeVisible();

  const reason = page.getByLabel('반려 사유');
  await expect(reason).toHaveCSS('resize', 'none');
  const h0 = (await reason.boundingBox())!.height;
  await reason.fill(Array.from({ length: 6 }, (_, i) => `${i + 1}번째 줄 사유`).join('\n'));
  const h1 = (await reason.boundingBox())!.height;
  expect(h1).toBeGreaterThan(h0 + 40);
  await reason.fill(Array.from({ length: 30 }, (_, i) => `${i + 1}`).join('\n'));
  const h2 = (await reason.boundingBox())!.height;
  expect(await reason.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  expect(h2).toBeLessThan(320);
  // 반려 사유 작성 중 이동도 확인한다
  await page.getByRole('link', { name: '홈' }).click();
  await page.getByRole('alertdialog', { name: '작성 중인 내용이 있습니다' }).getByRole('button', { name: '작성 내용 버리기' }).click();
  await expect(page).toHaveURL(/\/$/);

  for (const vp of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
    await page.setViewportSize(vp);
    const hold = await page.getByRole('heading', { name: '보유 자산' }).boundingBox();
    const prog = await page.getByRole('heading', { name: /진행 중인 요청/ }).boundingBox();
    const tasks = await page.getByRole('heading', { name: '지금 처리할 일' }).boundingBox();
    expect(tasks!.y).toBeLessThan(hold!.y);
    expect(hold!.y).toBeLessThan(prog!.y);
    await expect(page.getByRole('heading', { name: '보유 자산' })).toHaveCount(1);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('heading', { name: '보유 자산' })).toHaveCount(1);
  const holdWide = (await page.getByRole('heading', { name: '보유 자산' }).boundingBox())!;
  expect(holdWide.y).toBeLessThan(400);
});

test('화면 이동 중 떠나는 목록의 필터 변경은 다음 화면 주소에 붙지 않는다(flow.spec 간헐 실패 재현, A2b)', async ({ page }) => {
  // 라우터는 화면 전환을 transition으로 그리므로, 「주소 등록」을 누른 직후 주소창은 이미 /addresses/new인데 주소록 목록은 잠시 남아 입력을 받는다.
  // 그 사이 목록의 '자산' 필터가 바뀌면 예전에는 그 값이 새 화면 주소(?assetCode=USDC)에 붙고, 등록 양식의 자산은 비어 있었다.
  // 클릭과 필터 변경을 한 작업 안에서 일으켜 그 틈을 매번 재현한다.
  await loginAs(page, '한지수');
  await page.goto('/addresses');
  await expect(page.getByRole('heading', { name: '보낼 곳 주소록', level: 1 })).toBeVisible();
  const listAsset = page.locator('form.toolbar label', { has: page.locator('.sr-only', { hasText: /^자산$/ }) }).locator('select');
  await expect(listAsset.locator('option[value="USDC"]')).toHaveCount(1);
  const at = await page.evaluate(() => {
    const filter = [...document.querySelectorAll<HTMLLabelElement>('form.toolbar label')].find((l) => l.querySelector('.sr-only')?.textContent === '자산')!.querySelector('select')!;
    document.querySelector<HTMLAnchorElement>('a[href="/addresses/new"]')!.click();
    filter.value = 'USDC';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    return { path: location.pathname, listFilterStillMounted: filter.isConnected };
  });
  // 재현 조건: 변경 시점에 주소창은 이미 다음 화면이고 목록 필터는 아직 화면에 있었다.
  expect(at).toEqual({ path: '/addresses/new', listFilterStillMounted: true });
  await expect(page.getByRole('heading', { name: '주소 등록', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/addresses\/new$/);
  const formAsset = page.locator('#assetCode');
  await expect(formAsset).toHaveValue('');
  await formAsset.selectOption('USDC');
  await expect(formAsset).toHaveValue('USDC');
  await expect(page.getByText('네트워크를 잘못 고르면')).toBeVisible();
});
