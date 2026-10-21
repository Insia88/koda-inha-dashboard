import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, logout, onDb } from './helpers.ts';
import { middleSegment } from '../shared/address-rules.ts';

// A2(서버 읽기 모델과 그 화면): 승인할 수 있는 사람과 대기 시간(A2-1), 결정 카드의 받는 주소 기록(A2-2),
// 결정 근거(A2-3), 감사 기록 CSV 표지(A2-4). 정족수·자기 승인 금지·건별 승인·지문·주소 재입력은 그대로다.
// 바꾸는 데이터: 이 파일에서 만든 KAIA 주소 1건과 그 주소로 가는 요청 1건(끝에 취소), 모의법인 B의 요청 1건(끝에 취소)과
// 임하은의 역할(뺐다가 되돌림)뿐이다. 시드 주소·요청은 읽기만 한다(ab-08은 뒤의 display.spec.ts가 확인 대기 상태로 쓰므로 바꾸지 않는다).
// 다른 검사의 출금 전 점검(같은 자산 최근 요청 수)에 영향을 주지 않도록 새 요청은 KAIA·모의법인 B로 만든다.

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const mockEvm = () => `MOCK-EVM-${randomBytes(20).toString('hex').toUpperCase()}`;

async function send(page: Page, method: 'POST' | 'PUT', url: string, body: unknown) {
  const me = await (await page.request.get('/api/me')).json();
  const headers = { 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` };
  const res = method === 'POST' ? await page.request.post(url, { data: body, headers }) : await page.request.put(url, { data: body, headers });
  const json = await res.json();
  expect(res.ok(), `${url} ${JSON.stringify(json)}`).toBeTruthy();
  return json;
}
const apiPost = (page: Page, url: string, body: unknown) => send(page, 'POST', url, body);

async function axe(page: Page) {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

/** 초안 → 검토 → 승인 요청(사유가 필요한 점검 항목에는 사유를 넣는다). 지금 로그인한 사람이 요청자다. */
async function submitRequest(page: Page, body: Record<string, unknown>) {
  const draft = await apiPost(page, '/api/requests', body);
  const addr = await (await page.request.get(`/api/addresses/${body.addressId}`)).json();
  const rv = await apiPost(page, `/api/requests/${draft.id}/review`, { version: draft.version });
  const checkReasons = Object.fromEntries((rv.checks?.items ?? []).filter((x: any) => x.requiresReason).map((x: any) => [x.id, 'E2E 거래처 재무팀과 등록된 번호로 통화해 확인했습니다']));
  return apiPost(page, `/api/requests/${draft.id}/submit`, { version: rv.version, confirmTail: String(addr.address).slice(-6), ackIrreversible: true, checkReasons });
}

test.describe('승인할 수 있는 사람과 대기 시간(A2-1)', () => {
  for (const width of [1440, 390]) {
    test(`${width}px: 홈 진행 중 요청 둘째 줄 맨 앞 '다른 사람 차례 … · n시간째', 수량은 첫 줄, 요청 상세 다음 할 일에 이름·남은 승인·대기 시간, axe`, async ({ page }) => {
      await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
      await loginAs(page, '한지수');
      const wr3 = page.locator('a.progress-item', { hasText: 'WR-000003' });
      await expect(wr3.locator('.turn-text')).toHaveText(/^다른 사람 차례: 강도윤·서예린·오민재 · \d+시간째$/);
      // 둘째 줄 맨 앞(누구 차례·대기 시간) 다음에 요청자 → 받는 곳. 지연 색이나 기준 시간은 없다.
      await expect(wr3.locator('.progress-meta')).toContainText(/^다른 사람 차례: 강도윤·서예린·오민재 · \d+시간째 · 한지수 → 정산 파트너 B/);
      const t = wr3.locator('.turn-text time');
      await expect(t).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      await expect(t).toHaveAttribute('title', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} KST$/);
      await expect(page.locator('a.progress-item', { hasText: 'WR-000004' }).locator('.turn-text')).toHaveText(/^다른 사람 차례: 서예린·오민재 · \d+시간째$/);
      // 검토 중 요청은 A1 차례 문구 그대로
      await expect(page.locator('a.progress-item', { hasText: 'WR-000005' }).locator('.turn-text')).toHaveText('요청자 최종 확인 중');
      for (const ref of ['WR-000003', 'WR-000004']) {
        const row = page.locator('a.progress-item', { hasText: ref });
        const pos = await row.evaluate((el) => {
          const mid = (s: string) => { const b = el.querySelector(s)!.getBoundingClientRect(); return { y: Math.round((b.top + b.bottom) / 2), top: Math.round(b.top) }; };
          const meta = el.querySelector('.progress-meta')!;
          return { ref: mid('.ref'), amt: mid('.progress-amt'), turn: mid('.progress-meta .turn-text'), first: meta.firstElementChild?.className ?? '', metaTop: Math.round(meta.getBoundingClientRect().top) };
        });
        expect(Math.abs(pos.ref.y - pos.amt.y), `${ref} 수량은 번호와 같은 줄`).toBeLessThanOrEqual(4);
        expect(pos.first, `${ref} 둘째 줄 맨 앞`).toContain('turn-text');
        expect(pos.turn.top, `${ref} 누구 차례는 둘째 줄`).toBeGreaterThan(pos.amt.y);
        expect(pos.turn.top - pos.metaTop, `${ref} 둘째 줄 맨 앞`).toBeLessThanOrEqual(2);
      }
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await axe(page);

      await page.goto('/requests/wr-3');
      const next = page.locator('section.next-action');
      await expect(next.locator('p').first()).toHaveText('승인자의 결정을 기다리는 중입니다. 알림이 가지 않으니 승인자에게 직접 알려 주세요. 요청을 취소할 수도 있습니다.');
      await expect(next.locator('.next-wait')).toHaveText(/^승인할 수 있는 사람: 강도윤 · 서예린 · 오민재 \(남은 승인 2명\) · 승인 요청 \d+시간째$/);
      await expect(next.locator('.next-wait time')).toHaveAttribute('title', /KST$/);
      await expect(next.getByRole('link', { name: '「조직 관리」' })).toBeVisible();
      await expect(page.getByText('조직 관리자에게 승인자 추가를 요청하세요')).toHaveCount(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await axe(page);
    });
  }

  test("후보인 승인자에게는 '나'가 맨 앞이고, 홈의 '내 승인 차례' 배지는 그대로", async ({ page }) => {
    await loginAs(page, '오민재');
    await page.goto('/requests/wr-3');
    await expect(page.locator('.next-wait')).toHaveText(/^승인할 수 있는 사람: 나 · 강도윤 · 서예린 \(남은 승인 2명\) · 승인 요청 \d+시간째$/);
    await page.goto('/');
    const wr3 = page.locator('a.progress-item', { hasText: 'WR-000003' });
    await expect(wr3.locator('.turn-text')).toHaveText(/^승인할 수 있는 사람: 나·강도윤·서예린 · \d+시간째$/);
    await expect(wr3.locator('.badge-turn')).toHaveText('내 승인 차례');
  });

  test('남은 승인을 채울 사람이 없으면 경고, 승인할 수 없는 요청에는 이름 줄 없음(모의법인 B, 임하은 역할을 뺐다가 되돌림)', async ({ page }) => {
    await loginAs(page, '배서준');
    const sent = await submitRequest(page, { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-b1', amount: '1', purpose: 'E2E A2 승인 후보 부족 확인' });
    expect(sent.status).toBe('PENDING_APPROVAL');
    try {
      await page.goto(`/requests/${sent.id}`);
      await expect(page.locator('.next-wait')).toHaveText(/^승인할 수 있는 사람: 임하은 \(남은 승인 1명\) · 승인 요청 \d+분째$/);
      await logout(page);

      await loginAs(page, '조은비');
      const lim = (await (await page.request.get('/api/org/members')).json()).find((m: any) => m.id === 'u-b-lim');
      const removed = await send(page, 'PUT', '/api/org/members/u-b-lim/roles', { roles: [], rolesVersion: lim.rolesVersion });
      try {
        await page.goto(`/requests/${sent.id}`);
        await expect(page.locator('.next-wait')).toHaveText(/^승인할 수 있는 사람: 없음 \(남은 승인 1명\) · 승인 요청 \d+분째$/);
        const warn = page.locator('.notice-warning', { hasText: '지금 승인할 수 있는 사람이 없습니다. 조직 관리자에게 승인자 추가를 요청하세요.' });
        await expect(warn).toHaveCount(1);
        // 경고는 다음 할 일 바로 뒤에 있다
        expect(await page.locator('section.next-action').evaluate((el) => el.nextElementSibling?.className ?? '')).toContain('notice-warning');
        await axe(page);
        await page.goto('/');
        await expect(page.locator('a.progress-item', { hasText: sent.refNo }).locator('.turn-text')).toHaveText(/^승인할 수 있는 사람 없음 · \d+분째$/);
      } finally {
        await send(page, 'PUT', '/api/org/members/u-b-lim/roles', { roles: ['approver'], rolesVersion: removed.rolesVersion });
      }
      await logout(page);

      // 승인할 수 없는 요청(승인 요청 뒤 저장 계층에서 수량이 바뀜, INTENT_TAMPERED)에는 이름 줄이 없고, 홈은 A1 차례 문구를 쓴다.
      onDb((db) => db.prepare("UPDATE withdrawal_requests SET amount_units = '0.5' WHERE id = ?").run(sent.id));
      await loginAs(page, '배서준');
      await page.goto(`/requests/${sent.id}`);
      await expect(page.getByText('승인 요청 뒤 요청 내용이 바뀌어 이 요청은 승인될 수 없습니다')).toBeVisible();
      await expect(page.locator('.next-wait')).toHaveCount(0);
      await page.goto('/');
      await expect(page.locator('a.progress-item', { hasText: sent.refNo }).locator('.turn-text')).toHaveText('승인자 결정 대기');
      await logout(page);
    } finally {
      await page.context().clearCookies();
      await loginAs(page, '배서준');
      const cur = await (await page.request.get(`/api/requests/${sent.id}`)).json();
      await apiPost(page, `/api/requests/${sent.id}/cancel`, { version: cur.version });
    }
  });
});

test.describe('결정 카드의 받는 주소 기록(A2-2)', () => {
  test('등록자·받은 경로 → 다시 확인한 경로 / 확인자·지금 상태, 등록자가 남긴 연락처는 옮기지 않음, 390px·axe', async ({ page }) => {
    // 한지수가 문서로 받은 주소를 미리 등록된 연락처로 다시 확인했다고 남기고 등록 → 서예린이 확인(E2E는 사용 대기 0시간) → 한지수가 요청
    const address = mockEvm();
    const verifiedWith = 'E2E 거래처 M 재무팀 대표번호(거래처 등록 연락처)';
    await loginAs(page, '한지수');
    const { address: created } = await apiPost(page, '/api/addresses', {
      label: 'E2E A2 주소 기록 확인용', counterparty: '모의 거래처 M', assetCode: 'KAIA', networkCode: 'KAIA', address, memo: '',
      confirmTail: address.slice(-6), confirmMiddle: middleSegment(address).text, ackNotVerified: true, ackOutOfBandConfirmed: true,
      receivedVia: 'document', verifiedVia: 'registered_phone', verifiedWith,
    });
    await logout(page);
    await loginAs(page, '서예린');
    await apiPost(page, `/api/addresses/${created.id}/review`, { decision: 'approve', version: created.version, confirmTail: address.slice(-6), confirmMiddle: middleSegment(address).text, note: '' });
    await logout(page);
    await loginAs(page, '한지수');
    const sent = await submitRequest(page, { assetCode: 'KAIA', networkCode: 'KAIA', addressId: created.id, amount: '10', purpose: 'E2E A2 주소 기록 확인' });
    await logout(page);
    try {
      await loginAs(page, '강도윤');
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
        await page.goto(`/requests/${sent.id}`);
        const card = page.locator('section.card-action');
        const lines = card.locator('.rc-addr-record .rc-addr-line');
        await expect(lines).toHaveText([
          /^등록 한지수 \d{4}-\d{2}-\d{2} · 받은 경로 문서\(공문·인보이스\) → 다시 확인한 경로 미리 등록된 연락처로 전화$/,
          /^확인 서예린 \d{4}-\d{2}-\d{2} · 지금 상태 사용 가능 \(사람이 남긴 기록이며 증명이 아닙니다\) · 주소 기록 보기$/,
        ]);
        await expect(card.locator('.rc-addr-record').getByRole('link', { name: '주소 기록 보기' })).toHaveAttribute('href', `/addresses/${created.id}`);
        // 등록자가 남긴 '확인한 상대·연락처'(자유 서술)는 카드 어디에도 없다(주소 기록 링크로만)
        await expect(card).not.toContainText('재무팀 대표번호');
        await expect(page.getByText(verifiedWith)).toHaveCount(0);
        // 순서: 요약 → 주소 기록 → 지문
        const order = await card.evaluate((el) => ['.rc-decide-summary', '.rc-addr-record', '.rc-intent'].map((s) => [...el.querySelectorAll('*')].indexOf(el.querySelector(s)!)));
        expect(order.every((p) => p >= 0)).toBe(true);
        expect([...order].sort((x, y) => x - y)).toEqual(order);
        expect(await overflow(page)).toBeLessThanOrEqual(0);
        await axe(page);
      }
      // 사용 대기를 거친 주소면 사용 가능해진 시각, 등록 때 비슷한 주소 경고가 있었으면 그 사실만(사유는 주소 기록에서). 저장 계층에서 값을 넣어 흉내 낸다.
      onDb((db) => db.prepare("UPDATE address_book SET active_from = '2026-10-01T00:30:00.000Z', lookalike_reason = 'E2E 비슷한 주소 등록 사유 문장' WHERE id = ?").run(created.id));
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
      const card = page.locator('section.card-action');
      await expect(card.locator('.rc-addr-line').nth(1)).toHaveText(/^확인 서예린 \d{4}-\d{2}-\d{2} · 지금 상태 사용 가능 \(2026-10-01 09:30부터\) \(사람이 남긴 기록이며 증명이 아닙니다\) · 주소 기록 보기$/);
      await expect(card.locator('.rc-addr-warn')).toHaveText('등록 때 비슷한 주소 경고가 있었습니다 — 등록 사유는 주소 기록에서 확인하세요');
      await expect(card).not.toContainText('E2E 비슷한 주소 등록 사유 문장');
    } finally {
      await page.context().clearCookies();
      await loginAs(page, '한지수');
      const cur = await (await page.request.get(`/api/requests/${sent.id}`)).json();
      await apiPost(page, `/api/requests/${sent.id}/cancel`, { version: cur.version });
    }
  });

  for (const mode of ['403', '404', 'network'] as const) {
    test(`주소 조회 실패(${mode})면 링크만 보이고 지문·점검·확인·버튼은 그대로`, async ({ page }) => {
      await loginAs(page, '오민재');
      await page.route('**/api/addresses/ab-03', (route) => (mode === 'network'
        ? route.abort('failed')
        : route.fulfill({ status: Number(mode), contentType: 'application/json', body: JSON.stringify({ error: { code: mode === '403' ? 'FORBIDDEN' : 'NOT_FOUND', message: '테스트', action: '테스트' } }) })));
      await page.goto('/requests/wr-4');
      const card = page.locator('section.card-action');
      await expect(card.locator('.rc-intent-value')).toBeVisible();
      const rec = card.locator('.rc-addr-record');
      await expect(rec).toHaveText('주소 기록 보기');
      await expect(rec.getByRole('link', { name: '주소 기록 보기' })).toHaveAttribute('href', '/addresses/ab-03');
      await expect(card.locator('.rc-list').first()).toBeVisible();
      const approve = card.getByRole('button', { name: /^승인(하고 처리 시작)?$/ });
      await expect(approve).toBeDisabled();
      for (const box of await card.locator('fieldset.checks input[type="checkbox"]').all()) await box.check();
      await expect(approve).toBeEnabled();
      await expect(card.getByRole('button', { name: '반려', exact: true })).toBeEnabled();
    });
  }
});

test.describe('결정 근거(A2-3)', () => {
  test('처리 기록의 승인 줄 아래: 감사 담당자·조직 관리자는 결정 당시 역할까지, 요청자는 정족수·지문만, 390px·axe', async ({ page }) => {
    for (const user of ['문태호', '윤가람']) {
      await loginAs(page, user);
      const dto = await (await page.request.get('/api/requests/wr-1')).json();
      await page.goto('/requests/wr-1');
      const row = page.locator('.timeline li', { hasText: 'WR-000001 승인 (1/1)' });
      await expect(row.locator('.evidence')).toHaveText(`결정 당시 역할: 승인자(역할 변경 기록 기준) · 정족수 포함 · 결정한 지문 ${dto.intentHashDisplay}(요청 지문과 같음)`);
      await expect(row.locator('.evidence-danger, .evidence-warn')).toHaveCount(0);
      // 결정이 아닌 줄에는 근거가 없다
      await expect(page.locator('.timeline li', { hasText: '승인 요청' }).locator('.evidence')).toHaveCount(0);
      await logout(page);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, '한지수');
    const dto = await (await page.request.get('/api/requests/wr-1')).json();
    await page.goto('/requests/wr-1');
    const row = page.locator('.timeline li', { hasText: 'WR-000001 승인 (1/1)' });
    await expect(row.locator('.evidence')).toHaveText(`정족수 포함 · 결정한 지문 ${dto.intentHashDisplay}(요청 지문과 같음)`);
    await expect(page.getByText('결정 당시 역할')).toHaveCount(0);
    // 반려 줄(wr-2)
    await page.goto('/requests/wr-2');
    await expect(page.locator('.timeline li', { hasText: 'WR-000002 반려' }).locator('.evidence')).toHaveText(/^결정한 지문 [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}\(요청 지문과 같음\)$/);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await axe(page);
  });

  test('감사 기록 화면: 승인·반려 행의 내용 칸 아래에 같은 근거, 다른 행에는 없음, 390px·axe', async ({ page }) => {
    await loginAs(page, '문태호');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
      await page.goto('/audit?action=request.approved');
      const cell = page.locator('.aud-summary', { hasText: 'WR-000001 승인 (1/1)' });
      await expect(cell.locator('.evidence')).toContainText(/^결정 당시 역할: 승인자\(역할 변경 기록 기준\) · 정족수 포함 · 결정한 지문 [0-9A-F ]{19}\(요청 지문과 같음\)$/);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await axe(page);
    }
    await page.goto('/audit?action=request.submitted');
    await expect(page.locator('.aud-summary').first()).toBeVisible();
    await expect(page.locator('.aud-summary .evidence')).toHaveCount(0);
  });
});

test.describe('감사 기록 CSV 표지(A2-4)', () => {
  test('내보내기 권한자에게만 표지 안내 한 줄, 내려받은 파일 맨 위에 표지와 빈 줄 뒤 머리글', async ({ page }) => {
    await loginAs(page, '문태호');
    await page.goto('/audit');
    await expect(page.getByText('내보낸 파일 맨 위에 기간·조건·내보낸 사람·시각·해시 연결 확인 결과를 담은 표지가 붙습니다.')).toBeVisible();
    const verify = await (await page.request.get('/api/audit/verify')).json();
    const res = await page.request.get('/api/audit/export.csv?action=request.approved');
    expect(res.ok()).toBeTruthy();
    const body = await res.text();
    const lines = body.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('KODA 감사 기록 내보내기 표지 — 내보낼 때 만든 설명이며 감사 기록이 아닙니다(해시 대상 아님)');
    expect(lines).toContain('조건,행동: 승인(request.approved)');
    expect(lines).toContain('내보낸 사람,문태호 (감사 담당자)');
    expect(lines).toContain(`보관용 값,기록 ${verify.count}건 · 마지막 기록 해시 ${verify.headHash}`);
    const blank = lines.indexOf('');
    expect(lines[blank + 1]).toBe('순번,시각(한국 시간),수행자,행동,행동 코드,대상 종류,대상 ID,내용,결정 근거(내보낼 때 계산),해시');
    expect(String(res.headers()['content-disposition'])).toMatch(/^attachment; filename="koda-audit-\d{4}-\d{2}-\d{2}\.csv"$/);
    await logout(page);
    // 조직 관리자: A1 안내('내보내기 권한 없음')만 보이고 표지 안내는 없다
    await loginAs(page, '윤가람');
    await page.goto('/audit');
    await expect(page.getByText('이 역할에는 CSV 내보내기 권한이 없습니다. 감사 증빙 파일이 필요하면 감사 담당자에게 요청하세요.')).toBeVisible();
    await expect(page.getByText('표지가 붙습니다')).toHaveCount(0);
  });
});
