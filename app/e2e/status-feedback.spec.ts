import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, logout, onDb } from './helpers.ts';
import { middleSegment } from '../shared/address-rules.ts';

// 결과·오류 안내와 포커스(G2 후속): 처리 결과가 누른 자리에서 보이고, 받는 주소를 쓸 수 없을 때 무엇을 해야 하는지 알린다.
// - 작성 중 요청의 받는 주소가 사용 중지되면 요청자 안내·다음 할 일·주소 상태 배지(「검토로 이동」은 내놓지 않음), 화면을 연 사이 중지되면 거부 안내로 포커스
// - 주소 확인 뒤 결과 안내로 포커스, 승인(1/2·마지막) 뒤 결과 안내로 포커스와 다음 할 일
// - 주소록 목록에서 유사 주소(ab-13)에 '비슷한 주소 있음' 표시, 흉내 낸 원래 주소(ab-02)에는 없음
// - (리뷰 2차) 검토로 이동·되돌리기·내용 수정 저장 뒤 「다음 할 일」로 포커스, 저장된 수량을 읽을 수 없는 초안의 안내와 내용 수정,
//   확인 때 0원·소액 입금 주소로 드러난 주소의 거절 안내(확인 버튼 없음)·목록 표시·거절 결과 안내로 포커스
// 바꾸는 데이터: 이 파일에서 만든 주소 6건과 그 주소로 가는 요청 5건, 그중 한 주소에서 들어온 0 USDC 모의 입금 1건과
// 저장 계층에서 수량을 바꾼 초안 1건뿐이다(다른 검사가 쓰는 시드 주소·요청은 읽기만 한다).
// 다른 검사의 점검 결과(최근 요청 수 등)에 영향을 주지 않도록 파일 이름 순서상 데스크톱 검사의 마지막에 돈다.

async function apiPost(page: Page, url: string, body: unknown) {
  const me = await (await page.request.get('/api/me')).json();
  const res = await page.request.post(url, { data: body, headers: { 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  const json = await res.json();
  expect(res.ok(), `${url} ${JSON.stringify(json)}`).toBeTruthy();
  return json;
}

/** 이 파일에서만 쓰는 모의 주소(실행마다 새로 만든다) */
const mockEvm = () => `MOCK-EVM-${randomBytes(20).toString('hex').toUpperCase()}`;

/** 한지수 세션으로 주소를 등록하고, 오민재 세션으로 API 확인까지 마친다(E2E 서버는 사용 대기 0시간). */
async function activeAddress(page: Page, label: string) {
  const address = mockEvm();
  await loginAs(page, '한지수');
  const created = await apiPost(page, '/api/addresses', {
    label, counterparty: '모의 상대방(E2E)', assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '',
    confirmTail: address.slice(-6), confirmMiddle: middleSegment(address).text, ackNotVerified: true, ackOutOfBandConfirmed: true,
    receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호',
  });
  await logout(page);
  return { id: created.address.id as string, address, version: created.address.version as number };
}

test('작성 중 요청의 받는 주소가 사용 중지되면: 요청자 안내·다음 할 일·주소 상태 배지가 보이고 「검토로 이동」은 내놓지 않는다', async ({ page }) => {
  const a = await activeAddress(page, 'E2E 사용 중지될 주소');
  await loginAs(page, '오민재');
  await apiPost(page, `/api/addresses/${a.id}/review`, { decision: 'approve', version: a.version, confirmTail: a.address.slice(-6), confirmMiddle: middleSegment(a.address).text, note: '' });
  await logout(page);
  await loginAs(page, '한지수');
  const draft = await apiPost(page, '/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: a.id, amount: '1', purpose: 'E2E 사용 중지 주소 초안' });
  await logout(page);
  // 조직 관리자가 주소를 사용 중지한다(유출 의심 등).
  await loginAs(page, '윤가람');
  const cur = await (await page.request.get(`/api/addresses/${a.id}`)).json();
  await apiPost(page, `/api/addresses/${a.id}/disable`, { version: cur.version });
  await logout(page);

  await loginAs(page, '한지수');
  await page.goto(`/requests/${draft.id}`);
  await expect(page.getByRole('heading', { name: `출금 요청 ${draft.refNo}` })).toBeVisible();
  await expect(page.locator('.next-action')).toContainText('「내용 수정」에서 사용 가능한 다른 받는 주소를 고르거나 요청을 취소하세요.');
  await expect(page.locator('.next-action')).not.toContainText('검토로 이동」을 누르세요');
  await expect(page.locator('.notice-danger').filter({ hasText: '받는 주소가 사용 중지되어 이 요청을 진행할 수 없습니다' })).toBeVisible();
  // 받는 곳의 상태 배지는 주소의 실제 상태 이름이다(일반 문구 '주소 사용 불가'가 아님).
  const recipient = page.locator('.dl dd').filter({ hasText: 'E2E 사용 중지될 주소' });
  await expect(recipient.locator('.badge')).toHaveText('사용 중지');
  await expect(page.getByText('주소 사용 불가')).toHaveCount(0);
  // 진행할 수 없는 행동은 처음부터 내놓지 않는다(서버가 허용 행동에서 검토를 뺀다).
  await expect(page.getByRole('button', { name: '검토로 이동' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '내용 수정' })).toBeVisible();
  // 읽기 전용 점검 안내도 이 주소로는 진행할 수 없다고 쓴다(검토로 이동한 뒤 사유를 적으라고 하지 않는다).
  await expect(page.locator('.rc-intro').first()).toContainText('이 주소로는 진행할 수 없으며, 다른 받는 주소로 바꾸면 그 주소로 다시 점검합니다.');
  await expect(page.getByText('검토로 이동한 뒤 진행 사유를 적어야')).toHaveCount(0);

  // 「내용 수정」: 사용 중지된 주소는 선택 상자에 없으므로 비워 둔 채 열고 왜 비었는지 알린다. 미리 보기는 갈 수 없는 '검토 단계'를 말하지 않는다.
  await page.getByRole('button', { name: '내용 수정' }).click();
  await expect(page.locator('#addressId')).toHaveValue('');
  await expect(page.locator('.notice').filter({ hasText: '지금 받는 주소(E2E 사용 중지될 주소)는 고를 수 없습니다' })).toContainText("'사용 중지' 상태인 주소라 출금 요청에 쓸 수 없습니다. 사용 가능한 다른 받는 주소를 고르세요.");
  await expect(page.getByText('검토 단계에서 다시 보여 드립니다')).toHaveCount(0);
  // 고르지 않고 저장하면 같은 화면의 받는 주소 칸 오류로 알린다('내용 수정에서 …' 같은, 이미 하고 있는 행동을 시키는 안내가 아니다).
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.locator('#addressId')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#addressId-error')).toHaveText('받는 주소를 선택하세요.');
  await expect(page.getByText('내용 수정에서 다른 주소를 고르거나')).toHaveCount(0);
  expect((await (await page.request.get(`/api/requests/${draft.id}`)).json()).address.id).toBe(a.id);
});

test('화면을 연 사이 받는 주소가 사용 중지되면: 「검토로 이동」 거부 안내가 버튼 위에 보이고 포커스, 요청은 그대로', async ({ page, browser }) => {
  const a = await activeAddress(page, 'E2E 열어 둔 사이 중지될 주소');
  await loginAs(page, '오민재');
  await apiPost(page, `/api/addresses/${a.id}/review`, { decision: 'approve', version: a.version, confirmTail: a.address.slice(-6), confirmMiddle: middleSegment(a.address).text, note: '' });
  await logout(page);
  await loginAs(page, '한지수');
  const draft = await apiPost(page, '/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: a.id, amount: '1', purpose: 'E2E 열어 둔 사이 중지 초안' });
  await page.goto(`/requests/${draft.id}`);
  await expect(page.getByRole('button', { name: '검토로 이동' })).toBeVisible();

  // 요청자가 화면을 열어 둔 채로, 다른 창에서 조직 관리자가 주소를 사용 중지한다.
  const admin = await browser.newContext({ baseURL: new URL(page.url()).origin, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const adminPage = await admin.newPage();
  await loginAs(adminPage, '윤가람');
  const cur = await (await adminPage.request.get(`/api/addresses/${a.id}`)).json();
  await apiPost(adminPage, `/api/addresses/${a.id}/disable`, { version: cur.version });
  await admin.close();

  // 「검토로 이동」: 서버가 거부하면 안내가 버튼 줄 바로 위에 보이고 그 안내로 포커스가 옮겨진다.
  await page.getByRole('button', { name: '검토로 이동' }).click();
  const refused = page.getByRole('alert').filter({ hasText: '사용 중지되어' });
  await expect(refused).toBeVisible();
  await expect(refused).toContainText('사용 가능한 다른 받는 주소를 고르거나 요청을 취소하세요');
  await expect(refused).not.toContainText('두 번째 담당자의 주소 확인');
  await expect(page.locator('.rc-focus-target').filter({ has: refused })).toBeFocused();
  await expect(refused).toBeInViewport();
  expect((await (await page.request.get(`/api/requests/${draft.id}`)).json()).status).toBe('DRAFT');
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

  // 「내용 수정」을 열면 지난 거부 안내는 내린다.
  await page.getByRole('button', { name: '내용 수정' }).click();
  await expect(refused).toHaveCount(0);
});

test('주소 확인 뒤 결과 안내로 포커스, 승인 1/2 뒤 결과 안내와 다음 할 일, 마지막 승인 뒤 처리 시작 안내로 포커스', async ({ page }) => {
  const a = await activeAddress(page, 'E2E 결과 안내 주소');

  // 1) 주소 확인: 확인 카드(누른 버튼)가 사라지고, 결과 안내로 포커스가 옮겨진다.
  await loginAs(page, '오민재');
  await page.goto(`/addresses/${a.id}`);
  await page.getByLabel('원본 주소의 끝 6자리').fill(a.address.slice(-6));
  await page.getByLabel(/원본 주소의 가운데 8자리/).fill(middleSegment(a.address).text);
  await page.getByRole('button', { name: /사용 가능으로 확인/ }).click();
  const confirmed = page.getByRole('status').filter({ hasText: '확인을 마쳤습니다' });
  await expect(confirmed).toBeVisible();
  await expect(page.locator('.rc-focus-target').filter({ has: confirmed })).toBeFocused();
  await expect(confirmed).toBeInViewport();
  await expect(page.getByRole('heading', { name: '주소 확인', exact: true })).toHaveCount(0);
  await logout(page);

  // 2) 요청자: 승인 2명이 필요한 요청(원화 평가액 1억 원 이상, 설계 가정)을 API로 승인 요청까지 보낸다.
  await loginAs(page, '한지수');
  const draft = await apiPost(page, '/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: a.id, amount: '80000', purpose: 'E2E 결과 안내 확인용 정산' });
  const rv = await apiPost(page, `/api/requests/${draft.id}/review`, { version: draft.version });
  const checkReasons = Object.fromEntries((rv.checks?.items ?? []).filter((c: any) => c.requiresReason).map((c: any) => [c.id, 'E2E 거래처 재무팀과 등록된 번호로 통화해 확인했습니다']));
  const sent = await apiPost(page, `/api/requests/${draft.id}/submit`, { version: rv.version, confirmTail: a.address.slice(-6), ackIrreversible: true, checkReasons });
  expect(sent.requiredApprovals).toBe(2);
  await logout(page);

  const tick = async () => {
    await page.getByLabel(/받는 곳과 목적이/).check();
    await page.getByLabel(/근거 문서와 같습니다/).check();
    await page.getByLabel(/앞·뒤 묶음과 네트워크/).check();
  };

  // 3) 첫 승인(1/2): 결정 카드가 사라진 자리 대신 위쪽 결과 안내로 포커스, 다음 할 일은 '내 결정을 마쳤습니다'.
  await loginAs(page, '오민재');
  await page.goto(`/requests/${draft.id}`);
  await tick();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  const partial = page.getByRole('status').filter({ hasText: '승인했습니다 (1/2)' });
  await expect(partial).toBeVisible();
  await expect(partial).toContainText('다른 승인자의 결정을 기다립니다');
  await expect(page.locator('.rc-focus-target').filter({ has: partial })).toBeFocused();
  await expect(partial).toBeInViewport();
  await expect(page.locator('.next-action')).toContainText('내 결정을 마쳤습니다. 다른 승인자의 결정을 기다리는 중입니다.');
  await expect(page.locator('.next-action')).not.toContainText('승인하거나 사유와 함께 반려하세요');
  await logout(page);

  // 4) 마지막 승인: 커스터디 처리를 시작했다는 안내로 포커스, 상태 변화가 화면 안에 보인다.
  await loginAs(page, '서예린');
  await page.goto(`/requests/${draft.id}`);
  await tick();
  await page.getByRole('button', { name: '승인', exact: true }).click();
  const final = page.getByRole('status').filter({ hasText: '커스터디 처리를 시작했습니다' });
  await expect(final).toBeVisible();
  await expect(final).toContainText('승인했습니다');
  await expect(page.locator('.rc-focus-target').filter({ has: final })).toBeFocused();
  await expect(final).toBeInViewport();
  await expect(page.locator('.page-header .badge')).toBeInViewport();
  await expect(page.getByText('처리 완료').first()).toBeVisible({ timeout: 15_000 });
});

test('주소록 목록: 확인 대기 중인 유사 주소(ab-13)에 \'비슷한 주소 있음\'과 무엇과 비슷한지, 흉내 낸 원래 주소(ab-02)에는 표시 없음', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/addresses');
  await expect(page.getByRole('heading', { name: '주소록 관리', level: 1 })).toBeVisible();
  const look = page.getByRole('row').filter({ has: page.getByRole('link', { name: '정산 파트너 B (Kaia USDC, 변경 안내분)', exact: true }) });
  const genuine = page.getByRole('row').filter({ has: page.getByRole('link', { name: '정산 파트너 B (Kaia USDC)', exact: true }) });
  await expect(look).toHaveCount(1);
  await expect(genuine).toHaveCount(1);
  // 목록의 주소는 앞·뒤 묶음만 보여 두 행이 똑같이 보인다. 표시로 구별한다.
  expect((await look.locator('.addr-code').innerText()).replace(/\s+/g, ' ')).toBe((await genuine.locator('.addr-code').innerText()).replace(/\s+/g, ' '));
  const marker = look.locator('.adr-lookalike');
  await expect(marker).toContainText('비슷한 주소 있음');
  await expect(marker).toContainText("기존 주소 '정산 파트너 B (Kaia USDC)'와 앞 4자·뒤 6자가 같고 가운데가 다릅니다."); // 화면 낭독용 설명
  await expect(marker).toHaveAttribute('title', /정산 파트너 B \(Kaia USDC\)/);
  await expect(genuine.locator('.adr-lookalike')).toHaveCount(0);
  // 상태 배지는 행마다 하나다.
  await expect(look.locator('.badge')).toHaveCount(1);
});

/** 한지수가 등록한 주소를 오민재가 확인해 사용 가능으로 만든다(E2E 서버는 사용 대기 0시간). */
async function usableAddress(page: Page, label: string) {
  const a = await activeAddress(page, label);
  await loginAs(page, '오민재');
  await apiPost(page, `/api/addresses/${a.id}/review`, { decision: 'approve', version: a.version, confirmTail: a.address.slice(-6), confirmMiddle: middleSegment(a.address).text, note: '' });
  await logout(page);
  return a;
}

test('검토로 이동·작성 단계로 되돌리기·내용 수정 저장 뒤: 누른 버튼이 사라진 자리 대신 바뀐 「다음 할 일」로 포커스가 옮겨진다', async ({ page }) => {
  const a = await usableAddress(page, 'E2E 단계 이동 포커스 주소');
  await loginAs(page, '한지수');
  const draft = await apiPost(page, '/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: a.id, amount: '1', purpose: 'E2E 단계 이동 포커스 확인' });
  await page.goto(`/requests/${draft.id}`);
  const next = page.locator('.next-action');
  await expect(next).toContainText('「검토로 이동」을 누르세요');

  await page.getByRole('button', { name: '검토로 이동' }).click();
  await expect(next).toContainText('끝 6자리를 입력해 승인 요청을 보내세요');
  await expect(next).toBeFocused();
  await expect(next).toBeInViewport();

  // 확인 카드 아래의 「작성 단계로 되돌리기」
  await page.getByRole('button', { name: '작성 단계로 되돌리기' }).click();
  await expect(next).toContainText('「검토로 이동」을 누르세요');
  await expect(next).toBeFocused();
  await expect(next).toBeInViewport();

  await page.getByRole('button', { name: '내용 수정' }).click();
  await page.getByRole('textbox', { name: /^요청 목적/ }).fill('E2E 단계 이동 포커스 확인(수정함)');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.locator('.dl')).toContainText('E2E 단계 이동 포커스 확인(수정함)');
  await expect(next).toBeFocused();
  await expect(next).toBeInViewport();
  // 정리: 이 초안은 취소한다.
  const cur = await (await page.request.get(`/api/requests/${draft.id}`)).json();
  await apiPost(page, `/api/requests/${draft.id}/cancel`, { version: cur.version });
});

test('저장된 수량을 읽을 수 없는 초안: 수량은 —, 오류 화면 없이 안내와 할 일, 「검토로 이동」 없음, 「내용 수정」은 빈 수량으로 열리고 다시 입력하면 진행할 수 있다', async ({ page }) => {
  const a = await usableAddress(page, 'E2E 읽을 수 없는 수량 주소');
  await loginAs(page, '한지수');
  const draft = await apiPost(page, '/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: a.id, amount: '2', purpose: 'E2E 읽을 수 없는 수량 초안' });
  // 앱 경로 밖에서 저장된 수량이 정수가 아닌 값(최소 단위 대신 표시 단위로 쓴 실수 등)으로 바뀐다.
  onDb((db) => db.prepare('UPDATE withdrawal_requests SET amount_units = ? WHERE id = ?').run('0.5', draft.id));

  await page.goto(`/requests/${draft.id}`);
  await expect(page.getByRole('heading', { name: `출금 요청 ${draft.refNo}` })).toBeVisible();
  await expect(page.getByText('서버에서 요청을 처리하지 못했습니다')).toHaveCount(0);
  await expect(page.locator('.big-amount')).toHaveText('—');
  await expect(page.getByText('수량을 읽을 수 없어 평가액을 계산하지 않습니다')).toBeVisible();
  await expect(page.getByText(/시세가 없어 지금 평가액을/)).toHaveCount(0);
  await expect(page.locator('.notice-danger').filter({ hasText: '저장된 수량을 읽을 수 없어 이 요청을 진행할 수 없습니다' })).toBeVisible();
  await expect(page.locator('.next-action')).toContainText('「내용 수정」에서 수량을 다시 입력하거나 요청을 취소하세요.');
  await expect(page.getByRole('button', { name: '검토로 이동' })).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

  // 「내용 수정」: 수량 칸은 비어 있고(읽을 수 없는 값을 넣지 않음) 받는 주소는 그대로다.
  await page.getByRole('button', { name: '내용 수정' }).click();
  await expect(page.locator('#amount')).toHaveValue('');
  await expect(page.locator('#addressId')).toHaveValue(a.id);
  await page.locator('#amount').fill('2');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.locator('.big-amount')).toHaveText('2 USDC');
  await expect(page.locator('.next-action')).toContainText('「검토로 이동」을 누르세요');
  await expect(page.locator('.next-action')).toBeFocused();
  await expect(page.getByRole('button', { name: '검토로 이동' })).toBeVisible();
  // 정리: 이 초안은 취소한다.
  const cur = await (await page.request.get(`/api/requests/${draft.id}`)).json();
  await apiPost(page, `/api/requests/${draft.id}/cancel`, { version: cur.version });
});

test('확인 때 0원·소액 입금을 보낸 주소와 같다고 드러난 주소: 확인 버튼 대신 거절 안내, 목록의 위험 표시, 거절 뒤 결과 안내로 포커스', async ({ page }) => {
  const a = await activeAddress(page, 'E2E 소액 입금 주소와 같아진 주소');
  // 등록 뒤에 같은 주소에서 0 USDC 입금이 들어온다(모의 거래 내역).
  onDb((db) => db.prepare(
    "INSERT INTO transactions (id, org_id, wallet_id, type, asset_code, network_code, amount_units, counterparty, status, occurred_at, request_id, tx_ref, counterparty_address) VALUES (?, 'org-a', 'w-a-eth', 'deposit', 'USDC', 'ETHEREUM', '0', '알 수 없는 보낸 주소 (모의)', 'completed', ?, NULL, ?, ?)",
  ).run(`tx-e2e-dust-${a.id}`, new Date().toISOString(), `MOCK-TX-E2E-DUST-${a.id.slice(0, 8)}`, a.address));

  await loginAs(page, '오민재');
  await page.goto(`/addresses/${a.id}`);
  await page.getByLabel('원본 주소의 끝 6자리').fill(a.address.slice(-6));
  await page.getByLabel(/원본 주소의 가운데 8자리/).fill(middleSegment(a.address).text);
  await page.getByRole('button', { name: /사용 가능으로 확인/ }).click();
  // 서버가 거부하고 찾은 결과를 저장한다. 다시 불러온 화면에서 확인 버튼이 사라지므로 거부 안내로 포커스가 옮겨진다.
  const refused = page.getByRole('alert').filter({ hasText: '최근 0원·소액 입금을 보낸 주소와 같습니다' });
  await expect(refused).toContainText('이 등록은 확인하지 말고 사유와 함께 거절하세요');
  await expect(page.locator('.rc-focus-target').filter({ has: refused })).toBeFocused();
  await expect(refused).toBeInViewport();
  await expect(page.getByRole('button', { name: /사용 가능으로 확인/ })).toHaveCount(0);
  await expect(page.getByLabel('원본 주소의 끝 6자리')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '등록 거절' })).toBeVisible();

  // 다음 확인 담당자가 새로 열어도 같다: 확인 버튼 없이 점검 결과와 할 일(거절)이 보인다.
  await page.reload();
  const card = page.locator('section.card-action');
  await expect(card.locator('.notice-danger').filter({ hasText: '최근 0원·소액 입금을 보낸 주소와 같습니다' })).toBeVisible();
  await expect(card).toContainText('최근 0원·소액 입금을 보낸 주소와 같아 이 주소는 확인할 수 없습니다. 거절 사유를 적고 「등록 거절」을 누르세요.');
  await expect(page.getByRole('button', { name: /사용 가능으로 확인/ })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /^거절 사유/ })).toBeVisible();

  // 목록: 이 행에 위험 표시와 설명이 붙는다(유사 주소 표시보다 강한 신호). 상태 배지는 하나다.
  await page.goto('/addresses');
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: 'E2E 소액 입금 주소와 같아진 주소', exact: true }) });
  const marker = row.locator('.adr-poison');
  await expect(marker).toContainText('0원·소액 입금 주소와 같음');
  await expect(marker).toContainText('최근 0원·소액 입금을 보낸 주소와 같습니다. 주소 오염 공격에서 자주 보이는 패턴이라 이 주소는 확인할 수 없습니다.');
  await expect(row.locator('.badge')).toHaveCount(1);

  // 거절: 확인 카드(누른 버튼)가 사라지므로 결과 안내로 포커스가 옮겨진다.
  await row.getByRole('link').click();
  await page.getByRole('textbox', { name: /^거절 사유/ }).fill('최근 0원 입금을 보낸 주소와 같아 등록을 거절합니다');
  await page.getByRole('button', { name: '등록 거절' }).click();
  const rejected = page.getByRole('status').filter({ hasText: '등록을 거절했습니다' });
  await expect(rejected).toBeVisible();
  await expect(page.locator('.rc-focus-target').filter({ has: rejected })).toBeFocused();
  await expect(rejected).toBeInViewport();
  await expect(page.getByRole('heading', { name: '주소 확인', exact: true })).toHaveCount(0);
});
