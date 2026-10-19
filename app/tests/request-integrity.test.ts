// WP-02 출금 승인 무결성: 시세 없음·지연 시 fail closed, 유효한 표만 집계, 사용 중지 주소 요청 차단,
// 커스터디 멱등, 감사 상세, 승인자 부족 거부, 본인 권한 상승 금지, 보기별 칩 건수, 조직별 감사 번호.
// 리뷰 반영(G1): 읽을 수 없는 저장 수량, 결정 본문의 지문 불일치 기록, 커스터디에 넘기는 정규화 값, 작성·검토 중 사용 중지된 주소.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, key, login, makeApp, type TestCtx } from './helpers.ts';
import { loadConfig } from '../server/config.ts';
import { migrate, openDb, type DB } from '../server/db.ts';
import { seed } from '../server/seed.ts';
import { buildApp } from '../server/app.ts';
import { verifyChain } from '../server/audit.ts';
import { MockCustodyAdapter, type WithdrawalSubmission } from '../server/adapters/custody.ts';
import { FAMILY_RULES } from '../shared/address-rules.ts';
import { ACTION_LABEL } from '../shared/terms.ts';

let ctx: TestCtx;
beforeEach(async () => { ctx = await makeApp(); });
afterEach(async () => { await ctx.app.close(); ctx.db.close(); });

const tail = (addr: string) => addr.slice(-6);

/** 요청자가 초안 → 검토 → 승인 요청까지 진행한다. 제출 응답을 그대로 돌려준다. */
async function submitRequest(c: TestCtx, userId: string, body: Record<string, unknown> = {}) {
  const s = await login(c.app, userId);
  const a = api(c.app, s);
  const cr = await a.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '100.5', purpose: 'WP-02 무결성 테스트', ...body }, { 'idempotency-key': key() });
  expect(cr.status, JSON.stringify(cr.body)).toBe(201);
  const rv = await a.post(`/api/requests/${cr.body.id}/review`, { version: cr.body.version });
  expect(rv.status, JSON.stringify(rv.body)).toBe(200);
  // 처음 보내는 주소(모의법인 B의 ab-b1 등)는 출금 전 점검의 진행 사유가 필요하다(WP-11). 사유가 필요 없는 주소에는 무시된다.
  const sub = await a.post(`/api/requests/${cr.body.id}/submit`, { version: rv.body.version, confirmTail: tail(cr.body.address.address), ackIrreversible: true, checkReasons: { first_use: '거래처와 전화로 주소를 대조했습니다' } });
  return { sub, id: cr.body.id as string, reviewVersion: rv.body.version as number };
}

async function toPending(c: TestCtx, userId = 'u-a-han', body: Record<string, unknown> = {}) {
  const { sub } = await submitRequest(c, userId, body);
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  expect(sub.body.status).toBe('PENDING_APPROVAL');
  return sub.body;
}

function auditDetail(db: DB, requestId: string, action: string) {
  const row = db.prepare('SELECT summary, detail FROM audit_log WHERE target_id = ? AND action = ? ORDER BY seq DESC LIMIT 1').get(requestId, action) as { summary: string; detail: string } | undefined;
  expect(row, `${action} 감사 기록`).toBeTruthy();
  return { summary: row!.summary, detail: JSON.parse(row!.detail) };
}

const reserved = (db: DB, walletId: string, asset: string) => (db.prepare('SELECT reserved_units FROM balances WHERE wallet_id = ? AND asset_code = ?').get(walletId, asset) as { reserved_units: string }).reserved_units;

describe('필요 승인 수: 시세 없음·지연이면 fail closed', () => {
  it('keeps 1 approval for a fresh price below the threshold and records the basis', async () => {
    const p = await toPending(ctx);
    expect(p.requiredApprovals).toBe(1);
    expect(p.approvalBasis).toBe('value_below_threshold');
    expect(p.priceAsOfAtSubmit).toBeTruthy();
    expect(p.krwValueAtSubmit).toBe('140700'); // 100.5 USDC × 1,400원
    const { detail } = auditDetail(ctx.db, p.id, 'request.submitted');
    expect(detail.approvalBasis).toBe('value_below_threshold');
    expect(detail.priceAsOf).toBe(p.priceAsOfAtSubmit);
    expect(detail.krwValue).toBe('140700');
  });

  it('requires 2 approvals when the price row is missing', async () => {
    ctx.db.prepare("DELETE FROM prices WHERE asset_code = 'USDC'").run();
    const p = await toPending(ctx);
    expect(p.requiredApprovals).toBe(2);
    expect(p.approvalBasis).toBe('price_missing');
    expect(p.krwValueAtSubmit).toBeNull();
    expect(p.priceAsOfAtSubmit).toBeNull();
    const { summary, detail } = auditDetail(ctx.db, p.id, 'request.submitted');
    expect(detail.approvalBasis).toBe('price_missing');
    expect(detail.requiredApprovals).toBe(2);
    expect(detail.priceAsOf).toBeNull();
    expect(summary).toContain('필요 승인 2명');
  });

  it('requires 2 approvals when the price is older than priceStaleAfterMinutes', async () => {
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    ctx.db.prepare("UPDATE prices SET as_of = ? WHERE asset_code = 'USDC'").run(old);
    const p = await toPending(ctx);
    expect(p.requiredApprovals).toBe(2);
    expect(p.approvalBasis).toBe('price_stale');
    expect(p.priceAsOfAtSubmit).toBe(old);
    expect(auditDetail(ctx.db, p.id, 'request.submitted').detail.approvalBasis).toBe('price_stale');
  });

  it('treats an unreadable or future-dated price time as stale, and keeps the high-value rule', async () => {
    ctx.db.prepare("UPDATE prices SET as_of = ? WHERE asset_code = 'USDC'").run(new Date(Date.now() + 3600_000).toISOString());
    expect((await toPending(ctx)).approvalBasis).toBe('price_stale');
    ctx.db.prepare("UPDATE prices SET as_of = 'not-a-date' WHERE asset_code = 'USDC'").run();
    const bad = await toPending(ctx);
    expect(bad.requiredApprovals).toBe(2);
    expect(bad.approvalBasis).toBe('price_stale');
    ctx.db.prepare("UPDATE prices SET as_of = ? WHERE asset_code = 'USDC'").run(new Date().toISOString());
    const high = await toPending(ctx, 'u-a-han', { amount: '80000' });
    expect(high.requiredApprovals).toBe(2);
    expect(high.approvalBasis).toBe('value_at_or_above_threshold');
  });
});

describe('유효한 승인 표만 집계', () => {
  it('drops the vote of an approver whose role was removed, then a third valid approver completes the quorum', async () => {
    const p = await toPending(ctx, 'u-a-han', { amount: '80000' }); // 80,000 USDC × 1,400 = 1.12억 원 → 2인 승인
    expect(p.requiredApprovals).toBe(2);
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const first = await oh.post(`/api/requests/${p.id}/approve`, { version: p.version, intentHash: p.intentHash });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('PENDING_APPROVAL');
    expect(first.body.approvedCount).toBe(1);
    expect(auditDetail(ctx.db, p.id, 'request.approved').summary).toContain('승인 (유효 1/2)');

    const admin = api(ctx.app, await login(ctx.app, 'u-a-yoon'));
    const revoke = await admin.put('/api/org/members/u-a-oh/roles', { roles: [], rolesVersion: 1 });
    expect(revoke.status).toBe(200);
    expect(revoke.body.roles).toEqual([]);

    const seo = api(ctx.app, await login(ctx.app, 'u-a-seo'));
    const second = await seo.post(`/api/requests/${p.id}/approve`, { version: first.body.version, intentHash: first.body.intentHash });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('PENDING_APPROVAL');
    expect(second.body.approvedCount).toBe(1);
    const byUser = Object.fromEntries(second.body.approvals.map((a: any) => [a.userId, a.counted]));
    expect(byUser).toEqual({ 'u-a-oh': false, 'u-a-seo': true });
    const approved = auditDetail(ctx.db, p.id, 'request.approved');
    expect(approved.summary).toContain('승인 (유효 1/2)');
    expect(approved.detail).toMatchObject({ validApprovals: 1, required: 2, notCountedApproverIds: ['u-a-oh'] });
    // 홈의 진행 중 요청도 같은 기준으로 센다
    const dash = await api(ctx.app, await login(ctx.app, 'u-a-han')).get('/api/dashboard');
    expect(dash.body.inProgress.find((x: any) => x.id === p.id).approved).toBe(1);

    const kang = api(ctx.app, await login(ctx.app, 'u-a-kang'));
    const third = await kang.post(`/api/requests/${p.id}/approve`, { version: second.body.version, intentHash: second.body.intentHash });
    expect(third.status).toBe(200);
    expect(third.body.status).toBe('PROCESSING');
    expect(third.body.approvedCount).toBe(2);
    expect(third.body.approvals.find((a: any) => a.userId === 'u-a-oh').counted).toBe(false);
    expect([...auditDetail(ctx.db, p.id, 'request.processing').detail.approverIds].sort()).toEqual(['u-a-kang', 'u-a-seo']);

    // 결정이 끝난 요청의 승인 기록은 이후 역할 변경으로 달라지지 않는다
    expect((await admin.put('/api/org/members/u-a-oh/roles', { roles: ['approver'], rolesVersion: 2 })).status).toBe(200);
    expect((await admin.put('/api/org/members/u-a-seo/roles', { roles: [], rolesVersion: 1 })).status).toBe(200);
    const later = await oh.get(`/api/requests/${p.id}`);
    expect(later.body.approvedCount).toBe(2);
    expect(Object.fromEntries(later.body.approvals.map((a: any) => [a.userId, a.counted]))).toEqual({ 'u-a-oh': false, 'u-a-seo': true, 'u-a-kang': true });
  });

  it('does not count the vote of a deactivated approver and never edits the stored approval', async () => {
    const p = await toPending(ctx, 'u-a-han', { amount: '80000' });
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    expect((await oh.post(`/api/requests/${p.id}/approve`, { version: p.version, intentHash: p.intentHash })).status).toBe(200);
    ctx.db.prepare("UPDATE users SET is_active = 0 WHERE id = 'u-a-oh'").run();
    const cur = await api(ctx.app, await login(ctx.app, 'u-a-seo')).get(`/api/requests/${p.id}`);
    expect(cur.body.approvedCount).toBe(0);
    expect(cur.body.approvals).toEqual([expect.objectContaining({ userId: 'u-a-oh', decision: 'approved', counted: false })]);
    expect(() => ctx.db.prepare("UPDATE approvals SET decision = 'rejected' WHERE request_id = ?").run(p.id)).toThrow(/APPROVALS_IMMUTABLE/);
  });
});

describe('사용 중지된 받는 주소로 가는 요청', () => {
  it('stops offering approve, moves the request to view=blocked and the blocked tasks, and still refuses approval on the server', async () => {
    const p = await toPending(ctx);
    const ohS = await login(ctx.app, 'u-a-oh');
    const oh = api(ctx.app, ohS);
    const task = (body: any, kind: string) => body.tasks.find((t: any) => t.kind === kind);
    const before = await oh.get('/api/dashboard');
    const approveBefore = task(before.body, 'approve_requests').count;
    expect(task(before.body, 'blocked_requests').count).toBe(0);
    expect((await oh.get(`/api/requests/${p.id}`)).body.allowedActions).toEqual(['approve', 'reject']);

    const admin = api(ctx.app, await login(ctx.app, 'u-a-yoon'));
    const addr = await admin.get('/api/addresses/ab-01');
    expect((await admin.post('/api/addresses/ab-01/disable', { version: addr.body.version })).status).toBe(200);

    const got = await oh.get(`/api/requests/${p.id}`);
    expect(got.body.allowedActions).toEqual(['reject']);
    expect(got.body.blockedReason).toBe('ADDRESS_NOT_ACTIVE');
    expect(got.body.address.status).toBe('DISABLED');

    const toApprove = await oh.get('/api/requests?view=to_approve&pageSize=100');
    expect(toApprove.body.items.map((x: any) => x.id)).not.toContain(p.id);
    const blocked = await oh.get('/api/requests?view=blocked&pageSize=100');
    expect(blocked.body.items.map((x: any) => x.id)).toEqual([p.id]);
    expect(blocked.body.items[0].blockedReason).toBe('ADDRESS_NOT_ACTIVE');
    expect(blocked.body.counts).toEqual({ PENDING_APPROVAL: 1 });

    const after = await oh.get('/api/dashboard');
    expect(task(after.body, 'approve_requests').count).toBe(approveBefore - 1);
    expect(task(after.body, 'blocked_requests')).toMatchObject({ count: 1, tone: 'danger', href: '/requests?view=blocked' });
    const hanDash = await api(ctx.app, await login(ctx.app, 'u-a-han')).get('/api/dashboard');
    expect(task(hanDash.body, 'my_blocked_requests')).toMatchObject({ count: 1, tone: 'danger', href: '/requests?view=blocked' });

    const ap = await oh.post(`/api/requests/${p.id}/approve`, { version: got.body.version, intentHash: got.body.intentHash });
    expect(ap.status).toBe(422);
    expect(ap.body.error.code).toBe('ADDRESS_NOT_ACTIVE');
    expect(reserved(ctx.db, 'w-a-eth', 'USDC')).toBe('100500000'); // 반려·취소 전까지 예약은 유지된다

    const rj = await oh.post(`/api/requests/${p.id}/reject`, { version: got.body.version, reason: '받는 주소가 사용 중지되어 반려합니다', intentHash: got.body.intentHash });
    expect(rj.status).toBe(200);
    expect(rj.body.status).toBe('REJECTED');
    expect(rj.body.blockedReason).toBeNull();
    expect(reserved(ctx.db, 'w-a-eth', 'USDC')).toBe('0');
    expect(task((await oh.get('/api/dashboard')).body, 'blocked_requests').count).toBe(0);
  });
});

describe('커스터디 멱등', () => {
  class CountingCustody extends MockCustodyAdapter {
    calls = 0;
    refs: string[] = [];
    keys: string[] = [];
    override submitWithdrawal(input: WithdrawalSubmission) {
      this.calls += 1;
      this.keys.push(input.idempotencyKey);
      const out = super.submitWithdrawal(input);
      this.refs.push(out.ref);
      return out;
    }
  }

  it('returns the same custody ref when the approval is retried after a failure that rolled back the transaction', async () => {
    const cfg = loadConfig({ dbPath: ':memory:', logLevel: 'silent', serveClient: false, rateLimitMax: 10000 });
    cfg.policy.mockCustodyProcessingMs = 0;
    const db = openDb(':memory:');
    migrate(db);
    seed(db);
    const custody = new CountingCustody(0);
    const app = await buildApp({ cfg, db, custody });
    const c: TestCtx = { app, db, custody };
    try {
      const p = await toPending(c);
      const oh = api(app, await login(app, 'u-a-oh'));
      db.exec("CREATE TRIGGER wp02_fail_processing BEFORE INSERT ON audit_log WHEN NEW.action = 'request.processing' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;");
      const k = key();
      const failed = await oh.post(`/api/requests/${p.id}/approve`, { version: p.version, intentHash: p.intentHash }, { 'idempotency-key': k });
      expect(failed.status).toBe(500);
      expect(failed.body.error.code).toBe('INTERNAL');
      expect(custody.calls).toBe(1);
      const rolled = db.prepare('SELECT status, custody_ref, version FROM withdrawal_requests WHERE id = ?').get(p.id) as any;
      expect(rolled).toMatchObject({ status: 'PENDING_APPROVAL', custody_ref: null, version: p.version });
      expect((db.prepare('SELECT COUNT(*) c FROM approvals WHERE request_id = ?').get(p.id) as any).c).toBe(0);

      db.exec('DROP TRIGGER wp02_fail_processing');
      const retry = await oh.post(`/api/requests/${p.id}/approve`, { version: p.version, intentHash: p.intentHash }, { 'idempotency-key': k });
      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe('PROCESSING');
      expect(custody.calls).toBe(2);
      expect(custody.keys).toEqual([p.id, p.id]);
      expect(custody.refs[0]).toBe(custody.refs[1]);
      expect(custody.submissions).toBe(1);
      expect(retry.body.custodyRef).toBe(custody.refs[0]);
      const proc = auditDetail(db, p.id, 'request.processing');
      expect(proc.detail).toMatchObject({ idempotencyKey: p.id, custodyRef: custody.refs[0], addressId: 'ab-01', amount: '100.5', assetCode: 'USDC', networkCode: 'ETHEREUM' });
    } finally {
      await app.close();
      db.close();
    }
  });

  it('requires an idempotency key in the mock adapter', () => {
    const m = new MockCustodyAdapter(0);
    const input = { requestId: 'r1', idempotencyKey: '', assetCode: 'USDC', networkCode: 'ETHEREUM', amountUnits: '1', address: 'MOCK-EVM-X', memo: '' };
    expect(() => m.submitWithdrawal(input)).toThrow(/IDEMPOTENCY_KEY_REQUIRED/);
    const a = m.submitWithdrawal({ ...input, idempotencyKey: 'r1' });
    const b = m.submitWithdrawal({ ...input, idempotencyKey: 'r1' });
    const other = m.submitWithdrawal({ ...input, requestId: 'r2', idempotencyKey: 'r2' });
    expect(a.ref).toBe(b.ref);
    expect(other.ref).not.toBe(a.ref);
    expect(m.submissions).toBe(2);
  });
});

describe('감사 상세: 무엇을 승인했는지 남김', () => {
  it('records before/after on edit and the destination on submit', async () => {
    const s = await login(ctx.app, 'u-a-han');
    const a = api(ctx.app, s);
    const ab07 = (await a.get('/api/addresses/ab-07')).body;
    const ab01 = (await a.get('/api/addresses/ab-01')).body;
    const cr = await a.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '100.5', purpose: '감사 상세 테스트' }, { 'idempotency-key': key() });
    const up = await a.put(`/api/requests/${cr.body.id}`, { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-07', amount: '80000', purpose: '감사 상세 테스트', version: cr.body.version });
    expect(up.status).toBe(200);
    const upd = auditDetail(ctx.db, cr.body.id, 'request.updated').detail;
    expect(upd.before).toMatchObject({ amount: '100.5', addressId: 'ab-01', addressTail: tail(ab01.address), assetCode: 'USDC', networkCode: 'ETHEREUM' });
    expect(upd.after).toMatchObject({ amount: '80000', addressId: 'ab-07', addressTail: tail(ab07.address), addressLabel: ab07.label });
    const rv = await a.post(`/api/requests/${cr.body.id}/review`, { version: up.body.version });
    const sub = await a.post(`/api/requests/${cr.body.id}/submit`, { version: rv.body.version, confirmTail: tail(ab07.address), ackIrreversible: true, checkReasons: { first_use: '결제 대행사와 전화로 주소를 대조했습니다' } });
    expect(sub.status).toBe(200);
    const d = auditDetail(ctx.db, cr.body.id, 'request.submitted').detail;
    expect(d).toMatchObject({
      assetCode: 'USDC', networkCode: 'ETHEREUM', amount: '80000', addressId: 'ab-07', addressLabel: ab07.label, addressTail: tail(ab07.address),
      memoSet: false, approvalBasis: 'value_at_or_above_threshold', requiredApprovals: 2, reserved: '80000',
    });
    expect(d.priceAsOf).toBe(sub.body.priceAsOfAtSubmit);
    // 전체 주소는 남기지 않는다
    expect(JSON.stringify(d)).not.toContain(ab07.address);
  });
});

describe('승인할 수 있는 사람이 부족하면 제출 거부', () => {
  it('refuses org B when the fail-closed rule needs 2 approvers but only 1 exists, and reserves nothing', async () => {
    ctx.db.prepare("DELETE FROM prices WHERE asset_code = 'USDC'").run();
    const { sub, id } = await submitRequest(ctx, 'u-b-bae', { addressId: 'ab-b1', amount: '100' });
    expect(sub.status).toBe(422);
    expect(sub.body.error.code).toBe('APPROVERS_INSUFFICIENT');
    expect(sub.body.error.message).toBe('승인 가능한 사람이 1명뿐이라 필요한 2명을 채울 수 없습니다.');
    expect(sub.body.error.action).toBe('조직 관리자에게 승인자 추가를 요청하세요.');
    expect(sub.body.error).toMatchObject({ eligibleApprovers: 1, requiredApprovals: 2, approvalBasis: 'price_missing' });
    expect(reserved(ctx.db, 'w-b-eth', 'USDC')).toBe('0');
    const row = ctx.db.prepare('SELECT status, required_approvals FROM withdrawal_requests WHERE id = ?').get(id) as any;
    expect(row.status).toBe('REVIEW');
    expect(ctx.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE target_id = ? AND action = 'request.submitted'").get(id)).toEqual({ c: 0 });
  });

  it('allows org B below the threshold with a fresh price, and explains when nobody can approve', async () => {
    expect((await submitRequest(ctx, 'u-b-bae', { addressId: 'ab-b1', amount: '100' })).sub.status).toBe(200);
    ctx.db.prepare("UPDATE users SET is_active = 0 WHERE id = 'u-b-lim'").run();
    const { sub } = await submitRequest(ctx, 'u-b-bae', { addressId: 'ab-b1', amount: '50' });
    expect(sub.status).toBe(422);
    expect(sub.body.error.code).toBe('APPROVERS_INSUFFICIENT');
    expect(sub.body.error.message).toBe('승인할 수 있는 사람이 없어 필요한 1명을 채울 수 없습니다.');
  });

  it('does not count the creator as an eligible approver', async () => {
    const admin = api(ctx.app, await login(ctx.app, 'u-a-yoon'));
    expect((await admin.put('/api/org/members/u-a-oh/roles', { roles: [], rolesVersion: 1 })).status).toBe(200);
    // 남은 승인 권한자: 강도윤(작성자), 서예린 → 작성자를 빼면 1명
    const { sub } = await submitRequest(ctx, 'u-a-kang', { amount: '80000' });
    expect(sub.status).toBe(422);
    expect(sub.body.error.code).toBe('APPROVERS_INSUFFICIENT');
    expect(sub.body.error.eligibleApprovers).toBe(1);
  });
});

describe('본인 역할 상승 금지', () => {
  it('refuses an admin granting themselves approver or requester, but allows granting others', async () => {
    const admin = api(ctx.app, await login(ctx.app, 'u-a-yoon'));
    for (const roles of [['admin', 'approver'], ['admin', 'requester']]) {
      const r = await admin.put('/api/org/members/u-a-yoon/roles', { roles, rolesVersion: 1 });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('SELF_ROLE_ESCALATION');
      expect(r.body.error.message).toBe('본인에게 승인자·자산 담당자 역할을 직접 부여할 수 없습니다.');
      expect(r.body.error.action).toBe('다른 조직 관리자에게 요청하세요.');
    }
    const me = (await admin.get('/api/org/members')).body.find((m: any) => m.id === 'u-a-yoon');
    expect(me.roles).toEqual(['admin']);
    expect(me.rolesVersion).toBe(1);
    expect((await admin.put('/api/org/members/u-a-yoon/roles', { roles: [], rolesVersion: 1 })).body.error.code).toBe('SELF_ADMIN_REMOVAL');
    const grant = await admin.put('/api/org/members/u-a-han/roles', { roles: ['requester', 'approver'], rolesVersion: 1 });
    expect(grant.status).toBe(200);
    expect(grant.body.roles).toEqual(['approver', 'requester']);
  });
});

describe('상태 칩 건수는 보기·검색 조건을 따른다', () => {
  it('counts only what the current view and search can list, ignoring just the status filter', async () => {
    const kang = api(ctx.app, await login(ctx.app, 'u-a-kang'));
    const toApprove = await kang.get('/api/requests?view=to_approve');
    expect(toApprove.body.items.map((x: any) => x.refNo)).toEqual(['WR-000003']);
    expect(toApprove.body.counts.PENDING_APPROVAL).toBe(toApprove.body.items.length);
    expect(toApprove.body.counts.PENDING_APPROVAL).toBe(1);
    const filtered = await kang.get('/api/requests?view=to_approve&status=COMPLETED');
    expect(filtered.body.total).toBe(0);
    expect(filtered.body.counts).toEqual({ PENDING_APPROVAL: 1 });

    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const mine = await han.get('/api/requests?view=mine');
    expect(mine.body.counts).toEqual({ COMPLETED: 1, PENDING_APPROVAL: 1, REVIEW: 1, DRAFT: 1 });
    const search = await han.get('/api/requests?q=' + encodeURIComponent('WR-000004'));
    expect(search.body.counts).toEqual({ PENDING_APPROVAL: 1 });
    const all = await han.get('/api/requests');
    expect(Object.values(all.body.counts).reduce((s: number, n) => s + (n as number), 0)).toBe(all.body.total);
  });
});

describe('조직별 감사 번호', () => {
  async function allAudit(userId: string, query = '') {
    const a = api(ctx.app, await login(ctx.app, userId));
    const items: any[] = [];
    for (let page = 1; ; page++) {
      const r = await a.get(`/api/audit?pageSize=100&page=${page}${query}`);
      expect(r.status).toBe(200);
      items.push(...r.body.items);
      if (items.length >= r.body.total || r.body.items.length === 0) return { items, total: r.body.total as number };
    }
  }

  it('numbers org A records contiguously from 1, before filters are applied', async () => {
    const { items, total } = await allAudit('u-a-moon');
    expect(items.length).toBe(total);
    const nums = items.map((i) => i.orgSeq).sort((x, y) => x - y);
    expect(nums).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    // 응답은 최신순이고 orgSeq도 그 순서로 줄어든다. 전체 공용 seq(다른 조직의 기록량이 드러나는 번호)는 싣지 않는다.
    expect(items.map((i) => i.orgSeq)).toEqual([...nums].reverse());
    for (const i of items) expect(i).not.toHaveProperty('seq');
    // 필터를 걸어도 같은 기록은 같은 번호를 유지한다
    const full = new Map(items.map((i) => [i.id, i.orgSeq]));
    const filtered = await allAudit('u-a-moon', '&action=member.roles_changed');
    expect(filtered.items.length).toBeGreaterThan(0);
    for (const i of filtered.items) expect(i.orgSeq).toBe(full.get(i.id));
  });

  it('numbers org B separately from 1', async () => {
    const { items, total } = await allAudit('u-b-jo');
    expect(items.map((i) => i.orgSeq).sort((x, y) => x - y)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });
});

describe('저장된 수량을 정수로 읽을 수 없는 요청(앱 밖 저장 계층 변경, A-30)', () => {
  const setAmount = (id: string, value: string) => ctx.db.prepare('UPDATE withdrawal_requests SET amount_units = ? WHERE id = ?').run(value, id);

  for (const bad of ['0.5', 'abc']) {
    it(`keeps detail, list and home at 200 with INTENT_TAMPERED when wr-4 stores '${bad}', and refuses approval with an audit record`, async () => {
      setAmount('wr-4', bad);
      const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
      const got = await oh.get('/api/requests/wr-4');
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      expect(got.body).toMatchObject({ status: 'PENDING_APPROVAL', blockedReason: 'INTENT_TAMPERED', amount: null, amountUnits: bad, allowedActions: ['reject'] });
      const list = await oh.get('/api/requests?pageSize=100');
      expect(list.status).toBe(200);
      expect(list.body.items.find((x: any) => x.id === 'wr-4')).toMatchObject({ amount: null, amountUnits: bad, blockedReason: 'INTENT_TAMPERED' });
      const kangList = await api(ctx.app, await login(ctx.app, 'u-a-kang')).get('/api/requests?view=mine');
      expect(kangList.status).toBe(200);
      const dash = await oh.get('/api/dashboard');
      expect(dash.status).toBe(200);
      expect(dash.body.inProgress.find((x: any) => x.id === 'wr-4')).toMatchObject({ amount: null, status: 'PENDING_APPROVAL' });

      // 화면이 승인을 내보이지 않아도 서버로 직접 보낸 승인은 500이 아니라 409 INTENT_TAMPERED이고, 감사 기록이 남는다.
      const ap = await oh.post('/api/requests/wr-4/approve', { version: got.body.version, intentHash: got.body.intentHash });
      expect(ap.status, JSON.stringify(ap.body)).toBe(409);
      expect(ap.body.error.code).toBe('INTENT_TAMPERED');
      expect(ctx.custody.submissions).toBe(0);
      const rec = auditDetail(ctx.db, 'wr-4', 'request.intent_tampered');
      expect(rec.detail).toMatchObject({ stage: 'approve', storedHash: got.body.intentHash, recomputedHash: null, current: { amount: null, amountUnits: bad } });
      expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);
    });

    for (const mode of ['reject', 'cancel'] as const) {
      it(`${mode}: closes wr-4 storing '${bad}' and releases the full 0.5 BTC reserved at submit`, async () => {
        const before = BigInt(reserved(ctx.db, 'w-a-btc', 'BTC'));
        expect(before).toBeGreaterThanOrEqual(50_000_000n);
        setAmount('wr-4', bad);
        const a = api(ctx.app, await login(ctx.app, mode === 'reject' ? 'u-a-oh' : 'u-a-kang'));
        const cur = (await a.get('/api/requests/wr-4')).body;
        expect(cur.allowedActions).toEqual([mode]);
        const res = mode === 'reject'
          ? await a.post('/api/requests/wr-4/reject', { version: cur.version, reason: '저장된 수량을 읽을 수 없어 반려합니다', intentHash: cur.intentHash })
          : await a.post('/api/requests/wr-4/cancel', { version: cur.version });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.status).toBe(mode === 'reject' ? 'REJECTED' : 'CANCELLED');
        expect(res.body.amount).toBeNull();
        expect(BigInt(reserved(ctx.db, 'w-a-btc', 'BTC'))).toBe(before - 50_000_000n);
        const d = auditDetail(ctx.db, 'wr-4', mode === 'reject' ? 'request.rejected' : 'request.cancelled').detail;
        expect(d).toMatchObject({ released: '0.5', releasedAssetCode: 'BTC', contentMatchesIntent: false });
        expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);
      });
    }
  }

  it('shows and cancels a draft whose stored amount is unreadable (no live checks, no 500)', async () => {
    setAmount('wr-6', 'abc');
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const got = await han.get('/api/requests/wr-6');
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(got.body).toMatchObject({ status: 'DRAFT', amount: null, checks: null, blockedReason: null });
    const c = await han.post('/api/requests/wr-6/cancel', { version: got.body.version });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.status).toBe('CANCELLED');
  });
});

describe('결정 본문의 지문이 다르면 감사 기록을 남긴다(409 INTENT_CHANGED)', () => {
  const orgRows = () => (ctx.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE org_id = 'org-a'").get() as { c: number }).c;
  const mismatchRows = () => ctx.db.prepare("SELECT actor_id, actor_name, summary, detail FROM audit_log WHERE target_id = 'wr-4' AND action = 'request.intent_mismatch' ORDER BY seq").all() as any[];

  for (const kind of ['approve', 'reject'] as const) {
    it(`writes exactly one request.intent_mismatch record when ${kind} carries a different fingerprint, and leaves no vote`, async () => {
      const s = await login(ctx.app, 'u-a-oh');
      const oh = api(ctx.app, s);
      const name = (await oh.get('/api/me')).body.user.name as string;
      const cur = (await oh.get('/api/requests/wr-4')).body;
      const reservedBefore = reserved(ctx.db, 'w-a-btc', 'BTC');
      const before = orgRows();
      const res = await oh.post(`/api/requests/wr-4/${kind}`, { version: cur.version, intentHash: 'F'.repeat(64), ...(kind === 'reject' ? { reason: '정산서와 수량이 다릅니다' } : {}) });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INTENT_CHANGED');
      expect(res.body.error.intentHashDisplay).toBe(cur.intentHashDisplay);
      expect(JSON.stringify(res.body)).not.toContain('submittedHashPrefix'); // 내부 기록은 응답에 싣지 않는다
      expect(orgRows()).toBe(before + 1);
      const rows = mismatchRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_id: 'u-a-oh', actor_name: name });
      expect(rows[0].summary).toContain('WR-000004');
      expect(rows[0].summary).toContain(kind === 'approve' ? '승인' : '반려');
      expect(JSON.parse(rows[0].detail)).toEqual({ decision: kind, storedHash: cur.intentHash, submittedHashPrefix: 'f'.repeat(16), actor: { id: 'u-a-oh', name }, voteRecorded: false });
      expect((ctx.db.prepare("SELECT COUNT(*) c FROM approvals WHERE request_id = 'wr-4'").get() as any).c).toBe(0);
      expect((ctx.db.prepare("SELECT status FROM withdrawal_requests WHERE id = 'wr-4'").get() as any).status).toBe('PENDING_APPROVAL');
      expect(reserved(ctx.db, 'w-a-btc', 'BTC')).toBe(reservedBefore);
      expect(ACTION_LABEL['request.intent_mismatch']).toBeTruthy();
      expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);
    });
  }

  it('records a null fingerprint sent for a request that has one, but not a missing fingerprint (422)', async () => {
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const cur = (await oh.get('/api/requests/wr-4')).body;
    const none = await oh.post('/api/requests/wr-4/approve', { version: cur.version });
    expect(none.status).toBe(422);
    expect(mismatchRows()).toHaveLength(0);
    const nul = await oh.post('/api/requests/wr-4/approve', { version: cur.version, intentHash: null });
    expect(nul.status).toBe(409);
    expect(nul.body.error.code).toBe('INTENT_CHANGED');
    expect(JSON.parse(mismatchRows()[0].detail)).toMatchObject({ decision: 'approve', submittedHashPrefix: null });
    // 맞는 지문으로는 그대로 승인된다
    const ok = await oh.post('/api/requests/wr-4/approve', { version: cur.version, intentHash: cur.intentHash });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

describe('커스터디에는 지문에 묶은 정규화 값을 넘긴다', () => {
  class RecordingCustody extends MockCustodyAdapter {
    inputs: WithdrawalSubmission[] = [];
    override submitWithdrawal(input: WithdrawalSubmission) {
      this.inputs.push(input);
      return super.submitWithdrawal(input);
    }
  }
  let rc: TestCtx & { custody: RecordingCustody };
  beforeEach(async () => {
    const cfg = loadConfig({ dbPath: ':memory:', logLevel: 'silent', serveClient: false, rateLimitMax: 10000 });
    cfg.policy.mockCustodyProcessingMs = 0;
    cfg.policy.addressBook.cooldownHours = 0;
    const db = openDb(':memory:');
    migrate(db);
    seed(db);
    const custody = new RecordingCustody(0);
    rc = { app: await buildApp({ cfg, db, custody }), db, custody };
  });
  afterEach(async () => { await rc.app.close(); rc.db.close(); });

  /** 승인 대기가 끝날 때까지 작성자가 아닌 승인자가 차례로 승인한다. */
  async function approveUntilProcessing(id: string, approvers: string[]) {
    let last: any = null;
    for (const u of approvers) {
      const a = api(rc.app, await login(rc.app, u));
      const cur = (await a.get(`/api/requests/${id}`)).body;
      expect(cur.blockedReason, u).toBeNull();
      last = await a.post(`/api/requests/${id}/approve`, { version: cur.version, intentHash: cur.intentHash });
      expect(last.status, JSON.stringify(last.body)).toBe(200);
      if (last.body.status === 'PROCESSING') return last.body;
    }
    throw new Error(`not processing: ${JSON.stringify(last?.body)}`);
  }

  for (const [label, stored] of [['hex', '0x2FAF080'], ['zero-padded with spaces', '  000050000000  ']] as const) {
    it(`hands custody '50000000', not the stored ${label} text, for wr-4 (0.5 BTC)`, async () => {
      const addr = (rc.db.prepare("SELECT address FROM address_book WHERE id = 'ab-03'").get() as any).address as string;
      rc.db.prepare("UPDATE withdrawal_requests SET amount_units = ? WHERE id = 'wr-4'").run(stored);
      const seen = (await api(rc.app, await login(rc.app, 'u-a-oh')).get('/api/requests/wr-4')).body;
      expect(seen.amount).toBe('0.5'); // 화면과 지문은 같은 값(0.5 BTC)을 본다
      const done = await approveUntilProcessing('wr-4', ['u-a-oh']);
      expect(done.custodyRef).toBeTruthy();
      expect(rc.custody.inputs).toHaveLength(1);
      expect(rc.custody.inputs[0]).toMatchObject({ assetCode: 'BTC', networkCode: 'BITCOIN', amountUnits: '50000000', address: addr, memo: '' });
      expect(auditDetail(rc.db, 'wr-4', 'request.processing').detail).toMatchObject({ amount: '0.5', addressTail: tail(addr) });
    });
  }

  it('hands custody the normalized address and a decimal amount when wr-3 was re-cased and padded in storage', async () => {
    const addr = (rc.db.prepare("SELECT address FROM address_book WHERE id = 'ab-02'").get() as any).address as string;
    rc.db.prepare("UPDATE address_book SET address = ? WHERE id = 'ab-02'").run(`  ${addr.toLowerCase()}  `);
    rc.db.prepare("UPDATE withdrawal_requests SET amount_units = ? WHERE id = 'wr-3'").run(' 0120000000000 ');
    await approveUntilProcessing('wr-3', ['u-a-oh', 'u-a-seo']);
    expect(rc.custody.inputs).toHaveLength(1);
    const sent = rc.custody.inputs[0]!;
    expect(sent).toMatchObject({ assetCode: 'USDC', networkCode: 'KAIA', amountUnits: '120000000000', address: addr, memo: '' });
    expect(FAMILY_RULES.MOCK_EVM.pattern.test(sent.address)).toBe(true);
  });

  it('trims a padded destination tag before hand-off (XRP)', async () => {
    const han = api(rc.app, await login(rc.app, 'u-a-han'));
    const r = (await han.get('/api/requests/wr-5')).body;
    const sub = await han.post('/api/requests/wr-5/submit', {
      version: r.version, confirmTail: tail(r.address.address), ackIrreversible: true,
      checkReasons: { first_use: '거래소와 전화로 주소와 태그를 대조했습니다', balance_share: '유동성 공급 계약 물량입니다', amount_history: '유동성 공급 계약 물량입니다' },
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    rc.db.prepare("UPDATE address_book SET memo = ' 1234567 ' WHERE id = 'ab-04'").run();
    await approveUntilProcessing('wr-5', ['u-a-oh', 'u-a-seo']);
    expect(rc.custody.inputs[0]).toMatchObject({ assetCode: 'XRP', networkCode: 'XRPL', memo: '1234567', address: r.address.address });
  });
});

describe('작성·검토 중에 받는 주소가 사용 중지된 요청', () => {
  it('drops review and submit, keeps edit, back_to_draft and cancel, and tells the requester to pick another address or cancel', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const ab07 = (await han.get('/api/addresses/ab-07')).body;
    const cr = await han.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-07', amount: '10', purpose: '사용 중지 주소 테스트' }, { 'idempotency-key': key() });
    expect(cr.status).toBe(201);
    const rv = await han.post(`/api/requests/${cr.body.id}/review`, { version: cr.body.version });
    expect(rv.body.allowedActions).toEqual(['back_to_draft', 'submit', 'cancel']);

    const admin = api(ctx.app, await login(ctx.app, 'u-a-yoon'));
    expect((await admin.post('/api/addresses/ab-07/disable', { version: ab07.version })).status).toBe(200);

    const got = (await han.get(`/api/requests/${cr.body.id}`)).body;
    expect(got).toMatchObject({ status: 'REVIEW', blockedReason: null, address: { status: 'DISABLED' } });
    expect(got.allowedActions).toEqual(['back_to_draft', 'cancel']);
    const sub = await han.post(`/api/requests/${cr.body.id}/submit`, { version: got.version, confirmTail: tail(ab07.address), ackIrreversible: true, checkReasons: { first_use: '결제 대행사와 전화로 주소를 대조했습니다' } });
    expect(sub.status).toBe(422);
    expect(sub.body.error).toMatchObject({
      code: 'ADDRESS_NOT_ACTIVE',
      message: `'${ab07.label}' 주소는 사용 중지되어 이 요청에 쓸 수 없습니다.`,
      action: '작성 단계로 되돌린 뒤 내용 수정에서 다른 주소를 고르거나 요청을 취소하세요.',
      fields: [{ field: 'addressId', message: '사용 중지된 주소입니다.' }],
      addressStatus: 'DISABLED',
    });
    expect(sub.body.error.action).not.toContain('두 번째 담당자');

    const back = await han.post(`/api/requests/${cr.body.id}/back-to-draft`, { version: got.version });
    expect(back.status).toBe(200);
    expect(back.body.allowedActions).toEqual(['edit', 'cancel']);
    const again = await han.post(`/api/requests/${cr.body.id}/review`, { version: back.body.version });
    expect(again.status).toBe(422);
    expect(again.body.error.action).toBe('내용 수정에서 다른 주소를 고르거나 요청을 취소하세요.');

    // 다른 주소를 고르면 다시 검토로 보낼 수 있다
    const edited = await han.put(`/api/requests/${cr.body.id}`, { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '10', purpose: '사용 중지 주소 테스트', version: back.body.version });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.allowedActions).toEqual(['edit', 'review', 'cancel']);

    // 새로 작성할 때는 요청이 아직 없으므로 다른 주소를 고르라고만 안내한다
    const fresh = await han.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-07', amount: '10', purpose: '사용 중지 주소 테스트' }, { 'idempotency-key': key() });
    expect(fresh.status).toBe(422);
    expect(fresh.body.error).toMatchObject({ message: `'${ab07.label}' 주소는 사용 중지되어 출금 요청에 쓸 수 없습니다.`, action: '주소록에서 사용 가능한 다른 주소를 고르세요.' });
  });
});
