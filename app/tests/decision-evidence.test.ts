// A2-3: 결정 근거(결정 당시 역할·결정 때 본 승인 대상 지문·필요 승인 수에 셌는지). 이미 저장된 기록에서 읽을 때 계산하며 새로 쓰지 않는다.
// 결정 당시 역할은 역할 변경 기록(member.roles_changed) 기준이고 감사 기록 조회 권한(audit.read)이 있는 조회자에게만 준다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, key, login, makeApp, splitAuditCsv, type TestCtx } from './helpers.ts';
import { verifyChain, writeAudit } from '../server/audit.ts';
import { rolesAtDecision } from '../server/domain/evidence.ts';
import { decisionEvidenceText, type DecisionEvidence, type DecisionEvidenceView } from '../shared/terms.ts';

let ctx: TestCtx;
beforeEach(async () => { ctx = await makeApp(); });
afterEach(async () => { await ctx.app.close(); ctx.db.close(); });

const as = async (userId: string) => api(ctx.app, await login(ctx.app, userId));
const tail = (addr: string) => addr.slice(-6);
const approvedRow = (body: any) => body.timeline.find((t: any) => t.action === 'request.approved');
const rejectedRow = (body: any) => body.timeline.find((t: any) => t.action === 'request.rejected');

async function approve(userId: string, id: string) {
  const a = await as(userId);
  const cur = (await a.get(`/api/requests/${id}`)).body;
  const res = await a.post(`/api/requests/${id}/approve`, { version: cur.version, intentHash: cur.intentHash });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

describe('요청 상세: 표마다 결정 근거', () => {
  it('shows the auditor what 오민재 decided on wr-1: 승인자 at the time (role history), counted, same fingerprint; the timeline row carries the same evidence', async () => {
    const moon = await as('u-a-moon');
    const res = await moon.get('/api/requests/wr-1');
    expect(res.status).toBe(200);
    expect(res.body.approvals).toHaveLength(1);
    const a0 = res.body.approvals[0];
    expect(a0).toMatchObject({ name: '오민재', decision: 'approved', rolesAtDecision: ['approver'], rolesSource: 'role_history', approveRoleAtDecision: true, matchesRequestIntent: true, counted: true });
    expect(a0.intentHashDisplay).toBe(res.body.intentHashDisplay);
    const ev = approvedRow(res.body).evidence as DecisionEvidenceView;
    // 처리 기록의 근거에는 수행자 id(userId)를 넣지 않는다(같은 값은 approvals[].userId에 있다)
    expect(ev).not.toHaveProperty('userId');
    expect(ev).toEqual({
      name: '오민재', decision: 'approved', decidedAt: a0.createdAt, intentHashDisplay: res.body.intentHashDisplay,
      matchesRequestIntent: true, counted: true, rolesAtDecision: ['approver'], rolesSource: 'role_history', approveRoleAtDecision: true,
    });
    // 처리 기록 행에는 수행자 id(actor_id)를 넣지 않는다(근거에도 userId 없음)
    for (const t of res.body.timeline) { expect(t).not.toHaveProperty('actorId'); expect(t).not.toHaveProperty('actor_id'); if (t.evidence) expect(t.evidence).not.toHaveProperty('userId'); }
    // 결정이 아닌 행에는 evidence가 없다
    expect(res.body.timeline.find((t: any) => t.action === 'request.submitted')).not.toHaveProperty('evidence');
    expect(decisionEvidenceText(ev, { showRoles: true })).toBe(`결정 당시 역할: 승인자(역할 변경 기록 기준) · 필요 승인 수에 셈 · 결정 때 본 승인 대상 지문 ${res.body.intentHashDisplay}(지금 요청과 같음)`);
    // 반려(wr-2, 서예린): 필요 승인 수 조각 없이 역할·지문
    const wr2 = (await moon.get('/api/requests/wr-2')).body;
    const rej = rejectedRow(wr2).evidence as DecisionEvidenceView;
    expect(rej).toMatchObject({ name: '서예린', decision: 'rejected', counted: false, rolesAtDecision: ['approver'], matchesRequestIntent: true });
    expect(decisionEvidenceText(rej, { showRoles: true })).toBe(`결정 당시 역할: 승인자(역할 변경 기록 기준) · 결정 때 본 승인 대상 지문 ${wr2.intentHashDisplay}(지금 요청과 같음)`);
  });

  it('gives roles only to audit.read holders (auditor, admin); the requester and approvers still see fingerprint, counted and the match', async () => {
    expect((await (await as('u-a-yoon')).get('/api/requests/wr-1')).body.approvals[0].rolesAtDecision).toEqual(['approver']);
    for (const user of ['u-a-han', 'u-a-seo', 'u-a-kang']) {
      const body = (await (await as(user)).get('/api/requests/wr-1')).body;
      const a0 = body.approvals[0];
      expect(a0, user).toMatchObject({ rolesAtDecision: null, rolesSource: null, approveRoleAtDecision: null, counted: true, matchesRequestIntent: true, intentHashDisplay: body.intentHashDisplay });
      expect(approvedRow(body).evidence.rolesAtDecision, user).toBeNull();
      // 역할 조각 없이 필요 승인 수·지문만
      expect(decisionEvidenceText(approvedRow(body).evidence, { showRoles: false })).toBe(`필요 승인 수에 셈 · 결정 때 본 승인 대상 지문 ${body.intentHashDisplay}(지금 요청과 같음)`);
    }
  });

  it('keeps the decision-time role and counted list after the role is removed later; a pending vote loses counted but keeps its role', async () => {
    // 승인 대기 wr-3에 오민재가 승인(1/2)
    await approve('u-a-oh', 'wr-3');
    const admin = await as('u-a-yoon');
    expect((await admin.put('/api/org/members/u-a-oh/roles', { roles: [], rolesVersion: 1 })).status).toBe(200);
    const moon = await as('u-a-moon');
    const wr1 = (await moon.get('/api/requests/wr-1')).body;
    expect(wr1.approvals[0]).toMatchObject({ rolesAtDecision: ['approver'], counted: true });
    const wr3 = (await moon.get('/api/requests/wr-3')).body;
    expect(wr3.approvals[0]).toMatchObject({ name: '오민재', rolesAtDecision: ['approver'], counted: false, matchesRequestIntent: true });
    expect(decisionEvidenceText(approvedRow(wr3).evidence, { showRoles: true })).toContain('필요 승인 수에 세지 않음');
  });

  it('records the role at the time even for someone granted approver, deciding, then losing it', async () => {
    const admin = await as('u-a-yoon');
    expect((await admin.put('/api/org/members/u-a-moon/roles', { roles: ['auditor', 'approver'], rolesVersion: 1 })).status).toBe(200);
    const done = await approve('u-a-moon', 'wr-4'); // 1명 필요 → 처리 중
    expect(done.status).toBe('PROCESSING');
    const members = (await admin.get('/api/org/members')).body;
    const moonV = members.find((m: any) => m.id === 'u-a-moon').rolesVersion;
    expect((await admin.put('/api/org/members/u-a-moon/roles', { roles: ['auditor'], rolesVersion: moonV })).status).toBe(200);
    const body = (await admin.get('/api/requests/wr-4')).body;
    expect(body.approvals[0]).toMatchObject({ name: '문태호', rolesAtDecision: ['approver', 'auditor'], counted: true, approveRoleAtDecision: true });
  });

  it('warns when the role history shows no approve permission (role changed outside the app), and marks mismatched or missing fingerprints', async () => {
    // 앱을 거치지 않고 저장 계층에서 승인자 역할을 줌(역할 변경 기록 없음)
    ctx.db.prepare("INSERT INTO user_roles (user_id, role) VALUES ('u-a-moon', 'approver')").run();
    await approve('u-a-moon', 'wr-4');
    const moon = await as('u-a-moon');
    const ev = approvedRow((await moon.get('/api/requests/wr-4')).body).evidence as DecisionEvidenceView;
    expect(ev).toMatchObject({ rolesAtDecision: ['auditor'], approveRoleAtDecision: false });
    expect(decisionEvidenceText(ev, { showRoles: true })).toMatch(/ · 역할 변경 기록상 이때 승인 권한이 없습니다 — 기록을 확인하세요$/);
    // 지금 요청의 지문과 다른 표 / 지문 기록이 없는 표(테스트에서 저장 계층에 직접 넣음)
    const t = new Date().toISOString();
    ctx.db.prepare("INSERT INTO approvals (request_id, user_id, decision, created_at) VALUES ('wr-3', 'u-a-oh', 'approved', ?)").run(t);
    ctx.db.prepare("INSERT INTO approval_intents (request_id, user_id, intent_hash, created_at) VALUES ('wr-3', 'u-a-oh', ?, ?)").run('ab'.repeat(32), t);
    ctx.db.prepare("INSERT INTO approvals (request_id, user_id, decision, created_at) VALUES ('wr-3', 'u-a-seo', 'approved', ?)").run(t);
    const wr3 = (await moon.get('/api/requests/wr-3')).body;
    const oh = wr3.approvals.find((a: any) => a.userId === 'u-a-oh');
    const seo = wr3.approvals.find((a: any) => a.userId === 'u-a-seo');
    expect(oh).toMatchObject({ matchesRequestIntent: false, intentHashDisplay: 'ABAB ABAB ABAB ABAB' });
    expect(seo).toMatchObject({ matchesRequestIntent: null, intentHashDisplay: null });
    const toEv = (a: any): DecisionEvidence => ({ ...a, decidedAt: a.createdAt });
    expect(decisionEvidenceText(toEv(oh), { showRoles: false })).toContain('결정 때 본 승인 대상 지문 ABAB ABAB ABAB ABAB(지금 요청과 다름)');
    expect(decisionEvidenceText(toEv(seo), { showRoles: false })).toContain('승인 대상 지문 기록 없음(이 기능 도입 전 결정)');
  });

  it("says '알 수 없음' when there is no role history, unlike an empty role list from the history", () => {
    const base: DecisionEvidenceView = {
      name: '오민재', decision: 'approved', decidedAt: '2026-10-21T00:00:00.000Z', intentHashDisplay: null, matchesRequestIntent: null,
      counted: true, rolesAtDecision: null, rolesSource: null, approveRoleAtDecision: null,
    };
    expect(decisionEvidenceText(base, { showRoles: true })).toBe('결정 당시 역할: 알 수 없음(역할 변경 기록 없음) · 필요 승인 수에 셈 · 승인 대상 지문 기록 없음(이 기능 도입 전 결정)');
    // 역할 변경 기록상 역할이 비어 있던 경우는 '없음(역할 변경 기록 기준)'과 경고 줄
    expect(decisionEvidenceText({ ...base, rolesAtDecision: [], rolesSource: 'role_history', approveRoleAtDecision: false }, { showRoles: true }))
      .toBe('결정 당시 역할: 없음(역할 변경 기록 기준) · 필요 승인 수에 셈 · 승인 대상 지문 기록 없음(이 기능 도입 전 결정) · 역할 변경 기록상 이때 승인 권한이 없습니다 — 기록을 확인하세요');
    // 감사 기록 조회 권한이 없으면 역할 조각이 없다
    expect(decisionEvidenceText(base, { showRoles: false })).toBe('필요 승인 수에 셈 · 승인 대상 지문 기록 없음(이 기능 도입 전 결정)');
  });

  it('ignores a role change recorded in the same millisecond but after the decision record (seq before the decision only)', async () => {
    await approve('u-a-oh', 'wr-3');
    const at = (ctx.db.prepare("SELECT created_at FROM approvals WHERE request_id = 'wr-3' AND user_id = 'u-a-oh'").get() as { created_at: string }).created_at;
    // 결정 기록 뒤에, 결정과 같은 시각으로 역할 해제 기록을 남긴다(created_at은 같고 seq만 더 크다)
    writeAudit(ctx.db, {
      orgId: 'org-a', actorId: 'u-a-yoon', actorName: '윤가람', action: 'member.roles_changed', targetType: 'user', targetId: 'u-a-oh', at,
      summary: '같은 밀리초 역할 해제(테스트)', detail: { before: ['approver'], after: [] },
    });
    expect(rolesAtDecision(ctx.db, 'org-a', 'u-a-oh', 'wr-3', at)).toEqual(['approver']);
    const wr3 = (await (await as('u-a-moon')).get('/api/requests/wr-3')).body;
    expect(wr3.approvals.find((a: any) => a.userId === 'u-a-oh')).toMatchObject({ rolesAtDecision: ['approver'], approveRoleAtDecision: true });
    expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);
  });
});

describe('감사 기록 목록·CSV의 결정 근거', () => {
  it('attaches evidence to request.approved/rejected items only', async () => {
    const moon = await as('u-a-moon');
    const approved = await moon.get('/api/audit?action=request.approved');
    expect(approved.body.items.length).toBeGreaterThan(0);
    for (const i of approved.body.items) expect(i.evidence, i.summary).toMatchObject({ decision: 'approved', rolesSource: 'role_history' });
    expect(approved.body.items.find((i: any) => i.targetId === 'wr-1').evidence).toMatchObject({ name: '오민재', rolesAtDecision: ['approver'], counted: true, matchesRequestIntent: true });
    const rejected = await moon.get('/api/audit?action=request.rejected');
    expect(rejected.body.items[0].evidence).toMatchObject({ name: '서예린', decision: 'rejected' });
    const others = await moon.get('/api/audit?pageSize=100');
    for (const i of others.body.items.filter((x: any) => !['request.approved', 'request.rejected'].includes(x.action))) expect(i, i.action).not.toHaveProperty('evidence');
  });

  it('keeps org B apart: B sees only B evidence in the list and the CSV, never A names', async () => {
    // 모의법인 B에도 승인 기록을 하나 만든다(배서준 요청 → 임하은 승인)
    const bae = await as('u-b-bae');
    const cr = await bae.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-b1', amount: '100', purpose: 'B 결정 근거 확인' }, { 'idempotency-key': key() });
    const rv = await bae.post(`/api/requests/${cr.body.id}/review`, { version: cr.body.version });
    const sub = await bae.post(`/api/requests/${cr.body.id}/submit`, { version: rv.body.version, confirmTail: tail(cr.body.address.address), ackIrreversible: true, checkReasons: { first_use: '거래처와 등록된 번호로 통화해 확인했습니다' } });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    await approve('u-b-lim', cr.body.id);
    const jo = await login(ctx.app, 'u-b-jo'); // 조직 관리자 + 감사 담당자
    const list = await api(ctx.app, jo).get('/api/audit?action=request.approved');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].evidence).toMatchObject({ name: '임하은', rolesAtDecision: ['approver'], counted: true });
    const csv = await ctx.app.inject({ method: 'GET', url: '/api/audit/export.csv', headers: { cookie: jo.cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).not.toMatch(/오민재|서예린|강도윤|한지수|문태호|윤가람|org-a|wr-1/);
    const { rows } = splitAuditCsv(csv.body);
    const filled = rows.filter((r) => r[8] !== '');
    expect(filled).toHaveLength(1);
    expect(filled[0]![4]).toBe('request.approved');
    expect(filled[0]![8]).toMatch(/^결정 당시 역할: 승인자\(역할 변경 기록 기준\) · 필요 승인 수에 셈 · 결정 때 본 승인 대상 지문 [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}\(지금 요청과 같음\)$/);
    // 모의법인 A의 요청을 B 감사 담당자가 직접 부르면 404
    expect((await api(ctx.app, jo).get('/api/requests/wr-1')).status).toBe(404);
  });

  it('exports 10 columns with 해시 last, evidence only on decisions, every hash equal to the stored one, and only one new audit row', async () => {
    const before = (ctx.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE org_id = 'org-a'").get() as { c: number }).c;
    const moon = await login(ctx.app, 'u-a-moon'); // 로그인 기록 1건
    const res = await ctx.app.inject({ method: 'GET', url: '/api/audit/export.csv', headers: { cookie: moon.cookie } });
    expect(res.statusCode).toBe(200);
    const after = (ctx.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE org_id = 'org-a'").get() as { c: number }).c;
    expect(after - before).toBe(2); // 로그인 1 + 내보내기 1(audit.exported)
    expect((ctx.db.prepare("SELECT action FROM audit_log WHERE org_id = 'org-a' ORDER BY seq DESC LIMIT 1").get() as { action: string }).action).toBe('audit.exported');
    const { header, rows } = splitAuditCsv(res.body);
    expect(header).toHaveLength(10);
    expect(header[8]).toBe('결정 근거(내보낼 때 계산)');
    expect(header[9]).toBe('해시');
    const stored = new Map((ctx.db.prepare("SELECT ROW_NUMBER() OVER (ORDER BY seq) n, hash FROM audit_log WHERE org_id = 'org-a'").all() as { n: number; hash: string }[]).map((r) => [r.n, r.hash]));
    for (const r of rows) {
      expect(r).toHaveLength(10);
      expect(r[9]).toBe(stored.get(Number(r[0])));
      const decision = r[4] === 'request.approved' || r[4] === 'request.rejected';
      if (decision) expect(r[8], r[7]).toMatch(/^결정 당시 역할: 승인자\(역할 변경 기록 기준\)/);
      else expect(r[8], r[4]).toBe('');
      // 수식 무력화: 어느 셀도 =,+,-,@로 시작하지 않는다(작은따옴표가 붙는다)
      for (const c of r) expect(c).not.toMatch(/^[=+\-@]/);
    }
    expect(rows.filter((r) => r[8] !== '').map((r) => r[6]).sort()).toEqual(['wr-1', 'wr-2']);
    expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);
  });
});
