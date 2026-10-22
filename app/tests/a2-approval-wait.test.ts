// A2-1: 승인할 수 있는 사람(이름)과 승인 요청 뒤 대기 시간. 요청 상세 approvalWait, 홈 진행 중 요청 submittedAt·waitingFor.
// 후보: 같은 조직 활성 사용자 중 지금 역할에 출금 승인 권한이 있는 사람. 작성자·이미 결정한 사람 제외, 이름순, id·이름만.
// 정족수·자기 승인 금지·건별 승인(A-34)은 그대로이고, 제출 때 승인 가능 인원 검사(APPROVERS_INSUFFICIENT)와 같은 판정을 쓴다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, key, login, makeApp, type TestCtx } from './helpers.ts';
import { approverNames, approvalShortfallText } from '../shared/terms.ts';
import { waited } from '../src/format.ts';

let ctx: TestCtx;
beforeEach(async () => { ctx = await makeApp(); });
afterEach(async () => { await ctx.app.close(); ctx.db.close(); });

const tail = (addr: string) => addr.slice(-6);
const names = (w: { candidates: { name: string }[] } | null) => w?.candidates.map((c) => c.name);
const as = async (userId: string) => api(ctx.app, await login(ctx.app, userId));

/** 초안 → 검토 → 승인 요청. 처음 보내는 주소는 진행 사유가 필요하다(WP-11). */
async function submitNew(userId: string, body: Record<string, unknown>) {
  const a = await as(userId);
  const cr = await a.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '100', purpose: 'A2-1 승인 후보 테스트', ...body }, { 'idempotency-key': key() });
  expect(cr.status, JSON.stringify(cr.body)).toBe(201);
  const rv = await a.post(`/api/requests/${cr.body.id}/review`, { version: cr.body.version });
  expect(rv.status, JSON.stringify(rv.body)).toBe(200);
  return a.post(`/api/requests/${cr.body.id}/submit`, { version: rv.body.version, confirmTail: tail(cr.body.address.address), ackIrreversible: true, checkReasons: { first_use: '거래처와 등록된 번호로 통화해 주소를 대조했습니다' } });
}

describe('요청 상세 approvalWait', () => {
  it('lists who can approve wr-3 by name (requester view): 강도윤, 서예린, 오민재 · 남은 승인 2명 · id·name만', async () => {
    const han = await as('u-a-han');
    const res = await han.get('/api/requests/wr-3');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.approvalWait).toEqual({
      candidates: [{ id: 'u-a-kang', name: '강도윤' }, { id: 'u-a-seo', name: '서예린' }, { id: 'u-a-oh', name: '오민재' }],
      remaining: 2, shortfall: false,
    });
    for (const c of res.body.approvalWait.candidates) expect(Object.keys(c).sort()).toEqual(['id', 'name']);
    // 대기 시작 시각은 기존 submittedAt이다
    expect(res.body.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 목록 응답에는 없다(null)
    const list = await han.get('/api/requests?pageSize=50');
    expect(list.body.items.find((x: any) => x.id === 'wr-3').approvalWait).toBeNull();
  });

  it('drops the approver once they decide, and never lists the creator (wr-3 after 오민재 approves, wr-4 by 강도윤)', async () => {
    const oh = await as('u-a-oh');
    const cur = (await oh.get('/api/requests/wr-3')).body;
    const ap = await oh.post('/api/requests/wr-3/approve', { version: cur.version, intentHash: cur.intentHash });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    // 행동 응답에도 있다
    expect(names(ap.body.approvalWait)).toEqual(['강도윤', '서예린']);
    expect(ap.body.approvalWait.remaining).toBe(1);
    const han = await as('u-a-han');
    expect((await han.get('/api/requests/wr-3')).body.approvalWait).toMatchObject({ remaining: 1, shortfall: false });
    // wr-4는 강도윤이 작성: 강도윤은 승인자 역할이 있어도 후보가 아니다
    const wr4 = (await han.get('/api/requests/wr-4')).body.approvalWait;
    expect(names(wr4)).toEqual(['서예린', '오민재']);
    expect(wr4.candidates.some((c: any) => c.id === 'u-a-kang')).toBe(false);
    // 반려한 사람도 뺀다(이미 결정)
    const seo = await as('u-a-seo');
    const c4 = (await seo.get('/api/requests/wr-4')).body;
    expect((await seo.post('/api/requests/wr-4/reject', { version: c4.version, reason: '근거 문서 확인 전이라 반려합니다', intentHash: c4.intentHash })).status).toBe(200);
    expect((await han.get('/api/requests/wr-4')).body.approvalWait).toBeNull(); // 반려로 끝남
  });

  it('counts only approvals that still count toward the required number: an approver who lost the role after approving leaves remaining at 2 and is not listed again', async () => {
    const oh = await as('u-a-oh');
    const cur = (await oh.get('/api/requests/wr-3')).body;
    expect((await oh.post('/api/requests/wr-3/approve', { version: cur.version, intentHash: cur.intentHash })).status).toBe(200);
    const han = await as('u-a-han');
    expect((await han.get('/api/requests/wr-3')).body.approvalWait).toMatchObject({ remaining: 1 });
    // 승인한 뒤 역할을 빼면 그 표는 필요 승인 수에서 빠진다(remaining은 승인 표 전체 수가 아니라 정족수에 든 표로 센다).
    const admin = await as('u-a-yoon');
    expect((await admin.put('/api/org/members/u-a-oh/roles', { roles: [], rolesVersion: 1 })).status).toBe(200);
    const after = (await han.get('/api/requests/wr-3')).body;
    expect(after.approvals).toHaveLength(1);
    expect(after.approvals[0]).toMatchObject({ userId: 'u-a-oh', decision: 'approved', counted: false });
    // 이미 결정했으므로 후보에도 다시 들어가지 않는다
    expect(after.approvalWait).toEqual({ candidates: [{ id: 'u-a-kang', name: '강도윤' }, { id: 'u-a-seo', name: '서예린' }], remaining: 2, shortfall: false });
    // 홈도 같은 판정(정족수에 든 승인 0/2, 후보 2명)
    const row = (await han.get('/api/dashboard')).body.inProgress.find((x: any) => x.id === 'wr-3');
    expect(row).toMatchObject({ approved: 0, requiredApprovals: 2 });
    expect(row.waitingFor).toEqual(after.approvalWait.candidates);
  });

  it('follows role changes and deactivation, and warns (shortfall) when too few people are left', async () => {
    const admin = await as('u-a-yoon');
    const han = await as('u-a-han');
    // 서예린의 승인자 역할을 빼면 다음 조회부터 빠진다
    expect((await admin.put('/api/org/members/u-a-seo/roles', { roles: [], rolesVersion: 1 })).status).toBe(200);
    let w = (await han.get('/api/requests/wr-3')).body.approvalWait;
    expect(names(w)).toEqual(['강도윤', '오민재']);
    expect(w).toMatchObject({ remaining: 2, shortfall: false });
    // 비활성 사용자도 빠진다. 남은 후보(1명)가 남은 승인(2명)보다 적으면 shortfall
    ctx.db.prepare("UPDATE users SET is_active = 0 WHERE id = 'u-a-kang'").run();
    w = (await han.get('/api/requests/wr-3')).body.approvalWait;
    expect(names(w)).toEqual(['오민재']);
    expect(w).toMatchObject({ remaining: 2, shortfall: true });
    expect(approvalShortfallText(w.remaining, w.candidates.length)).toBe('남은 승인 2명을 채울 수 있는 사람이 1명뿐입니다. 조직 관리자에게 승인자 추가를 요청하세요.');
    // 화면에 보인 후보 수와 제출 때의 승인 가능 인원 검사가 같은 판정이다: 같은 상태에서 2명이 필요한 요청은 제출이 거부된다.
    ctx.db.prepare("DELETE FROM prices WHERE asset_code = 'USDC'").run(); // 시세 없음 → 고액 기준 2명(A-03)
    const sub = await submitNew('u-a-han', { amount: '10' });
    expect(sub.status).toBe(422);
    expect(sub.body.error).toMatchObject({ code: 'APPROVERS_INSUFFICIENT', eligibleApprovers: w.candidates.length, requiredApprovals: 2 });
  });

  it('is null when the request is not waiting for approval or cannot be approved (INTENT_TAMPERED, ADDRESS_NOT_ACTIVE)', async () => {
    const han = await as('u-a-han');
    for (const id of ['wr-1', 'wr-2', 'wr-5', 'wr-6']) expect((await han.get(`/api/requests/${id}`)).body.approvalWait, id).toBeNull();
    // 승인 요청 뒤 저장 계층에서 수량이 바뀜 → INTENT_TAMPERED
    ctx.db.prepare("UPDATE withdrawal_requests SET amount_units = '0.5' WHERE id = 'wr-4'").run();
    const wr4 = (await han.get('/api/requests/wr-4')).body;
    expect(wr4.blockedReason).toBe('INTENT_TAMPERED');
    expect(wr4.approvalWait).toBeNull();
    // 받는 주소 사용 중지 → ADDRESS_NOT_ACTIVE
    const admin = await as('u-a-yoon');
    const ab02 = (await admin.get('/api/addresses/ab-02')).body;
    expect((await admin.post('/api/addresses/ab-02/disable', { version: ab02.version })).status).toBe(200);
    const wr3 = (await han.get('/api/requests/wr-3')).body;
    expect(wr3.blockedReason).toBe('ADDRESS_NOT_ACTIVE');
    expect(wr3.approvalWait).toBeNull();
    // 홈도 200이고 두 요청 모두 waitingFor가 null이다(request-integrity의 수량 null 회귀와 같은 조건)
    const dash = await han.get('/api/dashboard');
    expect(dash.status).toBe(200);
    for (const id of ['wr-3', 'wr-4']) expect(dash.body.inProgress.find((x: any) => x.id === id).waitingFor, id).toBeNull();
    expect(dash.body.inProgress.find((x: any) => x.id === 'wr-4').amount).toBeNull();
  });

  it('keeps org isolation: org B gets 404 for wr-3, and a B request lists only B members (임하은)', async () => {
    const lim = await as('u-b-lim');
    expect((await lim.get('/api/requests/wr-3')).status).toBe(404);
    const sub = await submitNew('u-b-bae', { addressId: 'ab-b1', amount: '100' });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.approvalWait).toEqual({ candidates: [{ id: 'u-b-lim', name: '임하은' }], remaining: 1, shortfall: false });
    // 모의법인 A 사람은 B 요청을 볼 수 없다
    expect((await (await as('u-a-oh')).get(`/api/requests/${sub.body.id}`)).status).toBe(404);
    // B 홈에도 B 구성원만
    const dash = await lim.get('/api/dashboard');
    expect(dash.body.inProgress.find((x: any) => x.id === sub.body.id).waitingFor).toEqual([{ id: 'u-b-lim', name: '임하은' }]);
    expect(JSON.stringify(dash.body)).not.toMatch(/강도윤|서예린|오민재/);
  });

  it('refuses people without request.read (KODA operator) with 403 and keeps the approve rules unchanged', async () => {
    const op = await as('u-k-op');
    expect((await op.get('/api/requests/wr-3')).status).toBe(403);
    expect((await op.get('/api/dashboard')).status).toBe(403);
    // 후보로 보였다고 승인 규칙이 바뀌지 않는다: 작성자(강도윤)는 wr-4를 여전히 승인할 수 없다
    const kang = await as('u-a-kang');
    const c4 = (await kang.get('/api/requests/wr-4')).body;
    expect(c4.allowedActions).not.toContain('approve');
    const self = await kang.post('/api/requests/wr-4/approve', { version: c4.version, intentHash: c4.intentHash });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
  });
});

describe('홈 진행 중 요청 submittedAt·waitingFor', () => {
  it('gives wr-3 and wr-4 the submit time and the same names for the requester and the auditor, with no-store', async () => {
    for (const user of ['u-a-han', 'u-a-moon']) {
      const res = await (await as(user)).get('/api/dashboard');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const row = (id: string) => res.body.inProgress.find((x: any) => x.id === id);
      expect(row('wr-3').submittedAt, user).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(row('wr-3').waitingFor.map((c: any) => c.name), user).toEqual(['강도윤', '서예린', '오민재']);
      expect(row('wr-4').waitingFor.map((c: any) => c.name), user).toEqual(['서예린', '오민재']);
      for (const c of row('wr-3').waitingFor) expect(Object.keys(c).sort()).toEqual(['id', 'name']);
      // 승인 대기가 아니면 null(검토 중 wr-5)
      expect(row('wr-5').waitingFor).toBeNull();
      expect(row('wr-5').submittedAt).toBeNull();
    }
    // 홈과 요청 상세가 같은 판정이다
    const han = await as('u-a-han');
    const dash = (await han.get('/api/dashboard')).body;
    for (const id of ['wr-3', 'wr-4']) {
      expect(dash.inProgress.find((x: any) => x.id === id).waitingFor).toEqual((await han.get(`/api/requests/${id}`)).body.approvalWait.candidates);
    }
  });
});

describe('표시 함수', () => {
  it("writes '나' first for the viewer and shortens past the limit", () => {
    const c = [{ id: 'a', name: '강도윤' }, { id: 'b', name: '서예린' }, { id: 'c', name: '오민재' }, { id: 'd', name: '윤가람' }];
    expect(approverNames(c, 'zz', ' · ')).toBe('강도윤 · 서예린 · 오민재 · 윤가람');
    expect(approverNames(c, 'c', '·', 3)).toBe('나·강도윤·서예린 외 1명');
    expect(approverNames(c.slice(1, 3), 'c', '·', 3)).toBe('나·서예린');
    expect(approverNames([], 'c', '·', 3)).toBe('');
    expect(approvalShortfallText(1, 0)).toBe('지금 승인할 수 있는 사람이 없습니다. 조직 관리자에게 승인자 추가를 요청하세요.');
  });

  it("formats the waited time rounding down: 'n분째'·'n시간째'·'n일째'", () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(waited(ago(30_000), now)).toBe('1분째'); // 첫 1분 안
    expect(waited(ago(59 * 60_000 + 59_000), now)).toBe('59분째');
    expect(waited(ago(4 * 3600_000 + 59 * 60_000), now)).toBe('4시간째');
    expect(waited(ago(23 * 3600_000 + 59 * 60_000), now)).toBe('23시간째');
    expect(waited(ago(49 * 3600_000), now)).toBe('2일째');
    expect(waited(null, now)).toBe('');
    expect(waited('not-a-date', now)).toBe('');
  });
});
