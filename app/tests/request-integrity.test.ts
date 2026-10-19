// WP-02 출금 승인 무결성: 시세 없음·지연 시 fail closed, 유효한 표만 집계, 사용 중지 주소 요청 차단,
// 커스터디 멱등, 감사 상세, 승인자 부족 거부, 본인 권한 상승 금지, 보기별 칩 건수, 조직별 감사 번호.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, key, login, makeApp, type TestCtx } from './helpers.ts';
import { loadConfig } from '../server/config.ts';
import { migrate, openDb, type DB } from '../server/db.ts';
import { seed } from '../server/seed.ts';
import { buildApp } from '../server/app.ts';
import { MockCustodyAdapter, type WithdrawalSubmission } from '../server/adapters/custody.ts';

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
  const sub = await a.post(`/api/requests/${cr.body.id}/submit`, { version: rv.body.version, confirmTail: tail(cr.body.address.address), ackIrreversible: true });
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
    const first = await oh.post(`/api/requests/${p.id}/approve`, { version: p.version });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('PENDING_APPROVAL');
    expect(first.body.approvedCount).toBe(1);
    expect(auditDetail(ctx.db, p.id, 'request.approved').summary).toContain('승인 (유효 1/2)');

    const admin = api(ctx.app, await login(ctx.app, 'u-a-yoon'));
    const revoke = await admin.put('/api/org/members/u-a-oh/roles', { roles: [], rolesVersion: 1 });
    expect(revoke.status).toBe(200);
    expect(revoke.body.roles).toEqual([]);

    const seo = api(ctx.app, await login(ctx.app, 'u-a-seo'));
    const second = await seo.post(`/api/requests/${p.id}/approve`, { version: first.body.version });
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
    const third = await kang.post(`/api/requests/${p.id}/approve`, { version: second.body.version });
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
    expect((await oh.post(`/api/requests/${p.id}/approve`, { version: p.version })).status).toBe(200);
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

    const ap = await oh.post(`/api/requests/${p.id}/approve`, { version: got.body.version });
    expect(ap.status).toBe(422);
    expect(ap.body.error.code).toBe('ADDRESS_NOT_ACTIVE');
    expect(reserved(ctx.db, 'w-a-eth', 'USDC')).toBe('100500000'); // 반려·취소 전까지 예약은 유지된다

    const rj = await oh.post(`/api/requests/${p.id}/reject`, { version: got.body.version, reason: '받는 주소가 사용 중지되어 반려합니다' });
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
      const failed = await oh.post(`/api/requests/${p.id}/approve`, { version: p.version }, { 'idempotency-key': k });
      expect(failed.status).toBe(500);
      expect(failed.body.error.code).toBe('INTERNAL');
      expect(custody.calls).toBe(1);
      const rolled = db.prepare('SELECT status, custody_ref, version FROM withdrawal_requests WHERE id = ?').get(p.id) as any;
      expect(rolled).toMatchObject({ status: 'PENDING_APPROVAL', custody_ref: null, version: p.version });
      expect((db.prepare('SELECT COUNT(*) c FROM approvals WHERE request_id = ?').get(p.id) as any).c).toBe(0);

      db.exec('DROP TRIGGER wp02_fail_processing');
      const retry = await oh.post(`/api/requests/${p.id}/approve`, { version: p.version }, { 'idempotency-key': k });
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
    const sub = await a.post(`/api/requests/${cr.body.id}/submit`, { version: rv.body.version, confirmTail: tail(ab07.address), ackIrreversible: true });
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
    // seq 순서와 orgSeq 순서가 같다
    const bySeq = [...items].sort((x, y) => x.seq - y.seq).map((i) => i.orgSeq);
    expect(bySeq).toEqual(nums);
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
