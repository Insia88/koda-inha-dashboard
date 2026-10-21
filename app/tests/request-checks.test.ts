// WP-11 승인 대상 지문(F10)·출금 전 점검(F8·F13·F14)·사용 대기 주소 안내·감사 기록 CSV(한국 시간·행동 이름).
// 근거: .research/security-incidents-UX.md 6장 8·10·13·14번, 5장 표현 원칙. 기준값은 설계 가정이다(docs/assumptions.md A-27~A-30).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, key, login, splitAuditCsv, type TestCtx } from './helpers.ts';
import { APP_ROOT, loadConfig } from '../server/config.ts';
import { migrate, openDb, type DB } from '../server/db.ts';
import { seed } from '../server/seed.ts';
import { buildApp } from '../server/app.ts';
import { verifyChain } from '../server/audit.ts';
import { kstDateTime } from '../server/csv.ts';
import { MockCustodyAdapter, type WithdrawalSubmission } from '../server/adapters/custody.ts';
import {
  canonicalJson, checkThresholds, computeChecks, DEFAULT_WITHDRAWAL_CHECKS, INTENT_VERSION, intentFieldsOf, intentHashDisplay, intentHashOf, type IntentFields,
} from '../server/domain/checks.ts';
import { ACTION_LABEL, CHECK_OUTCOME, type RequestCheck } from '../shared/terms.ts';

class CountingCustody extends MockCustodyAdapter {
  calls = 0;
  inputs: WithdrawalSubmission[] = [];
  override submitWithdrawal(input: WithdrawalSubmission) {
    this.calls += 1;
    this.inputs.push(input);
    return super.submitWithdrawal(input);
  }
}

let ctx: TestCtx & { custody: CountingCustody };
beforeEach(async () => {
  const cfg = loadConfig({ dbPath: ':memory:', logLevel: 'silent', serveClient: false, rateLimitMax: 10000 });
  cfg.policy.mockCustodyProcessingMs = 0;
  cfg.policy.addressBook.cooldownHours = 0;
  const db = openDb(':memory:');
  migrate(db);
  seed(db);
  const custody = new CountingCustody(0);
  const app = await buildApp({ cfg, db, custody });
  ctx = { app, db, custody };
});
afterEach(async () => { await ctx.app.close(); ctx.db.close(); });

const tail = (addr: string) => addr.slice(-6);

/** 요청자가 초안 → 검토까지 진행한다. */
async function toReview(userId = 'u-a-han', body: Record<string, unknown> = {}) {
  const a = api(ctx.app, await login(ctx.app, userId));
  const cr = await a.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '100', purpose: 'WP-11 점검 테스트', ...body }, { 'idempotency-key': key() });
  expect(cr.status, JSON.stringify(cr.body)).toBe(201);
  const rv = await a.post(`/api/requests/${cr.body.id}/review`, { version: cr.body.version });
  expect(rv.status, JSON.stringify(rv.body)).toBe(200);
  return { a, r: rv.body };
}

async function toPending(userId = 'u-a-han', body: Record<string, unknown> = {}, checkReasons: Record<string, string> = {}) {
  const { a, r } = await toReview(userId, body);
  const sub = await a.post(`/api/requests/${r.id}/submit`, { version: r.version, confirmTail: tail(r.address.address), ackIrreversible: true, checkReasons });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return sub.body;
}

const byId = (items: RequestCheck[], id: string) => items.find((c) => c.id === id)!;
const auditRows = (db: DB, id: string, action: string) => db.prepare('SELECT summary, detail, actor_name FROM audit_log WHERE target_id = ? AND action = ? ORDER BY seq').all(id, action) as { summary: string; detail: string; actor_name: string }[];

function sampleFields(over: Partial<IntentFields> = {}): IntentFields {
  return {
    v: 1, requestId: 'r-1', orgId: 'org-a', assetCode: 'USDC', networkCode: 'ETHEREUM', amountUnits: '100000000', addressId: 'ab-01',
    address: 'MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678', memo: '', requiredApprovals: 1, ...over,
  };
}

describe('승인 대상 지문: 계산', () => {
  it('is deterministic over canonical JSON with sorted keys, regardless of key order', () => {
    const f = sampleFields();
    const shuffled = Object.fromEntries(Object.entries(f).reverse()) as unknown as IntentFields;
    expect(canonicalJson(shuffled)).toBe(canonicalJson(f));
    expect(canonicalJson(f)).toBe('{"address":"MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678","addressId":"ab-01","amountUnits":"100000000","assetCode":"USDC","memo":"","networkCode":"ETHEREUM","orgId":"org-a","requestId":"r-1","requiredApprovals":1,"v":1}');
    const expected = createHash('sha256').update(canonicalJson(f), 'utf8').digest('hex');
    expect(intentHashOf(f)).toBe(expected);
    expect(intentHashOf(shuffled)).toBe(expected);
    expect(intentHashOf(sampleFields())).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any bound field changes', () => {
    const base = intentHashOf(sampleFields());
    const changes: Partial<IntentFields>[] = [
      { amountUnits: '100000001' }, { address: 'MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345679' }, { memo: '1234567' }, { networkCode: 'KAIA' },
      { assetCode: 'ETH' }, { addressId: 'ab-07' }, { requiredApprovals: 2 }, { requestId: 'r-2' }, { orgId: 'org-b' }, { v: 2 },
    ];
    const seen = new Set([base]);
    for (const c of changes) {
      const h = intentHashOf(sampleFields(c));
      expect(h, JSON.stringify(c)).not.toBe(base);
      seen.add(h);
    }
    expect(seen.size).toBe(changes.length + 1);
  });

  it('normalizes the address by network family before hashing (EVM case-insensitive, others as stored)', () => {
    const row = { id: 'r-1', org_id: 'org-a', asset_code: 'USDC', network_code: 'ETHEREUM', amount_units: '100', address_id: 'ab-01', address_memo: '', required_approvals: 1 };
    const upper = intentFieldsOf({ ...row, address_value: ' MOCK-EVM-ABCDEF0123456789ABCDEF0123456789ABCD9876 ', network_family: 'MOCK_EVM' });
    const lower = intentFieldsOf({ ...row, address_value: 'mock-evm-abcdef0123456789abcdef0123456789abcd9876', network_family: 'MOCK_EVM' });
    expect(intentHashOf(lower)).toBe(intentHashOf(upper));
    const btcA = intentFieldsOf({ ...row, address_value: 'MOCK-BTC-ABCDEFGHJKLMNPQRSTUV', network_family: 'MOCK_BTC' });
    const btcB = intentFieldsOf({ ...row, address_value: 'MOCK-BTC-abcdefghjklmnpqrstuv', network_family: 'MOCK_BTC' });
    expect(intentHashOf(btcA)).not.toBe(intentHashOf(btcB));
    expect(upper.v).toBe(INTENT_VERSION);
  });

  it('shows the first 16 hex characters in upper case, in four groups of four', () => {
    const h = intentHashOf(sampleFields());
    const d = intentHashDisplay(h)!;
    expect(d).toMatch(/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
    expect(d.replace(/ /g, '')).toBe(h.slice(0, 16).toUpperCase());
    expect(intentHashDisplay(null)).toBeNull();
    expect(intentHashDisplay('xyz')).toBeNull();
  });
});

describe('승인 대상 지문: 제출·승인·반려', () => {
  it('fixes the fingerprint at submit, exposes it with a display form, and records it in the audit detail', async () => {
    const { r } = await toReview();
    expect(r.intentHash).toBeNull(); // 제출 전에는 지문이 없다
    const a = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const sub = await a.post(`/api/requests/${r.id}/submit`, { version: r.version, confirmTail: tail(r.address.address), ackIrreversible: true });
    expect(sub.status).toBe(200);
    const p = sub.body;
    expect(p.intentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.intentHashDisplay).toBe(intentHashDisplay(p.intentHash));
    const expected = intentHashOf({
      v: 1, requestId: p.id, orgId: 'org-a', assetCode: 'USDC', networkCode: 'ETHEREUM', amountUnits: p.amountUnits, addressId: 'ab-01',
      address: p.address.address, memo: '', requiredApprovals: p.requiredApprovals,
    });
    expect(p.intentHash).toBe(expected);
    const stored = ctx.db.prepare('SELECT intent_hash, intent_version FROM request_intents WHERE request_id = ?').get(p.id) as any;
    expect(stored).toEqual({ intent_hash: expected, intent_version: 1 });
    const [submitted] = auditRows(ctx.db, p.id, 'request.submitted');
    expect(JSON.parse(submitted!.detail).intentHash).toBe(expected);
    expect(submitted!.summary).toContain(`지문 ${p.intentHashDisplay}`);
    // 목록·다른 사람의 조회에도 같은 지문
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    expect((await oh.get(`/api/requests/${p.id}`)).body.intentHashDisplay).toBe(p.intentHashDisplay);
    const list = await oh.get('/api/requests?view=to_approve&pageSize=100');
    expect(list.body.items.find((x: any) => x.id === p.id).intentHash).toBe(expected);
    // 기록은 바꾸거나 지울 수 없다
    expect(() => ctx.db.prepare("UPDATE request_intents SET intent_hash = ? WHERE request_id = ?").run('0'.repeat(64), p.id)).toThrow(/REQUEST_INTENT_IMMUTABLE/);
    expect(() => ctx.db.prepare('DELETE FROM request_intents WHERE request_id = ?').run(p.id)).toThrow(/REQUEST_INTENT_IMMUTABLE/);
  });

  it('refuses approve and reject with a different fingerprint (409 INTENT_CHANGED) or none (422), and keeps the request pending', async () => {
    const p = await toPending();
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const wrong = 'a'.repeat(64);
    for (const [path, body] of [['approve', {}], ['reject', { reason: '수량이 정산서와 다릅니다' }]] as const) {
      const bad = await oh.post(`/api/requests/${p.id}/${path}`, { version: p.version, intentHash: wrong, ...body });
      expect(bad.status, path).toBe(409);
      expect(bad.body.error.code).toBe('INTENT_CHANGED');
      expect(bad.body.error.message).toContain('승인 대상 지문');
      expect(bad.body.error.action).toBeTruthy();
      const none = await oh.post(`/api/requests/${p.id}/${path}`, { version: p.version, ...body });
      expect(none.status, path).toBe(422);
      expect(none.body.error.fields).toEqual([expect.objectContaining({ field: 'intentHash' })]);
    }
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM approvals WHERE request_id = ?').get(p.id) as any).c).toBe(0);
    expect((await oh.get(`/api/requests/${p.id}`)).body.status).toBe('PENDING_APPROVAL');
    expect(ctx.custody.calls).toBe(0);

    // 화면에 보인 지문을 그대로 보내면 승인되고, 커스터디에도 같은 지문이 넘어간다. 승인 표에 지문이 남는다.
    const ok = await oh.post(`/api/requests/${p.id}/approve`, { version: p.version, intentHash: p.intentHash.toUpperCase() });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('PROCESSING');
    expect(ctx.custody.calls).toBe(1);
    expect(ctx.custody.inputs[0]!.intentHash).toBe(p.intentHash);
    expect(ctx.custody.intentFor(p.id)).toBe(p.intentHash);
    expect(ok.body.approvals).toEqual([expect.objectContaining({ userId: 'u-a-oh', intentHash: p.intentHash, intentHashDisplay: p.intentHashDisplay })]);
    expect(JSON.parse(auditRows(ctx.db, p.id, 'request.processing')[0]!.detail).intentHash).toBe(p.intentHash);
    expect(() => ctx.db.prepare('UPDATE approval_intents SET intent_hash = NULL').run()).toThrow(/APPROVALS_IMMUTABLE/);
  });

  it('records the fingerprint on a rejection vote', async () => {
    const p = await toPending();
    const seo = api(ctx.app, await login(ctx.app, 'u-a-seo'));
    const rj = await seo.post(`/api/requests/${p.id}/reject`, { version: p.version, reason: '정산서와 수량이 다릅니다', intentHash: p.intentHash });
    expect(rj.status).toBe(200);
    expect(rj.body.status).toBe('REJECTED');
    expect(rj.body.approvals[0]).toMatchObject({ decision: 'rejected', intentHash: p.intentHash });
    expect(JSON.parse(auditRows(ctx.db, p.id, 'request.rejected')[0]!.detail).intentHash).toBe(p.intentHash);
  });
});

describe('커스터디 전달 직전 재확인(지문 변조)', () => {
  it('refuses the approval when the stored amount no longer matches the fingerprint: 409 INTENT_TAMPERED, audit record, custody never called', async () => {
    const p = await toPending();
    // 저장 계층에서 내용을 바꾼다(앱 경로를 거치지 않은 변경, 버전은 그대로)
    ctx.db.prepare("UPDATE withdrawal_requests SET amount_units = '999000000' WHERE id = ?").run(p.id);
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const r = await oh.post(`/api/requests/${p.id}/approve`, { version: p.version, intentHash: p.intentHash });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INTENT_TAMPERED');
    expect(r.body.error.action).toContain('반려');
    expect(JSON.stringify(r.body)).not.toContain('recomputedHash'); // 내부 기록은 응답에 싣지 않는다
    expect(ctx.custody.calls).toBe(0);
    const row = ctx.db.prepare('SELECT status, custody_ref, version FROM withdrawal_requests WHERE id = ?').get(p.id) as any;
    expect(row).toEqual({ status: 'PENDING_APPROVAL', custody_ref: null, version: p.version });
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM approvals WHERE request_id = ?').get(p.id) as any).c).toBe(0);
    const [rec] = auditRows(ctx.db, p.id, 'request.intent_tampered');
    expect(rec).toBeTruthy();
    const d = JSON.parse(rec!.detail);
    expect(d).toMatchObject({ stage: 'approve', storedHash: p.intentHash, custodyCalled: false, attemptedBy: { id: 'u-a-oh' } });
    expect(d.recomputedHash).not.toBe(p.intentHash);
    expect(d.current.amount).toBe('999');
    expect(rec!.actor_name).toContain('시스템');
    expect(rec!.detail).not.toContain(p.address.address); // 전체 주소는 남기지 않는다
    expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);
  });

  it('detects a changed destination address and still lets an approver reject the request', async () => {
    const p = await toPending();
    const changed = 'MOCK-EVM-' + 'F'.repeat(40);
    ctx.db.prepare("UPDATE address_book SET address = ? WHERE id = 'ab-01'").run(changed);
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const r = await oh.post(`/api/requests/${p.id}/approve`, { version: p.version, intentHash: p.intentHash });
    expect(r.body.error.code).toBe('INTENT_TAMPERED');
    expect(ctx.custody.calls).toBe(0);
    const rj = await oh.post(`/api/requests/${p.id}/reject`, { version: p.version, reason: '받는 주소가 승인 요청 때와 다릅니다', intentHash: p.intentHash });
    expect(rj.status).toBe(200);
    expect(rj.body.status).toBe('REJECTED');
  });

  it('refuses the hand-off when a counted vote was written without the fingerprint (stage handoff)', async () => {
    const p = await toPending('u-a-han', { amount: '80000' }); // 1.12억 원 → 2인 승인
    expect(p.requiredApprovals).toBe(2);
    // 앱을 거치지 않고 승인 표만 넣는다(지문 기록 없음)
    ctx.db.prepare("INSERT INTO approvals (request_id, user_id, decision, created_at) VALUES (?, 'u-a-oh', 'approved', ?)").run(p.id, new Date().toISOString());
    const seo = api(ctx.app, await login(ctx.app, 'u-a-seo'));
    const cur = (await seo.get(`/api/requests/${p.id}`)).body;
    const r = await seo.post(`/api/requests/${p.id}/approve`, { version: cur.version, intentHash: cur.intentHash });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INTENT_TAMPERED');
    expect(ctx.custody.calls).toBe(0);
    expect((ctx.db.prepare('SELECT status FROM withdrawal_requests WHERE id = ?').get(p.id) as any).status).toBe('PENDING_APPROVAL');
    const d = JSON.parse(auditRows(ctx.db, p.id, 'request.intent_tampered')[0]!.detail);
    expect(d).toMatchObject({ stage: 'handoff', mismatchedApproverIds: ['u-a-oh'] });
    expect(d.recomputedHash).toBe(p.intentHash); // 내용은 그대로이고 승인 표가 문제다
    // 서예린의 승인 표는 되돌려졌다
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM approvals WHERE request_id = ? AND user_id = 'u-a-seo'").get(p.id) as any).c).toBe(0);
  });

  it('refuses approval of a request submitted before fingerprints existed (409 INTENT_MISSING) but allows rejection', async () => {
    const t = new Date().toISOString();
    ctx.db.prepare(`INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, required_approvals, created_by, created_at, updated_at, submitted_at, version)
      VALUES ('wr-legacy', 'org-a', 'WR-LEGACY', 'w-a-eth', 'USDC', 'ETHEREUM', '1000000', 'ab-01', '이전 요청', 'PENDING_APPROVAL', 1, 'u-a-han', ?, ?, ?, 3)`).run(t, t, t);
    ctx.db.prepare("UPDATE balances SET reserved_units = '1000000' WHERE wallet_id = 'w-a-eth' AND asset_code = 'USDC'").run();
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const got = (await oh.get('/api/requests/wr-legacy')).body;
    expect(got.intentHash).toBeNull();
    expect(got.checks).toBeNull();
    expect(got.allowedActions).toEqual(['reject']);
    const ap = await oh.post('/api/requests/wr-legacy/approve', { version: 3, intentHash: null });
    expect(ap.status).toBe(409);
    expect(ap.body.error.code).toBe('INTENT_MISSING');
    const rj = await oh.post('/api/requests/wr-legacy/reject', { version: 3, reason: '지문 없는 이전 요청이라 반려합니다', intentHash: null });
    expect(rj.status).toBe(200);
    expect(rj.body.status).toBe('REJECTED');
    expect(ctx.custody.calls).toBe(0);
  });
});

describe('내용이 바뀐 요청: 조회 표시와 반려·취소 때의 예약 해제', () => {
  const reservedOf = (wallet = 'w-a-eth', asset = 'USDC') =>
    (ctx.db.prepare('SELECT reserved_units FROM balances WHERE wallet_id = ? AND asset_code = ?').get(wallet, asset) as any).reserved_units as string;
  const tamper = (id: string, set: string, value: string) => ctx.db.prepare(`UPDATE withdrawal_requests SET ${set} = ? WHERE id = ?`).run(value, id);

  it('records the reservation (wallet, asset, quantity) with the fingerprint at submit', async () => {
    const p = await toPending();
    const row = ctx.db.prepare('SELECT reserved_wallet_id, reserved_asset_code, reserved_units FROM request_intents WHERE request_id = ?').get(p.id) as any;
    expect(row).toEqual({ reserved_wallet_id: 'w-a-eth', reserved_asset_code: 'USDC', reserved_units: '100000000' });
    // 시드의 승인 대기 요청도 예약 기록이 있고, 지갑 예약 합계와 같다
    const seeded = ctx.db.prepare("SELECT ri.reserved_units, r.amount_units FROM request_intents ri JOIN withdrawal_requests r ON r.id = ri.request_id WHERE r.id IN ('wr-3', 'wr-4')").all() as any[];
    expect(seeded).toHaveLength(2);
    for (const s of seeded) expect(s.reserved_units).toBe(s.amount_units);
  });

  it('shows INTENT_TAMPERED on the request and drops approve when the stored content no longer matches the fingerprint', async () => {
    const p = await toPending();
    tamper(p.id, 'amount_units', '15000000000');
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const seen = (await oh.get(`/api/requests/${p.id}`)).body;
    expect(seen.blockedReason).toBe('INTENT_TAMPERED');
    expect(seen.allowedActions).toEqual(['reject']);
    expect(seen.intentHash).toBe(p.intentHash); // 제출 때 지문은 그대로 보인다(무엇이 고정되었는지)
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const mine = (await han.get(`/api/requests/${p.id}`)).body;
    expect(mine.blockedReason).toBe('INTENT_TAMPERED');
    expect(mine.allowedActions).toEqual(['cancel']);
    const list = (await oh.get('/api/requests?status=PENDING_APPROVAL&pageSize=100')).body.items.find((x: any) => x.id === p.id);
    expect(list.blockedReason).toBe('INTENT_TAMPERED');
    // 지문 불일치가 받는 주소 상태보다 먼저 보인다
    ctx.db.prepare("UPDATE address_book SET status = 'DISABLED' WHERE id = 'ab-01'").run();
    expect((await oh.get(`/api/requests/${p.id}`)).body.blockedReason).toBe('INTENT_TAMPERED');
    // 화면이 승인을 내보이지 않아도 서버의 거부는 그대로다
    const ap = await oh.post(`/api/requests/${p.id}/approve`, { version: p.version, intentHash: p.intentHash });
    expect(ap.status).toBe(409);
    expect(ap.body.error.code).toBe('INTENT_TAMPERED');
    expect(ctx.custody.calls).toBe(0);
  });

  it('keeps an untouched request free of blockedReason (fingerprint recomputed on read matches)', async () => {
    const p = await toPending();
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const seen = (await oh.get(`/api/requests/${p.id}`)).body;
    expect(seen.blockedReason).toBeNull();
    expect(seen.allowedActions).toEqual(['approve', 'reject']);
  });

  for (const [mode, changed] of [['reject', '1000000'], ['reject', '900000000'], ['cancel', '1000000'], ['cancel', '900000000']] as const) {
    it(`${mode}: releases exactly the quantity reserved at submit after the stored amount was changed to ${changed}`, async () => {
      const before = reservedOf();
      const p = await toPending(); // 100 USDC 예약
      expect(BigInt(reservedOf())).toBe(BigInt(before) + 100_000_000n);
      tamper(p.id, 'amount_units', changed);
      let res;
      if (mode === 'reject') {
        const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
        res = await oh.post(`/api/requests/${p.id}/reject`, { version: p.version, reason: '승인 요청 뒤 수량이 바뀌어 반려합니다', intentHash: p.intentHash });
      } else {
        const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
        res = await han.post(`/api/requests/${p.id}/cancel`, { version: p.version });
      }
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe(mode === 'reject' ? 'REJECTED' : 'CANCELLED');
      expect(reservedOf()).toBe(before);
      const detail = JSON.parse(auditRows(ctx.db, p.id, mode === 'reject' ? 'request.rejected' : 'request.cancelled')[0]!.detail);
      expect(detail).toMatchObject({ released: '100', releasedAssetCode: 'USDC', contentMatchesIntent: false });
      expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);
    });
  }

  it('leaves other pending reservations alone when a changed request is rejected', async () => {
    const before = reservedOf();
    const first = await toPending('u-a-han', { amount: '100' });
    const second = await toPending('u-a-han', { amount: '200' });
    expect(BigInt(reservedOf())).toBe(BigInt(before) + 300_000_000n);
    tamper(first.id, 'amount_units', '300000000'); // 두 요청의 예약 합계와 같은 값으로 바꾼다
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const rj = await oh.post(`/api/requests/${first.id}/reject`, { version: first.version, reason: '승인 요청 뒤 수량이 바뀌어 반려합니다', intentHash: first.intentHash });
    expect(rj.status).toBe(200);
    // 200 USDC 요청의 예약은 그대로 남는다(사용 가능 수량이 부풀지 않는다)
    expect(BigInt(reservedOf())).toBe(BigInt(before) + 200_000_000n);
    const rj2 = await oh.post(`/api/requests/${second.id}/reject`, { version: second.version, reason: '정리를 위해 반려합니다', intentHash: second.intentHash });
    expect(rj2.status).toBe(200);
    expect(reservedOf()).toBe(before);
  });

  it('releases the reservation on the wallet and asset that were reserved, even when the stored asset was changed', async () => {
    const usdcBefore = reservedOf('w-a-eth', 'USDC');
    const ethBefore = reservedOf('w-a-eth', 'ETH');
    const p = await toPending();
    tamper(p.id, 'asset_code', 'ETH');
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    expect((await oh.get(`/api/requests/${p.id}`)).body.blockedReason).toBe('INTENT_TAMPERED');
    const rj = await oh.post(`/api/requests/${p.id}/reject`, { version: p.version, reason: '승인 요청 뒤 자산이 바뀌어 반려합니다', intentHash: p.intentHash });
    expect(rj.status, JSON.stringify(rj.body)).toBe(200);
    expect(reservedOf('w-a-eth', 'USDC')).toBe(usdcBefore);
    expect(reservedOf('w-a-eth', 'ETH')).toBe(ethBefore);
  });
});

describe('출금 전 점검 규칙', () => {
  const preview = async (body: Record<string, unknown>, userId = 'u-a-han') => {
    const a = api(ctx.app, await login(ctx.app, userId));
    const r = await a.post('/api/requests/checks-preview', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '100', ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.items as RequestCheck[];
  };
  /** ab-01로 처리 완료된 출금 요청을 저장 계층에 직접 넣는다(과거 기록). */
  const completed = (amounts: string[]) => {
    const t = new Date(Date.now() - 10 * 86400_000).toISOString();
    amounts.forEach((amt, i) => ctx.db.prepare(`INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, created_by, created_at, updated_at, submitted_at, completed_at)
      VALUES (?, 'org-a', ?, 'w-a-eth', 'USDC', 'ETHEREUM', ?, 'ab-01', '과거 정산', 'COMPLETED', 'u-a-han', ?, ?, ?, ?)`).run(`hist-${i}`, `WR-H${i}`, (BigInt(amt) * 1_000_000n).toString(), t, t, t, t));
  };

  it('returns the five checks in a fixed order, each with label, detail and basis', async () => {
    const items = await preview({});
    expect(items.map((c) => c.id)).toEqual(['first_use', 'amount_history', 'balance_share', 'recent_burst', 'price']);
    for (const c of items) {
      expect(c.label.length, c.id).toBeGreaterThan(3);
      expect(c.detail.length, c.id).toBeGreaterThan(10);
      expect(c.basis.length, c.id).toBeGreaterThan(5);
    }
  });

  it('first use: caution with a small test transfer suggestion and a required reason; an address with a completed withdrawal is within the criterion', async () => {
    const first = byId(await preview({ addressId: 'ab-07' }), 'first_use');
    expect(first).toMatchObject({ outcome: 'caution', label: '이 대시보드로 처음 보내는 주소입니다', requiresReason: true });
    expect(first.detail).toContain('소액을 시험 전송');
    // 무엇을 세었는지(이 대시보드의 출금 요청)와 세지 않은 것(자산 활동 내역의 출금)을 함께 밝힌다. 다른 화면과 어긋나는 단정을 하지 않는다.
    expect(first.detail).toContain('이 대시보드의 출금 요청으로');
    expect(first.detail).toContain('자산 활동 내역의 이전 출금은 받는 주소가 기록되지 않아 세지 않았습니다');
    expect(first.basis).toContain('이 대시보드');
    const known = byId(await preview({ addressId: 'ab-01' }), 'first_use'); // 시드 WR-000001이 ab-01로 처리 완료
    expect(known).toMatchObject({ outcome: 'pass', label: '이 대시보드로 보낸 적이 있는 주소입니다', requiresReason: false });
    expect(known.detail).toContain('1건');
  });

  it('amount vs history: unknown below 3 completed withdrawals, caution only above 5× the median', async () => {
    const few = byId(await preview({}), 'amount_history');
    expect(few).toMatchObject({ outcome: 'unknown', label: '확인 불가(과거 출금 부족)', requiresReason: false });
    completed(['100', '200', '300']); // + 시드 50,000 → 중앙값 (200+300)/2 = 250 USDC
    const at = byId(await preview({ amount: '1250' }), 'amount_history'); // 정확히 5배는 넘지 않음
    expect(at.outcome).toBe('pass');
    expect(at.detail).toContain('250 USDC');
    const above = byId(await preview({ amount: '1250.000001' }), 'amount_history');
    expect(above).toMatchObject({ outcome: 'caution', requiresReason: true });
    expect(above.detail).toContain('중앙값은 250 USDC');
    expect(above.detail).toContain('5배');
    const far = byId(await preview({ amount: '3125' }), 'amount_history');
    expect(far.detail).toContain('12.5배');
  });

  it('balance share: caution at or above 50% of the available quantity', async () => {
    // w-a-eth USDC 1,250,000 보유, 예약 없음
    const below = byId(await preview({ amount: '624999.999999' }), 'balance_share');
    expect(below).toMatchObject({ outcome: 'pass', requiresReason: false });
    expect(below.detail).toContain('49.9%');
    const at = byId(await preview({ amount: '625000' }), 'balance_share');
    expect(at).toMatchObject({ outcome: 'caution', requiresReason: true });
    expect(at.detail).toContain('50%');
    expect(at.detail).toContain('1,250,000 USDC');
  });

  it('balance share: more than the available quantity is called out as a shortage, not as a large share to split', async () => {
    const over = byId(await preview({ amount: '2000000' }), 'balance_share');
    expect(over).toMatchObject({ outcome: 'caution', label: '사용 가능 수량보다 많이 보내려고 합니다', requiresReason: true });
    expect(over.detail).toContain('1,250,000 USDC');
    expect(over.detail).toContain('2,000,000 USDC');
    expect(over.detail).toContain('예약된 수량');
    expect(over.detail).not.toContain('나누어');
    expect(over.detail).not.toMatch(/%/);
    // 사용 가능 수량과 같으면 아직 비율 문장이다(100%)
    const all = byId(await preview({ amount: '1250000' }), 'balance_share');
    expect(all.label).toBe('사용 가능 수량의 큰 부분을 한 번에 보냅니다');
    expect(all.detail).toContain('100%');
  });

  it('recent burst: caution (no reason required) when 3 or more requests for the same asset were made in the last 60 minutes', async () => {
    const one = byId(await preview({}), 'recent_burst');
    expect(one).toMatchObject({ outcome: 'pass' });
    expect(one.detail).toContain('1건');
    const a = api(ctx.app, await login(ctx.app, 'u-a-kang'));
    for (let i = 0; i < 2; i++) {
      expect((await a.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '1', purpose: `연속 요청 ${i}` }, { 'idempotency-key': key() })).status).toBe(201);
    }
    const burst = byId(await preview({}), 'recent_burst');
    expect(burst).toMatchObject({ outcome: 'caution', requiresReason: false });
    expect(burst.detail).toContain('3건');
    // 다른 자산은 세지 않는다
    expect(byId(await preview({ assetCode: 'ETH', networkCode: 'ETHEREUM', addressId: 'ab-05', amount: '1' }), 'recent_burst').outcome).toBe('pass');
  });

  it('price: missing or stale is unknown, never within the criterion', async () => {
    expect(byId(await preview({}), 'price')).toMatchObject({ outcome: 'pass' });
    ctx.db.prepare("UPDATE prices SET as_of = ? WHERE asset_code = 'USDC'").run(new Date(Date.now() - 2 * 3600_000).toISOString());
    const stale = byId(await preview({}), 'price');
    expect(stale).toMatchObject({ outcome: 'unknown', label: '확인 불가(시세 지연)', requiresReason: false });
    ctx.db.prepare("DELETE FROM prices WHERE asset_code = 'USDC'").run();
    const missing = byId(await preview({}), 'price');
    expect(missing).toMatchObject({ outcome: 'unknown', label: '확인 불가(시세 없음)' });
    expect(missing.detail).toContain('2명');
  });

  it('uses the policy thresholds (design assumptions) and falls back to the defaults for unreadable values', () => {
    const policyJson = JSON.parse(readFileSync(path.join(APP_ROOT, 'config/policy.json'), 'utf8'));
    const { $comment, ...fromFile } = policyJson.withdrawalChecks;
    expect($comment).toContain('설계 가정');
    expect(fromFile).toEqual(DEFAULT_WITHDRAWAL_CHECKS);
    expect(checkThresholds({ amountMedianMultiple: Number.NaN, amountMedianMinHistory: 0, balanceSharePercent: -1, burstWindowMinutes: 'x' as any, burstCount: 2.7 }))
      .toEqual({ ...DEFAULT_WITHDRAWAL_CHECKS, burstCount: 2 });
    const cfg = loadConfig({ dbPath: ':memory:', logLevel: 'silent', serveClient: false });
    cfg.policy.withdrawalChecks = { ...cfg.policy.withdrawalChecks, burstCount: 1, balanceSharePercent: 1 };
    const items = computeChecks(ctx.db, cfg.policy, {
      requestId: null, orgId: 'org-a', walletId: 'w-a-eth', assetCode: 'USDC', networkCode: 'ETHEREUM', amountUnits: 100_000_000_000n, precision: 6,
      address: (ctx.db.prepare("SELECT address FROM address_book WHERE id = 'ab-01'").get() as any).address,
    });
    expect(byId(items, 'recent_burst').outcome).toBe('caution');
    expect(byId(items, 'balance_share').outcome).toBe('caution'); // 100,000 / 1,250,000 = 8% ≥ 1%
  });

  it('never shows an unknown result as within the criterion, and uses no safety or verification wording', async () => {
    ctx.db.prepare("DELETE FROM prices WHERE asset_code = 'USDC'").run();
    const all = [...await preview({ addressId: 'ab-07', amount: '700000' }), ...await preview({})];
    for (const c of all) {
      expect(['pass', 'caution', 'unknown']).toContain(c.outcome);
      if (c.outcome === 'unknown') expect(c.label).toMatch(/^확인 불가/);
      for (const t of [c.label, c.detail, c.basis]) expect(t, c.id).not.toMatch(/안전|검증된|검증됨|위험 없음|통과/);
      expect(c.detail.trim(), c.id).toMatch(/[다요]\.$|\)\.?$/);
    }
    expect(CHECK_OUTCOME.unknown.tone).not.toBe('success');
    expect(CHECK_OUTCOME.pass.tone).not.toBe('success');
    expect(Object.values(CHECK_OUTCOME).map((o) => o.label)).toEqual(['기준 이내', '주의', '확인 불가']);
  });
});

describe('진행 사유(CHECK_REASON_REQUIRED)와 저장', () => {
  it('requires a reason of 5+ characters for each caution that needs one, reserves nothing until then, and stores checks with reasons', async () => {
    const { a, r } = await toReview('u-a-han', { addressId: 'ab-07', amount: '700000' }); // 처음 보내는 주소 + 사용 가능 수량의 56%
    expect(r.checks.stored).toBe(false);
    expect(r.checks.items.filter((c: RequestCheck) => c.requiresReason).map((c: RequestCheck) => c.id)).toEqual(['first_use', 'balance_share']);
    const body = { version: r.version, confirmTail: tail(r.address.address), ackIrreversible: true };
    const none = await a.post(`/api/requests/${r.id}/submit`, body);
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('CHECK_REASON_REQUIRED');
    expect(none.body.error.message).toBe('주의 항목 2건에 진행 사유가 필요합니다.');
    expect(none.body.error.fields.map((f: any) => f.field)).toEqual(['checkReasons.first_use', 'checkReasons.balance_share']);
    expect(none.body.error.checkIds).toEqual(['first_use', 'balance_share']);
    const short = await a.post(`/api/requests/${r.id}/submit`, { ...body, checkReasons: { first_use: '전화로 확인함', balance_share: '네' } });
    expect(short.body.error.fields.map((f: any) => f.field)).toEqual(['checkReasons.balance_share']);
    const reserved = () => (ctx.db.prepare("SELECT reserved_units FROM balances WHERE wallet_id = 'w-a-eth' AND asset_code = 'USDC'").get() as any).reserved_units;
    expect(reserved()).toBe('0');
    expect((ctx.db.prepare('SELECT status FROM withdrawal_requests WHERE id = ?').get(r.id) as any).status).toBe('REVIEW');
    expect(ctx.db.prepare('SELECT 1 FROM request_intents WHERE request_id = ?').get(r.id)).toBeUndefined();

    const reasons = { first_use: '거래처 재무팀과 전화로 주소 전체를 대조했습니다', balance_share: '분기 정산 대금이라 한 번에 보냅니다', recent_burst: '사유 불필요 항목' };
    const ok = await a.post(`/api/requests/${r.id}/submit`, { ...body, checkReasons: reasons });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.checks.stored).toBe(true);
    const stored = ok.body.checks.items as RequestCheck[];
    expect(byId(stored, 'first_use').reason).toBe(reasons.first_use);
    expect(byId(stored, 'balance_share').reason).toBe(reasons.balance_share);
    expect(byId(stored, 'recent_burst').reason).toBeNull(); // 기준 이내 항목의 사유는 버린다
    const detail = JSON.parse(auditRows(ctx.db, r.id, 'request.submitted')[0]!.detail);
    expect(detail.checkReasons).toEqual({ first_use: reasons.first_use, balance_share: reasons.balance_share });
    expect(detail.checks.map((c: any) => `${c.id}:${c.outcome}`)).toContain('first_use:caution');

    // 승인자는 저장된 결과와 사유를 그대로 본다(지금 다시 계산하지 않는다)
    ctx.db.prepare("DELETE FROM prices WHERE asset_code = 'USDC'").run();
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const seen = (await oh.get(`/api/requests/${r.id}`)).body;
    expect(seen.checks.evaluatedAt).toBe(ok.body.checks.evaluatedAt);
    expect(byId(seen.checks.items, 'price').outcome).toBe('pass');
    expect(byId(seen.checks.items, 'first_use').reason).toBe(reasons.first_use);
  });

  it('does not accept invisible or punctuation-only reasons, and stores a reason without invisible format characters', async () => {
    const { a, r } = await toReview('u-a-han', { addressId: 'ab-07' });
    const body = { version: r.version, confirmTail: tail(r.address.address), ackIrreversible: true };
    // 폭 없는 공백만, 문장부호만, 방향 제어 문자와 섞인 두 글자: 글자·숫자가 5자에 못 미친다
    for (const bad of ['​​​​​', '.....', ' ! ? - … ', '‮​가​나​', '⁠⁠﻿..']) {
      const res = await a.post(`/api/requests/${r.id}/submit`, { ...body, checkReasons: { first_use: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect(res.body.error.code).toBe('CHECK_REASON_REQUIRED');
      expect(res.body.error.fields.map((f: any) => f.field)).toEqual(['checkReasons.first_use']);
      expect(res.body.error.fields[0].message).toContain('글자·숫자 5자 이상');
    }
    expect((ctx.db.prepare('SELECT status FROM withdrawal_requests WHERE id = ?').get(r.id) as any).status).toBe('REVIEW');
    // 글자가 충분하면 받되, 저장하는 사유에서는 보이지 않는 서식 문자를 지운다(승인자 화면에 숨은 글자·뒤집힌 글자가 섞이지 않게)
    const ok = await a.post(`/api/requests/${r.id}/submit`, { ...body, checkReasons: { first_use: '​거래처와‮ 전화로 대조했습니다​' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(byId(ok.body.checks.items, 'first_use').reason).toBe('거래처와 전화로 대조했습니다');
  });

  it('rejects an unknown check id in the reasons (422)', async () => {
    const { a, r } = await toReview();
    const res = await a.post(`/api/requests/${r.id}/submit`, { version: r.version, confirmTail: tail(r.address.address), ackIrreversible: true, checkReasons: { other: '알 수 없는 항목' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('shows live, unstored checks for a review request', async () => {
    const { r } = await toReview('u-a-han', { addressId: 'ab-07' });
    expect(byId(r.checks.items, 'first_use').outcome).toBe('caution');
    expect(r.checks.stored).toBe(false);
  });

  it('recomputes the checks at submit: a reason becomes required when another request reserved most of the wallet after review', async () => {
    // 검토 때는 100 USDC / 사용 가능 1,250,000 USDC → 사유가 필요한 항목이 없다.
    const { a, r } = await toReview('u-a-han', { addressId: 'ab-01', amount: '100' });
    expect(r.checks.items.filter((c: RequestCheck) => c.requiresReason)).toEqual([]);
    expect(byId(r.checks.items, 'balance_share').outcome).toBe('pass');

    // 다른 요청이 사용 가능 수량 대부분을 예약한다(남는 사용 가능 수량 150 USDC).
    await toPending('u-a-kang', { addressId: 'ab-01', amount: '1249850' }, { balance_share: '분기 정산 대금이라 한 번에 보냅니다' });
    const body = { version: r.version, confirmTail: tail(r.address.address), ackIrreversible: true };
    const none = await a.post(`/api/requests/${r.id}/submit`, body);
    expect(none.status, JSON.stringify(none.body)).toBe(422);
    expect(none.body.error.code).toBe('CHECK_REASON_REQUIRED');
    expect(none.body.error.fields.map((f: any) => f.field)).toEqual(['checkReasons.balance_share']);
    expect((ctx.db.prepare('SELECT status FROM withdrawal_requests WHERE id = ?').get(r.id) as any).status).toBe('REVIEW');

    const ok = await a.post(`/api/requests/${r.id}/submit`, { ...body, checkReasons: { balance_share: '남은 수량으로 먼저 보내야 하는 정산입니다' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.checks.stored).toBe(true);
    expect(byId(ok.body.checks.items, 'balance_share')).toMatchObject({ outcome: 'caution', requiresReason: true, reason: '남은 수량으로 먼저 보내야 하는 정산입니다' });
  });

  it('stores the seeded pending requests with a fingerprint, checks and the requester reasons', () => {
    for (const id of ['wr-3', 'wr-4']) {
      const row = ctx.db.prepare(`SELECT r.*, n.family network_family, ab.address address_value, ab.memo address_memo, ri.intent_hash, ri.pre_checks
        FROM withdrawal_requests r JOIN networks n ON n.code = r.network_code JOIN address_book ab ON ab.id = r.address_id JOIN request_intents ri ON ri.request_id = r.id WHERE r.id = ?`).get(id) as any;
      expect(row.intent_hash).toBe(intentHashOf(intentFieldsOf(row)));
      const checks = JSON.parse(row.pre_checks);
      expect(checks.evaluatedAt).toBe(row.submitted_at);
      const first = byId(checks.items, 'first_use');
      expect(first.outcome).toBe('caution');
      expect(first.reason?.length ?? 0).toBeGreaterThanOrEqual(5);
      expect(byId(checks.items, 'price').outcome).toBe('pass');
    }
    // 처리 완료·반려된 시드 요청은 지문만 있고 점검 기록은 없다. 승인·반려 표에 같은 지문이 있다.
    const votes = ctx.db.prepare('SELECT ai.request_id, ai.intent_hash = ri.intent_hash same FROM approval_intents ai JOIN request_intents ri ON ri.request_id = ai.request_id').all() as any[];
    expect(votes.map((v) => v.request_id).sort()).toEqual(['wr-1', 'wr-2']);
    expect(votes.every((v) => v.same === 1)).toBe(true);
    expect((ctx.db.prepare("SELECT pre_checks FROM request_intents WHERE request_id = 'wr-1'").get() as any).pre_checks).toBeNull();
  });
});

describe('사용 대기 주소로 요청(ADDRESS_NOT_ACTIVE)', () => {
  it('says the address is in its waiting period, when it becomes usable in KST, and to wait or stop it from the address page', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const ab14 = (await han.get('/api/addresses/ab-14')).body;
    expect(ab14.status).toBe('COOLING_DOWN');
    for (const call of [
      () => han.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-14', amount: '1', purpose: '사용 대기 주소' }, { 'idempotency-key': key() }),
      () => han.post('/api/requests/checks-preview', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-14', amount: '1' }),
    ]) {
      const r = await call();
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('ADDRESS_NOT_ACTIVE');
      expect(r.body.error.message).toBe(`'${ab14.label}' 주소는 사용 대기 중입니다. ${kstDateTime(ab14.activeFrom)} KST부터 출금 요청에 쓸 수 있습니다.`);
      // 요청자도 주소 등록 권한으로 직접 정지할 수 있다(A-31). 승인자를 찾아가라고 하지 않는다.
      expect(r.body.error.action).toBe('사용 가능해질 때까지 기다린 뒤 다시 요청하세요. 요청한 적 없는 등록이라면 주소 상세에서 「사용 대기 중 정지」로 바로 정지하세요.');
      expect(r.body.error.action).not.toContain('승인자에게');
      expect(r.body.error.fields).toEqual([{ field: 'addressId', message: '사용 대기 중인 주소입니다.' }]);
      expect(r.body.error.activeFrom).toBe(ab14.activeFrom);
    }
  });

  it('keeps the existing wording for an address that is not confirmed yet', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const r = await han.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-08', amount: '1', purpose: '확인 대기 주소' }, { 'idempotency-key': key() });
    expect(r.body.error.code).toBe('ADDRESS_NOT_ACTIVE');
    expect(r.body.error.message).toContain('확인 대기');
  });
});

describe('감사 기록 CSV: 한국 시간·행동 이름', () => {
  it('formats KST timestamps to the second', () => {
    expect(kstDateTime('2026-10-19T15:30:05.123Z', { seconds: true })).toBe('2026-10-20 00:30:05');
    expect(kstDateTime('2026-10-19T15:30:05.123Z')).toBe('2026-10-20 00:30');
    expect(kstDateTime('not-a-date', { seconds: true })).toBe('not-a-date');
    expect(kstDateTime(null)).toBe('');
  });

  it('exports KST times with a 한국 시간 header, a Korean action label column next to the raw code, and neutralised formulas', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const NEW_EVM = 'MOCK-EVM-' + '1234567890ABCDEF1234567890ABCDEF12345678';
    const mid = NEW_EVM.replace('MOCK-EVM-', '').slice(16, 24);
    const created = await han.post('/api/addresses', {
      label: '=HYPERLINK("http://evil")', counterparty: '+cmd', assetCode: 'USDC', networkCode: 'ETHEREUM', address: NEW_EVM, memo: '', confirmTail: tail(NEW_EVM), confirmMiddle: mid,
      ackNotVerified: true, ackOutOfBandConfirmed: true, receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const aud = await login(ctx.app, 'u-a-moon');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/audit/export.csv', headers: { cookie: aud.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body.startsWith('﻿')).toBe(true);
    // 맨 위 표지(A2-4)를 건너뛰고 빈 줄 다음 머리글부터 읽는다. '해시'는 마지막 열이고 그 앞이 결정 근거(내보낼 때 계산) 열이다.
    const { header, rows: data } = splitAuditCsv(res.body);
    expect(header).toEqual(['순번', '시각(한국 시간)', '수행자', '행동', '행동 코드', '대상 종류', '대상 ID', '내용', '결정 근거(내보낼 때 계산)', '해시']);
    expect(data.length).toBeGreaterThan(10);
    const db = ctx.db;
    // 순번은 조직 안 순번(화면의 '번호')이다. 모의법인 A의 기록을 오래된 순으로 세었을 때의 자리와 같다.
    const orgRows = db.prepare("SELECT created_at, action, hash FROM audit_log WHERE org_id = 'org-a' ORDER BY seq").all() as any[];
    expect(data.map((r) => Number(r[0]))).toEqual(Array.from({ length: data.length }, (_, i) => i + 1));
    for (const r of data) {
      expect(r).toHaveLength(10);
      expect(r[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(r[3]).toBe(ACTION_LABEL[r[4]!] ?? r[4]);
      const src = orgRows[Number(r[0]) - 1];
      expect(r[9]).toBe(src.hash);
      // 결정 근거는 승인·반려 행에만 있다(내보낼 때 계산, 해시 대상 아님)
      if (r[4] === 'request.approved' || r[4] === 'request.rejected') expect(r[8]).toMatch(/^결정 당시 역할: /);
      else expect(r[8]).toBe('');
      expect(r[1]).toBe(kstDateTime(src.created_at, { seconds: true }));
      expect(r[4]).toBe(src.action);
    }
    expect(data.some((r) => r[3] === '로그인' && r[4] === 'auth.login')).toBe(true);
    expect(data.some((r) => r[3] === '주소 등록 요청' && r[4] === 'address.created')).toBe(true);
    // 수식 무력화는 그대로다
    expect(res.body).not.toMatch(/,=HYPERLINK/);
    expect(res.body).toContain("주소 등록 요청: =HYPERLINK");
  });

  it('labels the fingerprint-mismatch action in the shared map used by the screen and the CSV', () => {
    // 승인 단계·커스터디 전달 직전 어느 쪽에도 맞는 이름(어느 단계였는지는 내용에 있다)
    expect(ACTION_LABEL['request.intent_tampered']).toBe('승인 대상 지문 불일치로 중단');
    // 결정 본문의 지문이 달라 승인·반려를 받지 않은 기록(승인인지 반려인지는 내용에 있다)
    expect(ACTION_LABEL['request.intent_mismatch']).toBe('승인 대상 지문이 달라 결정 거부');
    for (const a of ['request.submitted', 'request.approved', 'address.cooldown_stopped', 'address.activated']) expect(ACTION_LABEL[a], a).toBeTruthy();
  });
});
