import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type DB } from '../server/db.ts';
import { seed } from '../server/seed.ts';
import { loadConfig } from '../server/config.ts';
import { verifyChain } from '../server/audit.ts';
import { checkAddress, findLookalikes, parseFindings } from '../server/domain/addresses.ts';
import { krwValue } from '../shared/decimal.ts';
import { lookalikeMatch, middleSegment } from '../shared/address-rules.ts';

// 모의 데이터가 제품의 안전 안내와 어긋나지 않는지 확인한다(WP-05).

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); seed(db); });
afterEach(() => { db.close(); });

const policy = loadConfig({ dbPath: ':memory:', logLevel: 'silent', serveClient: false }).policy;

describe('거래 내역 모의 데이터', () => {
  it('gives every withdrawal a counterparty registered in the address book for the same asset and network', () => {
    const rows = db.prepare(`SELECT t.id, t.org_id, t.asset_code, t.network_code, t.counterparty FROM transactions t WHERE t.type = 'withdrawal'`).all() as any[];
    expect(rows.length).toBeGreaterThan(10);
    for (const t of rows) {
      const book = db.prepare('SELECT asset_code, network_code FROM address_book WHERE org_id = ? AND label = ?').all(t.org_id, t.counterparty) as any[];
      expect(book.length, `${t.id} → ${t.counterparty}`).toBeGreaterThan(0);
      for (const b of book) expect([b.asset_code, b.network_code], `${t.id} → ${t.counterparty}`).toEqual([t.asset_code, t.network_code]);
    }
  });

  it('sends every withdrawal (transactions and requests) only after its address-book entry was registered and confirmed', () => {
    // 출금은 확인된 주소로만 간다: 거래 시각은 같은 이름·자산·네트워크로 등록된 주소의 확인 시각보다 뒤여야 한다.
    const txs = db.prepare(`SELECT t.id, t.counterparty, t.occurred_at, ab.id ab_id, ab.created_at, ab.reviewed_at
      FROM transactions t JOIN address_book ab ON ab.org_id = t.org_id AND ab.label = t.counterparty AND ab.asset_code = t.asset_code AND ab.network_code = t.network_code
      WHERE t.type = 'withdrawal'`).all() as any[];
    expect(txs.length).toBe((db.prepare("SELECT COUNT(*) c FROM transactions WHERE type = 'withdrawal'").get() as any).c);
    for (const t of txs) {
      expect(t.reviewed_at, `${t.id} → ${t.ab_id}`).toBeTruthy();
      expect(t.created_at <= t.reviewed_at, `${t.id} → ${t.ab_id}`).toBe(true);
      expect(t.occurred_at >= t.reviewed_at, `${t.id} (${t.occurred_at}) → ${t.ab_id} 확인 ${t.reviewed_at}`).toBe(true);
    }
    const reqs = db.prepare(`SELECT r.ref_no, r.created_at, ab.id ab_id, ab.reviewed_at FROM withdrawal_requests r JOIN address_book ab ON ab.id = r.address_id`).all() as any[];
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) {
      expect(r.reviewed_at, `${r.ref_no} → ${r.ab_id}`).toBeTruthy();
      expect(r.created_at >= r.reviewed_at, `${r.ref_no} (${r.created_at}) → ${r.ab_id} 확인 ${r.reviewed_at}`).toBe(true);
    }
  });

  it('records failures only for withdrawals (no failed deposit or reward)', () => {
    const failed = db.prepare("SELECT type, COUNT(*) c FROM transactions WHERE status = 'failed' GROUP BY type").all() as any[];
    expect(failed.filter((f) => f.type !== 'withdrawal')).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) c FROM transactions WHERE type = 'deposit' AND status = 'failed'").get() as any).c).toBe(0);
  });

  it('keeps the random draw order: the same 136 generated rows (amounts, assets, time offsets) as before the counterparty fix', () => {
    const rows = db.prepare("SELECT id, wallet_id, type, asset_code, network_code, amount_units, tx_ref, occurred_at FROM transactions WHERE id LIKE 'tx-a-%' ORDER BY id").all() as any[];
    expect(rows).toHaveLength(136);
    const body = rows.map((r) => [r.id, r.wallet_id, r.type, r.asset_code, r.network_code, r.amount_units, r.tx_ref].join('|')).join('\n');
    expect(createHash('sha256').update(body).digest('hex')).toBe('ca4ac1805970500c565eaa9a01bf7668fcc2c6fbe063c1ca120311354231b375');
    // 발생 시각은 시드 시각 기준 정수 시간 차이로 비교한다.
    const now = Date.now();
    const hours = rows.map((r) => Math.round((now - Date.parse(r.occurred_at)) / 3600_000)).join(',');
    expect(createHash('sha256').update(hours).digest('hex')).toBe('3e749a0b8b06dc14bd46752e8c63237b5121f3c1e1adb1e771f3a32df00e8838');
  });
});

describe('출금 요청 모의 데이터', () => {
  it('stores the KRW value and approval basis at submit for submitted rows, consistent with the approval policy', () => {
    const rows = db.prepare(`SELECT r.ref_no, r.status, r.amount_units, r.asset_code, a.precision, r.required_approvals, r.krw_value_at_submit, r.approval_basis, r.price_as_of_at_submit, r.submitted_at, p.krw_price
      FROM withdrawal_requests r JOIN assets a ON a.code = r.asset_code JOIN prices p ON p.asset_code = r.asset_code WHERE r.status IN ('PENDING_APPROVAL','COMPLETED','REJECTED')`).all() as any[];
    expect(rows.map((r) => r.status).sort()).toEqual(['COMPLETED', 'PENDING_APPROVAL', 'PENDING_APPROVAL', 'REJECTED']);
    const threshold = BigInt(policy.approval.highValueThresholdKrw);
    for (const r of rows) {
      expect(r.krw_value_at_submit, r.ref_no).not.toBeNull();
      expect(r.krw_value_at_submit).toBe(krwValue(r.amount_units, r.precision, r.krw_price).toString());
      const high = BigInt(r.krw_value_at_submit) >= threshold;
      expect(r.approval_basis, r.ref_no).toBe(high ? 'value_at_or_above_threshold' : 'value_below_threshold');
      expect(r.required_approvals, r.ref_no).toBe(high ? policy.approval.highValueRequiredApprovals : policy.approval.defaultRequiredApprovals);
      expect(r.price_as_of_at_submit).toBe(r.submitted_at);
    }
    const wr3 = rows.find((r) => r.ref_no === 'WR-000003');
    expect(wr3).toMatchObject({ status: 'PENDING_APPROVAL', required_approvals: 2, krw_value_at_submit: '168000000', approval_basis: 'value_at_or_above_threshold' });
  });

  it('leaves the valuation empty for rows that were never submitted', () => {
    const rows = db.prepare("SELECT krw_value_at_submit k, approval_basis b FROM withdrawal_requests WHERE status IN ('DRAFT','REVIEW')").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.k === null && r.b === null)).toBe(true);
  });

  it('records the basis in the seeded request.submitted audit detail and keeps the audit chain valid', () => {
    const row = db.prepare("SELECT detail FROM audit_log WHERE action = 'request.submitted' AND target_id = 'wr-3'").get() as any;
    expect(JSON.parse(row.detail)).toMatchObject({ requiredApprovals: 2, approvalBasis: 'value_at_or_above_threshold', krwValue: '168000000' });
    expect(verifyChain(db, 'org-a').ok).toBe(true);
    expect(verifyChain(db, 'org-b').ok).toBe(true);
  });
});

describe('Market Insight 모의 데이터', () => {
  it('gives every insight a distinct one-line summary marked as mock, without the old title prefix', () => {
    const rows = db.prepare('SELECT id, title, summary FROM insights').all() as any[];
    expect(rows).toHaveLength(26);
    expect(new Set(rows.map((r) => r.summary)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.summary, r.id).toMatch(/\(모의 요약\)$/);
      expect(r.summary, r.id).not.toContain('\n');
      expect(r.title, r.id).not.toMatch(/^모의 시장 동향/);
    }
    // 고객 화면 건수(화이트리스트 기관의 게시 자료 24건, 기관 B 8건)는 그대로다.
    expect((db.prepare("SELECT COUNT(*) c FROM insights i JOIN insight_providers p ON p.id = i.provider_id WHERE i.status = 'published' AND p.is_whitelisted = 1").get() as any).c).toBe(24);
    expect((db.prepare("SELECT COUNT(*) c FROM insights WHERE status = 'published' AND provider_id = 'prov-b'").get() as any).c).toBe(8);
  });
});

describe('유사 주소 예시(확인 대기)', () => {
  const addressOf = (id: string) => (db.prepare('SELECT address FROM address_book WHERE id = ?').get(id) as any).address as string;
  const row = () => db.prepare("SELECT * FROM address_book WHERE id = 'ab-13'").get() as any;

  it('is a PENDING_REVIEW entry by 강도윤 that carries ADDRESS_LOOKALIKE against ab-02 (head 4 / tail 6) and a registration reason', () => {
    const r = row();
    expect(r).toMatchObject({ org_id: 'org-a', status: 'PENDING_REVIEW', created_by: 'u-a-kang', asset_code: 'USDC', network_code: 'KAIA' });
    expect(r.lookalike_reason).toBeTruthy();
    const look = parseFindings(r.check_findings).find((f) => f.code === 'ADDRESS_LOOKALIKE');
    expect(look).toBeTruthy();
    expect(look!.level).toBe('warning');
    expect(look!.data!.matches!.map((m) => m.id)).toEqual(['ab-02']);
    expect(look!.data!.matches![0]).toMatchObject({ prefix: 4, suffix: 6, status: 'ACTIVE' });
    // 저장된 결과는 지금 다시 점검해도 같다(자기 자신 제외). 다른 시드 주소와는 비슷하지 않다.
    expect(findLookalikes(db, 'org-a', r.address, 'ab-13').map((m) => m.id)).toEqual(['ab-02']);
    const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'address.created' AND target_id = 'ab-13'").get() as any;
    expect(JSON.parse(audit.detail)).toMatchObject({ ruleVersion: 'lookalike-v2', lookalike: [{ id: 'ab-02', prefix: 4, suffix: 6 }], warnings: expect.arrayContaining(['ADDRESS_LOOKALIKE']) });
    expect(audit.detail).not.toContain(r.address); // 감사 기록에는 끝 6자리만 남긴다
  });

  it('passes a tail-only check but not the middle-8 check, which is what the example is meant to show', () => {
    const a = addressOf('ab-02');
    const l = row().address as string;
    expect(l.slice(-6)).toBe(a.slice(-6));
    expect(middleSegment(l).text).not.toBe(middleSegment(a).text);
  });

  it('leaves ab-01 and the head-4 look-alike copies of ab-01 used by other tests unaffected', () => {
    const a01 = addressOf('ab-01');
    const same = checkAddress(db, 'org-a', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: a01, memo: '' });
    expect(same.findings.map((f) => f.code)).not.toContain('ADDRESS_LOOKALIKE');
    const a = a01.replace(/^MOCK-EVM-/, '');
    const l = row().address as string;
    const flip = (c: string, n: number) => { let x = c; for (let i = 0; i < n; i++) x = ((parseInt(x, 16) + 1) % 16).toString(16).toUpperCase(); return x; };
    const poison = (head: number, tail: number, shift = 1) => `MOCK-EVM-${a.slice(0, head)}${[...a.slice(head, a.length - tail)].map((c) => flip(c, shift)).join('')}${a.slice(a.length - tail)}`;
    for (const [h, t, s] of [[4, 5, 1], [4, 6, 1], [4, 6, 2], [4, 6, 3], [6, 6, 4], [3, 3, 1]] as const) {
      expect(lookalikeMatch(l, poison(h, t, s)), `${h}/${t}/${s}`).toBeNull();
    }
  });
});
