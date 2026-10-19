import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, logout } from './helpers.ts';
import { middleSegment } from '../shared/address-rules.ts';

// 결과·오류 안내와 포커스(G2 후속): 처리 결과가 누른 자리에서 보이고, 받는 주소를 쓸 수 없을 때 무엇을 해야 하는지 알린다.
// - 작성 중 요청의 받는 주소가 사용 중지되면 요청자 안내·다음 할 일·주소 상태 배지(「검토로 이동」은 내놓지 않음), 화면을 연 사이 중지되면 거부 안내로 포커스
// - 주소 확인 뒤 결과 안내로 포커스, 승인(1/2·마지막) 뒤 결과 안내로 포커스와 다음 할 일
// - 주소록 목록에서 유사 주소(ab-13)에 '비슷한 주소 있음' 표시, 흉내 낸 원래 주소(ab-02)에는 없음
// 바꾸는 데이터: 이 파일에서 만든 주소 3건과 그 주소로 가는 요청 3건뿐이다(다른 검사가 쓰는 시드 주소·요청은 읽기만 한다).
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
