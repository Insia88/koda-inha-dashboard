import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, key, login, makeApp, type TestCtx } from './helpers.ts';
import { loadConfig } from '../server/config.ts';
import { migrate, openDb } from '../server/db.ts';
import { seed } from '../server/seed.ts';
import { buildApp } from '../server/app.ts';
import { MockCustodyAdapter } from '../server/adapters/custody.ts';
import { settleProcessing } from '../server/domain/requests.ts';
import { middleSegment } from '../shared/address-rules.ts';

let ctx: TestCtx;
beforeEach(async () => { ctx = await makeApp(); });
afterEach(async () => { await ctx.app.close(); ctx.db.close(); });

const tail = (addr: string) => addr.slice(-6);
const middle = (addr: string) => middleSegment(addr).text;
const NEW_EVM = 'MOCK-EVM-' + '1234567890ABCDEF1234567890ABCDEF12345678';

async function newDraft(c = ctx, userId = 'u-a-han', body: Record<string, unknown> = {}) {
  const s = await login(c.app, userId);
  const r = await api(c.app, s).post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '100.5', purpose: '테스트 요청', ...body }, { 'idempotency-key': key() });
  return { s, r };
}

async function toPending(userId = 'u-a-han', amount = '100.5') {
  const { s, r } = await newDraft(ctx, userId, { amount });
  expect(r.status).toBe(201);
  const a = api(ctx.app, s);
  const rv = await a.post(`/api/requests/${r.body.id}/review`, { version: r.body.version });
  expect(rv.status).toBe(200);
  const sub = await a.post(`/api/requests/${r.body.id}/submit`, { version: rv.body.version, confirmTail: tail(r.body.address.address), ackIrreversible: true });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return sub.body;
}

describe('인증·세션·CSRF', () => {
  it('rejects unauthenticated access and missing CSRF on mutation', async () => {
    expect((await api(ctx.app, null).get('/api/dashboard')).status).toBe(401);
    const s = await login(ctx.app, 'u-a-han');
    const res = await ctx.app.inject({ method: 'POST', url: '/api/requests', headers: { cookie: s.cookie, 'idempotency-key': key() }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_REJECTED');
  });
  it('logout revokes the session server-side', async () => {
    const s = await login(ctx.app, 'u-a-han');
    expect((await api(ctx.app, s).post('/api/auth/logout')).status).toBe(200);
    expect((await api(ctx.app, s).get('/api/me')).status).toBe(401);
  });
  it('sets an HttpOnly SameSite=Strict cookie', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { userId: 'u-a-han' } });
    const c = String(res.headers['set-cookie']);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
  });
});

describe('조직 격리', () => {
  it('denies cross-org reads and writes with 404 (no existence leak)', async () => {
    const b = api(ctx.app, await login(ctx.app, 'u-b-lim'));
    expect((await b.get('/api/requests/wr-3')).status).toBe(404);
    expect((await b.post('/api/requests/wr-3/approve', { version: 3 })).status).toBe(404);
    expect((await b.get('/api/addresses/ab-01')).status).toBe(404);
    const list = await b.get('/api/requests');
    expect(list.body.total).toBe(0);
    const addrs = await b.get('/api/addresses');
    expect(addrs.body.items.every((x: any) => x.id.startsWith('ab-b'))).toBe(true);
    const audit = await api(ctx.app, await login(ctx.app, 'u-b-jo')).get('/api/audit?pageSize=100');
    expect(audit.body.items.some((x: any) => x.targetId === 'wr-3')).toBe(false);
  });
  it('refuses a request that points to another org address', async () => {
    const { r } = await newDraft(ctx, 'u-b-bae', { addressId: 'ab-01' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ADDRESS_NOT_FOUND');
  });
});

describe('역할별 접근', () => {
  it('enforces permissions on the server regardless of UI', async () => {
    const auditor = api(ctx.app, await login(ctx.app, 'u-a-moon'));
    expect((await auditor.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '1', purpose: '감사자 시도' }, { 'idempotency-key': key() })).status).toBe(403);
    expect((await auditor.post('/api/requests/wr-4/approve', { version: 3 })).status).toBe(403);
    expect((await auditor.get('/api/audit')).status).toBe(200);
    const requester = api(ctx.app, await login(ctx.app, 'u-a-han'));
    expect((await requester.get('/api/audit')).status).toBe(403);
    expect((await requester.get('/api/audit/export.csv')).status).toBe(403);
    expect((await requester.put('/api/org/members/u-a-oh/roles', { roles: ['admin'], rolesVersion: 1 })).status).toBe(403);
    const approver = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    expect((await approver.post('/api/addresses', {})).status).toBe(403);
    const admin = api(ctx.app, await login(ctx.app, 'u-a-yoon'));
    expect((await admin.get('/api/audit/export.csv')).status).toBe(403);
    const op = api(ctx.app, await login(ctx.app, 'u-k-op'));
    expect((await op.get('/api/dashboard')).status).toBe(403);
    expect((await requester.post('/api/insights', {})).status).toBe(403);
  });
  it('role change takes effect immediately and is audited', async () => {
    const admin = api(ctx.app, await login(ctx.app, 'u-a-yoon'));
    const hanSession = await login(ctx.app, 'u-a-han');
    const han = api(ctx.app, hanSession);
    expect((await han.get('/api/audit')).status).toBe(403);
    const upd = await admin.put('/api/org/members/u-a-han/roles', { roles: ['requester', 'auditor'], rolesVersion: 1 });
    expect(upd.status).toBe(200);
    expect((await han.get('/api/audit')).status).toBe(200);
    const stale = await admin.put('/api/org/members/u-a-han/roles', { roles: ['requester'], rolesVersion: 1 });
    expect(stale.status).toBe(409);
    const self = await admin.put('/api/org/members/u-a-yoon/roles', { roles: [], rolesVersion: 1 });
    expect(self.body.error.code).toBe('SELF_ADMIN_REMOVAL');
    const auditor = api(ctx.app, await login(ctx.app, 'u-a-moon'));
    const log = await auditor.get('/api/audit?action=member.roles_changed&pageSize=100');
    expect(log.body.items[0].summary).toContain('한지수');
    expect((await admin.put('/api/org/members/u-b-bae/roles', { roles: ['admin'], rolesVersion: 1 })).status).toBe(404);
  });
});

describe('요청 상태 전이와 승인', () => {
  it('runs the full vertical flow: draft → review → pending → approve → processing → completed', async () => {
    const before = (await api(ctx.app, await login(ctx.app, 'u-a-han')).get('/api/balances')).body.assets.find((a: any) => a.assetCode === 'USDC');
    const pending = await toPending();
    expect(pending.status).toBe('PENDING_APPROVAL');
    expect(pending.requiredApprovals).toBe(1);
    const mid = (await api(ctx.app, await login(ctx.app, 'u-a-han')).get('/api/balances')).body.assets.find((a: any) => a.assetCode === 'USDC');
    expect(BigInt(mid.reserved.replace('.', '')) > BigInt(before.reserved.replace('.', ''))).toBe(true);
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const ap = await oh.post(`/api/requests/${pending.id}/approve`, { version: pending.version, intentHash: pending.intentHash });
    expect(ap.status).toBe(200);
    expect(ap.body.status).toBe('PROCESSING');
    expect(settleProcessing(ctx.db, ctx.custody)).toBe(1);
    const done = await oh.get(`/api/requests/${pending.id}`);
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.timeline.map((t: any) => t.action)).toEqual(['request.created', 'request.reviewing', 'request.submitted', 'request.approved', 'request.processing', 'request.completed']);
    const after = (await oh.get('/api/balances')).body.assets.find((a: any) => a.assetCode === 'USDC');
    expect(after.reserved).toBe(before.reserved);
    const act = await oh.get('/api/activity?type=withdrawal&pageSize=10');
    expect(act.body.items.some((x: any) => x.requestId === pending.id)).toBe(true);
  });

  it('forbids self-approval at API and at the storage layer', async () => {
    const pending = await toPending('u-a-kang');
    const kang = api(ctx.app, await login(ctx.app, 'u-a-kang'));
    const r = await kang.post(`/api/requests/${pending.id}/approve`, { version: pending.version, intentHash: pending.intentHash });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(() => ctx.db.prepare("INSERT INTO approvals VALUES (?, 'u-a-kang', 'approved', NULL, 'x')").run(pending.id)).toThrow(/SELF_APPROVAL_FORBIDDEN/);
  });

  it('rejects invalid transitions and stale versions', async () => {
    const { s, r } = await newDraft();
    const a = api(ctx.app, s);
    const sub = await a.post(`/api/requests/${r.body.id}/submit`, { version: r.body.version, confirmTail: tail(r.body.address.address), ackIrreversible: true });
    expect(sub.status).toBe(409);
    expect(sub.body.error.code).toBe('INVALID_TRANSITION');
    const stale = await a.post(`/api/requests/${r.body.id}/review`, { version: r.body.version + 5 });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    expect((await oh.post(`/api/requests/${r.body.id}/approve`, { version: r.body.version, intentHash: r.body.intentHash })).body.error.code).toBe('INVALID_TRANSITION');
    // 다른 요청자도 남의 초안을 바꿀 수 없다
    const kang = api(ctx.app, await login(ctx.app, 'u-a-kang'));
    expect((await kang.post(`/api/requests/${r.body.id}/cancel`, { version: r.body.version })).body.error.code).toBe('NOT_REQUEST_OWNER');
  });

  it('requires a rejection reason and releases the reservation', async () => {
    const pending = await toPending();
    const seo = api(ctx.app, await login(ctx.app, 'u-a-seo'));
    const bad = await seo.post(`/api/requests/${pending.id}/reject`, { version: pending.version, reason: '짧음', intentHash: pending.intentHash });
    expect(bad.status).toBe(422);
    expect(bad.body.error.fields[0].field).toBe('reason');
    const ok = await seo.post(`/api/requests/${pending.id}/reject`, { version: pending.version, reason: '수량이 정산서와 다릅니다', intentHash: pending.intentHash });
    expect(ok.body.status).toBe('REJECTED');
    expect(ok.body.rejectReason).toBe('수량이 정산서와 다릅니다');
    const b = ctx.db.prepare("SELECT reserved_units FROM balances WHERE wallet_id = 'w-a-eth' AND asset_code = 'USDC'").get() as any;
    expect(b.reserved_units).toBe('0');
  });

  it('requires two distinct approvers above the high-value threshold and handles concurrent approvals', async () => {
    const pending = await toPending('u-a-han', '80000'); // 80,000 USDC × 1,400 = 1.12억 원 → 2인 승인
    expect(pending.requiredApprovals).toBe(2);
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const seo = api(ctx.app, await login(ctx.app, 'u-a-seo'));
    const [r1, r2] = await Promise.all([
      oh.post(`/api/requests/${pending.id}/approve`, { version: pending.version, intentHash: pending.intentHash }),
      seo.post(`/api/requests/${pending.id}/approve`, { version: pending.version, intentHash: pending.intentHash }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('VERSION_CONFLICT');
    const cur = await oh.get(`/api/requests/${pending.id}`);
    expect(cur.body.status).toBe('PENDING_APPROVAL');
    expect(cur.body.approvedCount).toBe(1);
    const again = await (r1.status === 200 ? oh : seo).post(`/api/requests/${pending.id}/approve`, { version: cur.body.version, intentHash: cur.body.intentHash });
    expect(again.body.error.code).toBe('ALREADY_DECIDED');
    const second = await (r1.status === 200 ? seo : oh).post(`/api/requests/${pending.id}/approve`, { version: cur.body.version, intentHash: cur.body.intentHash });
    expect(second.body.status).toBe('PROCESSING');
  });

  it('is idempotent for duplicate create and approve submissions', async () => {
    const s = await login(ctx.app, 'u-a-han');
    const a = api(ctx.app, s);
    const k = key();
    const body = { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '10', purpose: '중복 제출 테스트' };
    const [x, y] = await Promise.all([a.post('/api/requests', body, { 'idempotency-key': k }), a.post('/api/requests', body, { 'idempotency-key': k })]);
    expect(x.body.id).toBe(y.body.id);
    expect([x.headers['idempotent-replayed'], y.headers['idempotent-replayed']]).toContain('true');
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM withdrawal_requests WHERE purpose = '중복 제출 테스트'").get() as any).c).toBe(1);
    const diff = await a.post('/api/requests', { ...body, amount: '11' }, { 'idempotency-key': k });
    expect(diff.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await a.post('/api/requests', body)).body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const pending = await toPending();
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const ak = key();
    const p1 = await oh.post(`/api/requests/${pending.id}/approve`, { version: pending.version, intentHash: pending.intentHash }, { 'idempotency-key': ak });
    const p2 = await oh.post(`/api/requests/${pending.id}/approve`, { version: pending.version, intentHash: pending.intentHash }, { 'idempotency-key': ak });
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(p2.headers['idempotent-replayed']).toBe('true');
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM approvals WHERE request_id = ?').get(pending.id) as any).c).toBe(1);
  });

  it('validates amount precision, available balance and address/network match on the server', async () => {
    const prec = (await newDraft(ctx, 'u-a-han', { amount: '1.1234567' })).r;
    expect(prec.body.error.code).toBe('AMOUNT_PRECISION');
    expect(prec.body.error.fields[0].field).toBe('amount');
    const mismatch = (await newDraft(ctx, 'u-a-han', { networkCode: 'KAIA', addressId: 'ab-01' })).r;
    expect(mismatch.body.error.code).toBe('ADDRESS_NETWORK_MISMATCH');
    const unsupported = (await newDraft(ctx, 'u-a-han', { assetCode: 'BTC', networkCode: 'ETHEREUM' })).r;
    expect(unsupported.body.error.code).toBe('ASSET_NETWORK_UNSUPPORTED');
    const pendingAddr = (await newDraft(ctx, 'u-a-han', { addressId: 'ab-08' })).r;
    expect(pendingAddr.body.error.code).toBe('ADDRESS_NOT_ACTIVE');
    const { s, r } = await newDraft(ctx, 'u-a-han', { amount: '99999999' });
    expect(r.status).toBe(201);
    const rv = await api(ctx.app, s).post(`/api/requests/${r.body.id}/review`, { version: r.body.version });
    expect(rv.body.error.code).toBe('INSUFFICIENT_AVAILABLE');
    const { s: s2, r: r2 } = await newDraft();
    const a2 = api(ctx.app, s2);
    const rv2 = await a2.post(`/api/requests/${r2.body.id}/review`, { version: r2.body.version });
    const wrongTail = await a2.post(`/api/requests/${r2.body.id}/submit`, { version: rv2.body.version, confirmTail: 'ZZZZZZ', ackIrreversible: true });
    expect(wrongTail.body.error.code).toBe('CONFIRM_TAIL_MISMATCH');
    const noAck = await a2.post(`/api/requests/${r2.body.id}/submit`, { version: rv2.body.version, confirmTail: tail(r2.body.address.address) });
    expect(noAck.status).toBe(422);
  });

  it('rejects approval when the destination address was disabled after submission', async () => {
    const pending = await toPending();
    const admin = api(ctx.app, await login(ctx.app, 'u-a-yoon'));
    const addr = await admin.get('/api/addresses/ab-01');
    expect((await admin.post('/api/addresses/ab-01/disable', { version: addr.body.version })).status).toBe(200);
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const r = await oh.post(`/api/requests/${pending.id}/approve`, { version: pending.version, intentHash: pending.intentHash });
    expect(r.body.error.code).toBe('ADDRESS_NOT_ACTIVE');
  });
});

describe('주소록', () => {
  it('runs check → create (pending) → second-person review → usable', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const chk = await han.post('/api/addresses/check', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: NEW_EVM, memo: '' });
    expect(chk.status).toBe(200);
    expect(chk.body.findings.map((f: any) => f.code)).toContain('ADDRESS_SHARED_FORMAT');
    const body = { label: '신규 테스트 주소', counterparty: '테스트 상대방', assetCode: 'USDC', networkCode: 'ETHEREUM', address: NEW_EVM, memo: '', confirmTail: tail(NEW_EVM), confirmMiddle: middle(NEW_EVM), ackNotVerified: true, ackOutOfBandConfirmed: true, receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호' };
    const cr = await han.post('/api/addresses', body);
    expect(cr.status).toBe(201);
    expect(cr.body.address.status).toBe('PENDING_REVIEW');
    const id = cr.body.address.id;
    const self = await api(ctx.app, await login(ctx.app, 'u-a-kang')).post(`/api/addresses/${id}/review`, { decision: 'approve', version: 1, confirmTail: tail(NEW_EVM), confirmMiddle: middle(NEW_EVM) });
    expect(self.status).toBe(200); // 강도윤은 등록자가 아니므로 가능
    const hanSelf = await api(ctx.app, await login(ctx.app, 'u-a-oh')).post(`/api/addresses/${id}/review`, { decision: 'approve', version: 1, confirmTail: tail(NEW_EVM), confirmMiddle: middle(NEW_EVM) });
    expect(hanSelf.status).toBe(409);
    const dup = await han.post('/api/addresses', body);
    expect(dup.body.error.code).toBe('ADDRESS_DUPLICATE');
  });
  it('prevents the registrant from confirming their own address', async () => {
    const kang = api(ctx.app, await login(ctx.app, 'u-a-kang'));
    const r = await kang.post('/api/addresses/ab-09/review', { decision: 'approve', version: 1, confirmTail: 'x' });
    expect(r.body.error.code).toBe('SELF_REVIEW_FORBIDDEN');
  });
  it('rejects network mismatch, missing memo and wrong confirmation tail', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const base = { label: 'x', counterparty: 'y', confirmTail: '000000', confirmMiddle: '00000000', ackNotVerified: true, ackOutOfBandConfirmed: true, memo: '', receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호' };
    const mm = await han.post('/api/addresses', { ...base, assetCode: 'BTC', networkCode: 'BITCOIN', address: NEW_EVM });
    expect(mm.body.error.code).toBe('ADDRESS_NETWORK_MISMATCH');
    expect(mm.body.error.message).toContain('Ethereum');
    const memo = await han.post('/api/addresses', { ...base, assetCode: 'XRP', networkCode: 'XRPL', address: 'MOCK-XRP-ABCDEFGHJKLMNPQRSTUV' });
    expect(memo.body.error.code).toBe('MEMO_REQUIRED');
    const t = await han.post('/api/addresses', { ...base, assetCode: 'USDC', networkCode: 'ETHEREUM', address: NEW_EVM });
    expect(t.body.error.code).toBe('CONFIRM_TAIL_MISMATCH');
    const ack = await han.post('/api/addresses', { ...base, ackNotVerified: false, assetCode: 'USDC', networkCode: 'ETHEREUM', address: NEW_EVM, confirmTail: tail(NEW_EVM) });
    expect(ack.status).toBe(422);
    expect(ack.body.error.code).toBe('VALIDATION');
  });
  it('rejects a wrong middle segment at create and at review (CONFIRM_MIDDLE_MISMATCH)', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const body = { label: '가운데 확인 주소', counterparty: '모의 상대방', assetCode: 'USDC', networkCode: 'ETHEREUM', address: NEW_EVM, memo: '', confirmTail: tail(NEW_EVM), ackNotVerified: true, ackOutOfBandConfirmed: true, receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호' };
    const missing = await han.post('/api/addresses', body);
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields.map((f: any) => f.field)).toContain('confirmMiddle');
    const wrong = await han.post('/api/addresses', { ...body, confirmMiddle: 'ZZZZZZZZ' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('CONFIRM_MIDDLE_MISMATCH');
    expect(wrong.body.error.fields[0].field).toBe('confirmMiddle');
    expect(wrong.body.error.message).toContain('17~24');
    const cr = await han.post('/api/addresses', { ...body, confirmMiddle: middle(NEW_EVM).toLowerCase() }); // 대소문자 무시
    expect(cr.status).toBe(201);
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const bad = await oh.post(`/api/addresses/${cr.body.address.id}/review`, { decision: 'approve', version: 1, confirmTail: tail(NEW_EVM), confirmMiddle: 'FFFFFFFF' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('CONFIRM_MIDDLE_MISMATCH');
    expect(bad.body.error.fields[0].field).toBe('confirmMiddle');
    const noMid = await oh.post(`/api/addresses/${cr.body.address.id}/review`, { decision: 'approve', version: 1, confirmTail: tail(NEW_EVM) });
    expect(noMid.body.error.code).toBe('CONFIRM_MIDDLE_MISMATCH');
    // 끝자리 불일치는 이전과 같이 먼저 걸린다
    const badTail = await oh.post(`/api/addresses/${cr.body.address.id}/review`, { decision: 'approve', version: 1, confirmTail: 'ZZZZZZ', confirmMiddle: middle(NEW_EVM) });
    expect(badTail.body.error.code).toBe('CONFIRM_TAIL_MISMATCH');
    expect((await oh.get(`/api/addresses/${cr.body.address.id}`)).body.status).toBe('PENDING_REVIEW');
    const ok = await oh.post(`/api/addresses/${cr.body.address.id}/review`, { decision: 'approve', version: 1, confirmTail: tail(NEW_EVM), confirmMiddle: middle(NEW_EVM) });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ACTIVE');
  });
  it('filters and returns an empty result without error', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    // 시드: 모의법인 A 주소 14건(ab-02의 유사 주소 예시 ab-13, 사용 대기 예시 ab-14 포함), 확인 대기 3건(ab-08, ab-09, ab-13), 사용 대기 1건(ab-14)
    expect((await han.get('/api/addresses')).body.items.length).toBe(14);
    expect((await han.get('/api/addresses?status=PENDING_REVIEW')).body.items.length).toBe(3);
    expect((await han.get('/api/addresses?status=COOLING_DOWN')).body.items.length).toBe(1);
    expect((await han.get('/api/addresses?q=' + encodeURIComponent('존재하지않는검색어'))).body.items).toEqual([]);
    expect((await han.get('/api/addresses?q=%25')).body.items).toEqual([]);
  });
});

describe('목록 탐색', () => {
  it('paginates activity with first/last page and filters', async () => {
    const a = api(ctx.app, await login(ctx.app, 'u-a-han'));
    // 시드: 모의법인 A 거래 138건(주소 오염 예시 0원 입금 1건 포함)
    const p1 = await a.get('/api/activity?page=1&pageSize=25');
    expect(p1.body.total).toBe(138);
    expect(p1.body.items.length).toBe(25);
    const last = await a.get('/api/activity?page=6&pageSize=25');
    expect(last.body.items.length).toBe(13);
    const beyond = await a.get('/api/activity?page=99&pageSize=25');
    expect(beyond.body.items).toEqual([]);
    const bad = await a.get('/api/activity?pageSize=13');
    expect(bad.status).toBe(422);
    const dep = await a.get('/api/activity?type=deposit&pageSize=100');
    expect(dep.body.items.every((x: any) => x.type === 'deposit')).toBe(true);
    const asc = await a.get('/api/activity?order=asc&pageSize=10');
    expect(asc.body.items[0].occurredAt <= asc.body.items[9].occurredAt).toBe(true);
  });
});

describe('감사 기록', () => {
  it('is append-only at the storage layer and the hash chain verifies', async () => {
    expect(() => ctx.db.prepare("UPDATE audit_log SET summary = 'x'").run()).toThrow(/AUDIT_LOG_APPEND_ONLY/);
    expect(() => ctx.db.prepare('DELETE FROM audit_log').run()).toThrow(/AUDIT_LOG_APPEND_ONLY/);
    const aud = api(ctx.app, await login(ctx.app, 'u-a-moon'));
    const v = await aud.get('/api/audit/verify');
    expect(v.body.ok).toBe(true);
    expect(v.body.count).toBeGreaterThan(10);
  });
  it('exports CSV for auditors with formula neutralisation and audits the export', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    await han.post('/api/addresses', { label: '=HYPERLINK("http://evil")', counterparty: '+cmd', assetCode: 'USDC', networkCode: 'ETHEREUM', address: NEW_EVM, memo: '', confirmTail: tail(NEW_EVM), confirmMiddle: middle(NEW_EVM), ackNotVerified: true, ackOutOfBandConfirmed: true, receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호' });
    const aud = await login(ctx.app, 'u-a-moon');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/audit/export.csv', headers: { cookie: aud.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).not.toMatch(/,=HYPERLINK/);
    expect(res.body).toContain("주소 등록 요청: =HYPERLINK");
    const log = await api(ctx.app, aud).get('/api/audit?action=audit.exported');
    expect(log.body.total).toBe(1);
  });
  it('never stores session tokens or CSRF values in audit details', async () => {
    const s = await login(ctx.app, 'u-a-han');
    const rows = ctx.db.prepare('SELECT summary, detail FROM audit_log').all() as any[];
    const token = s.cookie.split('=')[1]!;
    expect(rows.some((r) => r.detail.includes(token) || r.detail.includes(s.csrf))).toBe(false);
  });
});

describe('오류 응답', () => {
  it('returns structured Korean errors with recovery actions and no stack traces', async () => {
    const a = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const r = await a.post('/api/requests', { assetCode: '' }, { 'idempotency-key': key() });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBeTruthy();
    expect(r.body.error.action).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts:\d+/);
    const nf = await a.get('/api/nope');
    expect(nf.status).toBe(404);
  });
  it('maps unexpected failures to a safe 500 without partial writes', async () => {
    const a = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const before = (ctx.db.prepare('SELECT COUNT(*) c FROM withdrawal_requests').get() as any).c;
    ctx.db.exec("CREATE TRIGGER boom BEFORE INSERT ON audit_log WHEN NEW.action = 'request.created' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;");
    const r = await a.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '1', purpose: '실패 시뮬레이션' }, { 'idempotency-key': key() });
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL');
    expect(r.body.error.message).toContain('저장되지 않았습니다');
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM withdrawal_requests').get() as any).c).toBe(before);
  });
});

describe('Market Insight', () => {
  it('shows only published items from whitelisted providers and enforces whitelist on publish', async () => {
    const a = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const list = await a.get('/api/insights?limit=50');
    expect(list.body.total).toBe(24);
    expect(list.body.items.every((x: any) => x.providerWhitelisted && x.status === 'published')).toBe(true);
    expect(list.body.disclosure).toContain('투자 권유가 아닙니다');
    const op = api(ctx.app, await login(ctx.app, 'u-k-op'));
    const base = { title: '모의 자료', summary: '요약', language: 'ko', publishedAt: '2026-10-19', url: 'https://example.com/x' };
    expect((await op.post('/api/insights', { ...base, providerId: 'prov-x' })).body.error.code).toBe('PROVIDER_NOT_WHITELISTED');
    expect((await op.post('/api/insights', { ...base, providerId: 'prov-a', url: 'javascript:alert(1)' })).status).toBe(422);
    expect((await op.post('/api/insights', { ...base, providerId: 'prov-a' })).status).toBe(201);
    expect((await a.get('/api/insights?limit=50')).body.total).toBe(25);
  });
});

describe('실험: 보유 자산 관련 자료', () => {
  it('is off by default and filters only by own held asset codes when enabled', async () => {
    const a = api(ctx.app, await login(ctx.app, 'u-a-han'));
    expect((await a.get('/api/insights?related=1')).body.error.code).toBe('EXPERIMENT_DISABLED');
    const on = await makeApp({ holdingRelated: true });
    const b = api(on.app, await login(on.app, 'u-b-bae')); // 모의법인 B: ETH·USDC 보유
    const r = await b.get('/api/insights?related=1&limit=50');
    expect(r.body.total).toBeGreaterThan(0);
    expect(r.body.items.every((i: any) => i.assetTags.some((t: string) => ['ETH', 'USDC'].includes(t)))).toBe(true);
    await on.app.close(); on.db.close();
  });
});

describe('새로고침·재시작 후 상태 유지', () => {
  it('persists requests and sessions in the database file across app restarts', async () => {
    const file = path.join(os.tmpdir(), `koda-test-${Date.now()}.sqlite`);
    const mk = async () => {
      const cfg = loadConfig({ dbPath: file, logLevel: 'silent', serveClient: false });
      const db = openDb(file);
      migrate(db);
      if ((db.prepare('SELECT COUNT(*) c FROM organizations').get() as any).c === 0) seed(db);
      return { db, app: await buildApp({ cfg, db, custody: new MockCustodyAdapter(0) }) };
    };
    const one = await mk();
    const s = await login(one.app, 'u-a-han');
    const cr = await api(one.app, s).post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '1', purpose: '재시작 테스트' }, { 'idempotency-key': key() });
    await one.app.close(); one.db.close();
    const two = await mk();
    const got = await api(two.app, s).get(`/api/requests/${cr.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.purpose).toBe('재시작 테스트');
    await two.app.close(); two.db.close();
    for (const sfx of ['', '-wal', '-shm']) rmSync(file + sfx, { force: true });
  });
});

describe('요청 한도', () => {
  it('rate-limits excessive requests with a recovery message', async () => {
    const small = await makeApp({ rateLimitMax: 5 });
    let last: any;
    for (let i = 0; i < 7; i++) last = await small.app.inject({ method: 'GET', url: '/api/healthz' });
    expect(last.statusCode).toBe(429);
    expect(last.json().error.code).toBe('RATE_LIMITED');
    await small.app.close(); small.db.close();
  });
  it('limits dev-login attempts separately (default 30/min, configurable)', async () => {
    const def = await makeApp();
    const before = await def.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { userId: 'u-a-han' } });
    expect(before.headers['x-ratelimit-limit']).toBe('30');
    await def.app.close(); def.db.close();
    const small = await makeApp({ loginRateLimitMax: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await small.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { userId: 'u-a-han' } })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    await small.app.close(); small.db.close();
  });
});