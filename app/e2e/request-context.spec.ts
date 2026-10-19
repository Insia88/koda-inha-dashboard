import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { loginAs, logout } from './helpers.ts';

// 결재 판단 근거(평가액·출처·시각, 필요 승인 근거), 승인할 수 없는 요청, 홈 링크와 상태 칩, 범위 밖 페이지, 인사이트 관리 목록.
// ab-01~ab-04, ab-12, WR-000003~WR-000005는 읽기만 한다. 바꾸는 데이터는 ab-06, 이 파일에서 만든 요청·인사이트 자료, 인사이트 자료의 게시 상태(검사 끝에 되돌리거나 숨김)뿐이다.

async function apiPost(page: Page, url: string, body: unknown) {
  const me = await (await page.request.get('/api/me')).json();
  const res = await page.request.post(url, { data: body, headers: { 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

/** 화면과 별도 세션(쿠키)으로 API를 호출한다. 다른 사람이 같은 시각에 바꾸는 상황을 만든다. */
async function asUser(request: APIRequestContext, userId: string) {
  expect((await request.post('/api/auth/dev-login', { data: { userId } })).ok()).toBeTruthy();
  const csrf = (await (await request.get('/api/me')).json()).csrfToken as string;
  return {
    get: async (url: string) => (await request.get(url)).json(),
    post: async (url: string, data: unknown) => {
      const res = await request.post(url, { data, headers: { 'X-CSRF-Token': csrf, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
      expect(res.ok(), await res.text()).toBeTruthy();
      return res.json();
    },
  };
}

const activeDialog = (page: Page) => page.locator('dialog[open]');
const pressedChips = (page: Page) => page.getByRole('group', { name: '상태 필터' }).locator('[aria-pressed="true"]');

test('WR-000003: 평가액·출처·기준 시각과 필요 승인 근거, 승인 카드의 되돌릴 수 없음·확인 안내', async ({ page }) => {
  await loginAs(page, '오민재');
  await page.goto('/requests/wr-3');
  await expect(page.getByRole('heading', { name: '출금 요청 WR-000003' })).toBeVisible();
  await expect(page.getByText('평가액 약 1.68억 원')).toBeVisible();
  await expect(page.getByText('(168,000,000원)')).toBeVisible();
  const stamp = page.locator('.stamp').filter({ hasText: '제출 시 시세 기준' });
  await expect(stamp).toContainText(/제출 시 시세 기준 \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST/);
  await expect(stamp).toContainText('모의 시세');
  await expect(stamp).toContainText('모의 데이터');
  await expect(page.getByText('원화 평가액이 1억 원 이상이라 서로 다른 승인자 2명이 필요합니다.')).toBeVisible();

  const card = page.locator('section.card-action');
  await expect(card.getByRole('heading', { name: '승인 또는 반려' })).toBeVisible();
  await expect(card).toContainText('블록체인 전송은 처리 후 되돌릴 수 없습니다');
  const approve = page.getByRole('button', { name: '승인', exact: true });
  const hint = page.getByText('세 항목을 모두 확인하면 승인할 수 있습니다.');
  await expect(approve).toBeDisabled();
  await expect(hint).toBeVisible();
  await expect(approve).toHaveAttribute('aria-describedby', 'approve-hint');
  await page.getByLabel(/받는 곳과 목적이/).check();
  await page.getByLabel(/근거 문서와 같습니다/).check();
  await expect(hint).toBeVisible();
  await page.getByLabel('받는 주소 전체(가운데 묶음 포함)를 원본과 대조했고, 앞·뒤 묶음과 네트워크(Kaia)도 확인했습니다.').check();
  await expect(hint).toHaveCount(0);
  await expect(approve).toBeEnabled(); // 누르지 않는다(WR-000003은 다른 검사가 쓴다)
});

test('검토 중 요청(WR-000005): 지금 모의 시세 평가액, 예상 승인 수, 끝자리 안내, 되돌리기·취소는 확인 카드 아래', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/requests/wr-5');
  await expect(page.getByRole('heading', { name: '최종 검토 후 승인 요청' })).toBeVisible();
  await expect(page.getByText('받는 주소를 가운데 묶음까지 원본과 대조하고, 끝 6자리를 입력해 승인 요청을 보내세요.')).toBeVisible();
  await expect(page.getByText('현재 평가액 약 1,500만 원')).toBeVisible();
  const stamp = page.locator('.stamp').filter({ hasText: '시세 기준' });
  await expect(stamp).toContainText(/시세 기준 \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST/);
  await expect(stamp).toContainText('모의 시세');
  await expect(page.getByText('승인 요청을 보낼 때 정해집니다')).toBeVisible();
  await expect(page.getByText(/지금 모의 시세로는 승인 1명이 필요합니다/)).toBeVisible();
  const submitCard = (await page.locator('section.card-action').boundingBox())!;
  for (const name of ['작성 단계로 되돌리기', '요청 취소']) {
    const b = (await page.getByRole('button', { name }).boundingBox())!;
    expect(b.y, name).toBeGreaterThan(submitCard.y + submitCard.height);
  }
});

test('받는 주소가 사용 중지된 승인 대기 요청: 서버 거부 안내 → 승인 불가 안내·사유 미리 채움·승인 불가 탭, 요청자 안내, 반려', async ({ page, request }) => {
  // 1) 요청자: ab-06(KAIA)로 승인 대기 요청을 만든다.
  await loginAs(page, '한지수');
  const ab06 = await (await page.request.get('/api/addresses/ab-06')).json();
  const draft = await apiPost(page, '/api/requests', { assetCode: 'KAIA', networkCode: 'KAIA', addressId: 'ab-06', amount: '100', purpose: 'E2E 주소 중지 승인 불가 확인' });
  const rv = await apiPost(page, `/api/requests/${draft.id}/review`, { version: draft.version });
  const sub = await apiPost(page, `/api/requests/${draft.id}/submit`, { version: rv.version, confirmTail: ab06.address.slice(-6), ackIrreversible: true, checkReasons: { first_use: 'E2E 파트너와 전화로 주소를 대조했습니다' } });
  expect(sub.status).toBe('PENDING_APPROVAL');
  await logout(page);

  // 2) 승인자가 상세를 연 뒤, 다른 관리자가 같은 시각에 받는 주소를 사용 중지한다.
  await loginAs(page, '오민재');
  // 승인을 누르기 전까지는 화면을 연 시점의 응답을 유지한다(주기적 새로 고침이 끼어들지 않게).
  let holdStale = true;
  let staleBody: string | null = null;
  await page.route(`**/api/requests/${draft.id}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (holdStale && staleBody) return route.fulfill({ status: 200, contentType: 'application/json', body: staleBody });
    const res = await route.fetch();
    const body = await res.text();
    if (holdStale) staleBody = body;
    return route.fulfill({ response: res, body });
  });
  await page.route(`**/api/requests/${draft.id}/approve`, async (route) => { holdStale = false; await route.continue(); });
  await page.goto(`/requests/${draft.id}`);
  await expect(page.getByRole('heading', { name: '승인 또는 반려' })).toBeVisible();
  // 승인자가 반려 사유를 먼저 적어 둔 상태에서 요청이 승인 불가로 바뀐다.
  const reason = page.getByLabel('반려 사유');
  const ownReason = '정산서 금액과 다릅니다. 확인 후 다시 요청해 주세요.';
  await reason.fill(ownReason);
  const admin = await asUser(request, 'u-a-yoon');
  const cur = await admin.get('/api/addresses/ab-06');
  expect((await admin.post('/api/addresses/ab-06/disable', { version: cur.version })).status).toBe('DISABLED');

  await page.getByLabel(/받는 곳과 목적이/).check();
  await page.getByLabel(/근거 문서와 같습니다/).check();
  await page.getByLabel(/앞·뒤 묶음과 네트워크/).check();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  // 서버가 거부한 원인과 복구 행동을 보이고, 최신 상태를 다시 불러와 승인 불가 상태로 바뀐다.
  const refused = page.getByRole('alert').filter({ hasText: '받는 주소가 더 이상 사용 가능 상태가 아닙니다.' });
  await expect(refused).toBeVisible();
  await expect(refused).toContainText('요청을 반려하고 주소 상태를 확인하세요.');
  await page.unroute(`**/api/requests/${draft.id}`);
  await page.unroute(`**/api/requests/${draft.id}/approve`);
  await expect(page.getByText('받는 주소가 사용 중지되어 승인할 수 없습니다. 사유와 함께 반려하세요').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '반려', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '승인', exact: true })).toHaveCount(0);
  // 직접 적은 사유는 덮어쓰지 않고, 작성 중 보호도 그대로다. 제안 사유는 버튼으로 넣을 수 있다.
  await expect(reason).toHaveValue(ownReason);
  const nextPanel = page.locator('section.next-action');
  await expect(nextPanel).toContainText('반려 사유를 확인하고 반려하세요.');
  await expect(nextPanel).not.toContainText('미리 채운');
  await page.getByRole('link', { name: '← 결재 및 요청' }).click();
  const guardDlg = page.getByRole('alertdialog', { name: '작성 중인 내용이 있습니다' });
  await expect(guardDlg).toBeVisible();
  await guardDlg.getByRole('button', { name: '계속 작성' }).click();
  await expect(page).toHaveURL(new RegExp(`/requests/${draft.id}$`));
  await page.getByRole('button', { name: '주소 사용 중지 사유로 바꾸기' }).click();
  await expect(reason).toHaveValue(/사용 중지되어 승인할 수 없으므로 반려합니다/);
  await expect(nextPanel).toContainText('미리 채운 반려 사유를 확인하고 반려하세요.');
  await expect(page.getByRole('button', { name: '주소 사용 중지 사유로 바꾸기' })).toHaveCount(0);

  // 미리 채운 사유는 작성 중으로 보지 않는다: 이동해도 확인 대화상자가 뜨지 않는다.
  await page.reload();
  await expect(reason).toHaveValue(/사용 중지되어 승인할 수 없으므로 반려합니다/);
  await expect(refused).toHaveCount(0);
  await page.getByRole('link', { name: '← 결재 및 요청' }).click();
  await expect(page).toHaveURL(/\/requests$/);
  await expect(activeDialog(page)).toHaveCount(0);

  // 승인 불가 탭에 보이고, 승인할 요청 탭에는 없다.
  await page.getByRole('tab', { name: '승인 불가(주소 중지)' }).click();
  await expect(page).toHaveURL(/view=blocked/);
  await expect(page.getByRole('tab', { name: '승인 불가(주소 중지)' })).toHaveAttribute('aria-selected', 'true');
  const row = page.getByRole('link', { name: new RegExp(sub.refNo) });
  await expect(row).toBeVisible();
  await expect(row).toContainText('승인 불가 · 주소 사용 중지');
  await page.getByRole('tab', { name: '내가 승인할 요청' }).click();
  await expect(page).toHaveURL(/view=to_approve/);
  await expect(page.getByRole('link', { name: new RegExp(sub.refNo) })).toHaveCount(0);
  await logout(page);

  // 3) 요청자: 취소하면 예약 수량이 풀린다는 안내
  await loginAs(page, '한지수');
  await page.goto(`/requests/${draft.id}`);
  await expect(page.getByText('요청을 취소하면 예약 수량이 풀립니다').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '요청 취소' })).toBeVisible();
  await logout(page);

  // 3-1) 결정 권한이 없는 사람(감사 담당): 다음 할 일은 무엇을 기다리는지, 이유는 아래 안내 한 곳에만 쓴다.
  await loginAs(page, '문태호');
  await page.goto(`/requests/${draft.id}`);
  const next = page.locator('section.next-action');
  await expect(next).toContainText('요청자의 취소나 승인자의 반려를 기다리는 중입니다.');
  await expect(next).not.toContainText('승인할 수 없는 요청입니다');
  await expect(page.locator('.notice-warning').filter({ hasText: '받는 주소가 사용 중지되어 승인할 수 없는 요청입니다' })).toHaveCount(1);
  await expect(page.getByText('받는 주소가 사용 중지되어 승인할 수 없는 요청입니다')).toHaveCount(1);
  await logout(page);

  // 4) 승인자: 미리 채운 사유로 반려하면 예약이 풀리고 승인 불가 목록에서 빠진다.
  await loginAs(page, '오민재');
  await page.goto(`/requests/${draft.id}`);
  await page.getByRole('button', { name: '반려', exact: true }).click();
  await expect(page.locator('.notice-danger').filter({ hasText: '반려 사유' })).toContainText('사용 중지되어 승인할 수 없으므로 반려합니다');
  await expect(page.getByText('반려', { exact: true }).first()).toBeVisible();
  await page.goto('/requests?view=blocked');
  await expect(page.getByRole('link', { name: new RegExp(sub.refNo) })).toHaveCount(0);
});

test('홈의 할 일 링크·전체 보기는 눌린 상태 칩으로 이어지고, 진행 중 건수가 같다', async ({ page }) => {
  for (const user of ['한지수', '오민재']) {
    await loginAs(page, user);
    await expect(page.locator('.task-list a').first()).toBeVisible();
    const hrefs =(await page.locator('.task-list a').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))).filter((h) => h.startsWith('/requests'));
    expect(hrefs.length, user).toBeGreaterThan(0);
    for (const href of hrefs) {
      await page.goto('/');
      await page.locator(`.task-list a[href="${href}"]`).click();
      await expect(page).toHaveURL(/\/requests\?/);
      await expect(pressedChips(page), href).toHaveCount(1);
      await expect(pressedChips(page)).toBeVisible();
      const view = new URL(href, 'http://x').searchParams.get('view');
      if (view) await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
    }
    await page.goto('/');
    const heading = (await page.getByRole('heading', { name: /진행 중인 요청/ }).textContent()) ?? '';
    const homeCount = Number(heading.match(/(\d+)건/)?.[1]);
    await page.getByRole('link', { name: '전체 보기' }).click();
    const chip = page.getByRole('button', { name: /^진행 중 \d+$/ });
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(chip).toHaveText(`진행 중 ${homeCount}`);
    await expect(pressedChips(page)).toHaveCount(1);
    await logout(page);
  }

  // 칩에 없는 상태 묶음(반려·처리 실패)은 눌린 상태의 해제 가능한 칩으로 보인다.
  await loginAs(page, '한지수');
  await page.goto('/requests?view=mine&status=REJECTED,FAILED');
  const custom = pressedChips(page);
  await expect(custom).toHaveCount(1);
  await expect(custom).toContainText('반려·처리 실패');
  await custom.click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(page.getByRole('button', { name: '전체', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/requests?view=mine&status=DRAFT,REVIEW');
  await expect(page.getByRole('button', { name: /^작성·검토 중/ })).toHaveAttribute('aria-pressed', 'true');
});

test('범위 밖 페이지: 안내와 첫 페이지로', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/requests?page=99');
  await expect(page.getByText('이 페이지에는 요청이 없습니다')).toBeVisible();
  await page.getByRole('button', { name: '첫 페이지로' }).click();
  await expect(page).not.toHaveURL(/page=99/);
  await expect(page.locator('.req-list li').first()).toBeVisible();
  await expect(page.getByText(/^전체 \d+건 중 1–/)).toBeVisible();
});

test('출금 요청 작성: 수량 아래에 읽은 수량·모의 시세 평가액·승인 기준이 바로 보인다', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/requests/new');
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await page.getByLabel(/받는 주소/).selectOption({ label: '모의 거래소 A 입금 (USDC) — 모의 거래소 A' });
  const amountInput = page.getByLabel(/수량/);
  const preview = page.locator('output[for="amount"]');
  await amountInput.fill('1,5');
  await expect(preview).toContainText('입력한 수량을 읽을 수 없습니다. 쉼표는 천 단위 구분(예: 1,000)에만 쓸 수 있습니다.');
  await amountInput.fill('80,000');
  await expect(preview).toContainText('읽은 수량 80,000 USDC');
  await expect(preview).toContainText(/약 1\.12억 원 \(모의 시세 \d{2}:\d{2} 기준\)/);
  await expect(preview).toContainText('1억 원 이상이라 서로 다른 승인자 2명 필요');
  await amountInput.fill('1000.5');
  await expect(preview).toContainText('읽은 수량 1,000.5 USDC · 약 140만 원');
  await expect(preview).toContainText('1억 원 이상이면 서로 다른 승인자 2명 필요');
  // 입력의 도움말 연결은 그대로다
  await expect(amountInput).toHaveAttribute('aria-describedby', 'amount-hint');
});

test('인사이트 관리: 더 보기로 모든 자료, 가장 오래된 자료 숨기기, 다시 게시 거부 안내, 제목 검색·기관 필터', async ({ page }) => {
  await loginAs(page, 'KODA 운영 담당');
  const all = await (await page.request.get('/api/insights?includeHidden=1&limit=50')).json();
  const total: number = all.total;
  expect(total).toBeGreaterThanOrEqual(26);
  const oldest = all.items[all.items.length - 1];
  await page.goto('/insights/manage');
  const rows = page.locator('table tbody tr');
  await expect(rows).toHaveCount(12);
  await expect(page.getByText(`${total}건 중 12건 표시`)).toBeVisible();
  for (let shown = 12; shown < total;) {
    await page.getByRole('button', { name: '더 보기' }).click();
    shown = Math.min(total, shown + 12);
    await expect(rows).toHaveCount(shown);
  }
  await expect(page.getByText('마지막 자료입니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '더 보기' })).toHaveCount(0);
  const last = rows.last();
  await expect(last).toContainText(oldest.title);
  await last.getByRole('button', { name: '숨기기' }).click();
  await expect(last.getByText('숨김', { exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/insights?includeHidden=1&limit=50')).json()).items.find((i: any) => i.id === oldest.id).status).toBe('hidden');
  // 정리: 다시 게시(화이트리스트 기관 자료라 허용된다)
  await last.getByRole('button', { name: '다시 게시' }).click();
  await expect(last.getByText('게시', { exact: true })).toBeVisible();

  // 기관 필터: 화이트리스트에 없는 기관 자료를 숨긴 뒤 다시 게시하면 거부 원인과 복구 행동이 보인다.
  await page.getByRole('combobox', { name: '기관 필터' }).selectOption('prov-x');
  await expect(page).toHaveURL(/provider=prov-x/);
  await expect(rows).toHaveCount(1);
  const x = rows.first();
  await x.getByRole('button', { name: /숨기기|다시 게시/ }).click();
  await expect(x.getByText('숨김', { exact: true })).toBeVisible();
  await x.getByRole('button', { name: '다시 게시' }).click();
  const refused = page.getByRole('alert').filter({ hasText: '화이트리스트에 없는 기관이라 게시할 수 없습니다' });
  await expect(refused).toBeVisible();
  await expect(refused).toContainText('화이트리스트 기관의 자료만 게시하세요');
  await expect(x.getByText('숨김', { exact: true })).toBeVisible();

  // 제목 검색
  await page.getByRole('combobox', { name: '기관 필터' }).selectOption('');
  await page.getByRole('searchbox', { name: '자료 제목 검색' }).fill('월간 정리');
  await expect(page).toHaveURL(/q=/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('디지털 자산 시장 월간 정리');
});

test('승인 요청 없이 끝난 요청은 필요 승인을 정하지 않았다고 쓰고, 시세를 불러오는 중·불러오지 못함은 시세 없음과 구분한다', async ({ page }) => {
  await loginAs(page, '한지수');
  const body = { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '100', purpose: 'E2E 승인 요청 전 취소 확인' };
  // 1) 작성 중에 취소한 요청
  const cancelled = await apiPost(page, '/api/requests', body);
  expect((await apiPost(page, `/api/requests/${cancelled.id}/cancel`, { version: cancelled.version })).status).toBe('CANCELLED');
  await page.goto(`/requests/${cancelled.id}`);
  await expect(page.getByRole('heading', { name: `출금 요청 ${cancelled.refNo}` })).toBeVisible();
  await expect(page.getByText('승인 요청 전에 끝난 요청이라 정하지 않았습니다')).toBeVisible();
  await expect(page.getByText('승인 요청을 보낼 때 정해집니다')).toHaveCount(0);
  await expect(page.getByText(/지금 모의 시세로는/)).toHaveCount(0);

  // 2) 작성 중 요청을 고칠 때 시세를 불러오는 중이면 그렇게, 불러오지 못하면 그렇게 쓴다(시세가 없다고 하지 않는다).
  const draft = await apiPost(page, '/api/requests', { ...body, purpose: 'E2E 시세 불러오기 실패 안내 확인' });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/balances', async (r) => {
    await gate;
    await r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '처리 중 오류가 발생했습니다.', action: '잠시 후 다시 시도하세요.' }, requestId: 'ffff0000bbbb' }) });
  });
  await page.goto(`/requests/${draft.id}`);
  await page.getByRole('button', { name: '내용 수정' }).click();
  const preview = page.locator('output[for="amount"]');
  await expect(preview).toContainText('읽은 수량 100 USDC');
  await expect(preview).toContainText('시세를 불러오는 중…');
  await expect(preview).toContainText('1억 원 이상이면 서로 다른 승인자 2명 필요');
  await expect(preview).not.toContainText('시세가 없어');
  release();
  await expect(preview).toContainText('시세를 불러오지 못해 평가액을 확인할 수 없습니다', { timeout: 15_000 });
  await expect(preview).toContainText('1억 원 이상이면 서로 다른 승인자 2명 필요');
  await expect(preview).not.toContainText('시세가 없어');
  await expect(preview).not.toContainText('이 경우 승인 요청 때');
  await page.unroute('**/api/balances');
  await page.getByRole('button', { name: '수정 취소' }).click();
  // 정리
  const cur = await (await page.request.get(`/api/requests/${draft.id}`)).json();
  expect((await apiPost(page, `/api/requests/${draft.id}/cancel`, { version: cur.version })).status).toBe('CANCELLED');
});

test('인사이트 관리: 지난 발행일로 게시한 자료도 게시 직후 맨 위에 한 번만 보이고, 원래 자리가 보이면 따로 표시하지 않는다', async ({ page }) => {
  await loginAs(page, 'KODA 운영 담당');
  await page.goto('/insights/manage');
  const rows = page.locator('table tbody tr');
  await expect(rows).toHaveCount(12);
  const stamp = Date.now();
  const publish = async (title: string, date: string) => {
    await page.getByRole('combobox', { name: /^제공 기관/ }).selectOption('prov-a');
    await page.getByLabel(/^발행일/).fill(date);
    await page.getByRole('textbox', { name: /^제목/ }).fill(title);
    await page.getByRole('textbox', { name: /^요약/ }).fill('E2E 모의 요약');
    await page.getByRole('textbox', { name: /^원문 주소/ }).fill(`https://example.com/mock-research/e2e-${stamp}-${date}`);
    await page.getByRole('button', { name: '게시', exact: true }).click();
    await expect(page.getByText('자료를 게시했습니다')).toBeVisible();
  };

  // 1) 지난 발행일: 처음 불러온 12건 밖이지만 맨 위에 '방금 게시'로 한 번만 보인다.
  const oldTitle = `E2E 지난 발행일 ${stamp}`;
  await publish(oldTitle, '2025-01-15');
  const oldCell = page.getByRole('cell', { name: oldTitle });
  await expect(oldCell).toHaveCount(1);
  await expect(rows.first()).toContainText(oldTitle);
  await expect(rows.first()).toContainText('방금 게시');
  await expect(rows).toHaveCount(13);
  await expect(page.getByText('방금 게시한 자료는 발행일과 관계없이 맨 위에 따로 표시')).toBeVisible();
  // 따로 표시한 줄에서도 숨기기가 반영된다.
  await rows.first().getByRole('button', { name: '숨기기' }).click();
  await expect(rows.first().getByText('숨김', { exact: true })).toBeVisible();
  await expect(rows.first()).toContainText(oldTitle);
  // 더 보기로 원래 자리까지 불러오면 따로 표시한 줄은 사라지고 한 번만 보인다.
  const total: number = (await (await page.request.get('/api/insights?includeHidden=1&limit=1')).json()).total;
  for (let shown = 12; shown < total;) {
    await page.getByRole('button', { name: '더 보기' }).click();
    shown = Math.min(total, shown + 12);
    await expect(page.getByText(`${total}건 중 ${shown}건 표시`)).toBeVisible();
  }
  await expect(page.getByText('마지막 자료입니다.')).toBeVisible();
  await expect(rows).toHaveCount(total);
  await expect(oldCell).toHaveCount(1);
  await expect(rows.filter({ has: oldCell })).not.toContainText('방금 게시');
  await expect(rows.filter({ has: oldCell }).getByText('숨김', { exact: true })).toBeVisible();
  await expect(page.getByText('방금 게시', { exact: true })).toHaveCount(0);

  // 2) 오늘 발행일: 첫 묶음 안에 있으므로 따로 표시하지 않는다(같은 자료가 두 줄로 보이지 않는다).
  await page.goto('/insights/manage');
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const newTitle = `E2E 오늘 발행일 ${stamp}`;
  await publish(newTitle, today);
  const newCell = page.getByRole('cell', { name: newTitle });
  await expect(newCell).toHaveCount(1);
  await expect(rows.filter({ has: newCell })).not.toContainText('방금 게시');
  await expect(rows).toHaveCount(12);
  // 정리: 고객 화면에 남지 않게 숨긴다.
  await rows.filter({ has: newCell }).getByRole('button', { name: '숨기기' }).click();
  await expect(rows.filter({ has: newCell }).getByText('숨김', { exact: true })).toBeVisible();
});
