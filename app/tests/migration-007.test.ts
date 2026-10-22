// 마이그레이션 007: 요청 번호의 고유 제약을 (org_id, ref_no)로 바꾼다(다른 조직의 요청량이 번호로 드러나지 않게).
// 기존 행·외래 키·인덱스·다른 표의 트리거가 그대로인지, 다시 실행하지 않는지 확인한다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '../server/config.ts';
import { migrate, openDb, type DB } from '../server/db.ts';
import { seed } from '../server/seed.ts';

const MIGRATIONS = path.join(APP_ROOT, 'server', 'migrations');
const BEFORE_007 = ['001_init.sql', '002_request_integrity.sql', '003_address_protection.sql', '004_audit_hash_v2.sql', '005_address_lifecycle.sql', '006_request_checks.sql'];

/** 007 이전 상태(001~006)의 DB. 두 조직이 전체 공용 번호(WR-000001, WR-000002)를 나눠 가진 기존 행이 있다. */
function legacyDb(): DB {
  const db = openDb(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const f of BEFORE_007) {
    db.exec('BEGIN IMMEDIATE');
    db.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    db.exec('COMMIT');
  }
  const t = '2026-10-01T00:00:00.000Z';
  db.exec(`
    INSERT INTO organizations VALUES ('o1', '모의 조직 1', 'customer', 1, '${t}'), ('o2', '모의 조직 2', 'customer', 1, '${t}');
    INSERT INTO users (id, org_id, name, email, title, created_at) VALUES
      ('u1', 'o1', '요청자', 'u1@mock.example', '담당', '${t}'), ('u2', 'o1', '승인자', 'u2@mock.example', '승인', '${t}'), ('u3', 'o2', '요청자 2', 'u3@mock.example', '담당', '${t}');
    INSERT INTO assets VALUES ('USDC', 'USD 코인', 6);
    INSERT INTO networks VALUES ('ETHEREUM', 'Ethereum', 'MOCK_EVM', 0, NULL);
    INSERT INTO wallets VALUES ('w1', 'o1', '지갑 1', 'ETHEREUM', 'MOCK-EVM-0000000000000000000000000000000000000001', NULL, '${t}'),
      ('w2', 'o2', '지갑 2', 'ETHEREUM', 'MOCK-EVM-0000000000000000000000000000000000000002', NULL, '${t}');
    INSERT INTO address_book (id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at, reviewed_by, reviewed_at, version) VALUES
      ('a1', 'o1', '주소 1', '상대 1', 'USDC', 'ETHEREUM', 'MOCK-EVM-1111111111111111111111111111111111111111', '', 'ACTIVE', 'u1', '${t}', 'u2', '${t}', 2),
      ('a2', 'o2', '주소 2', '상대 2', 'USDC', 'ETHEREUM', 'MOCK-EVM-2222222222222222222222222222222222222222', '', 'ACTIVE', 'u3', '${t}', NULL, NULL, 1);
    INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, required_approvals, krw_value_at_submit, created_by, created_at, updated_at, submitted_at, idempotency_key, version, approval_basis, price_as_of_at_submit, counted_approver_ids) VALUES
      ('r1', 'o1', 'WR-000001', 'w1', 'USDC', 'ETHEREUM', '1000000', 'a1', '기존 요청', 'COMPLETED', 1, '1400', 'u1', '${t}', '${t}', '${t}', 'key-00000001', 4, 'value_below_threshold', '${t}', '["u2"]'),
      ('r2', 'o2', 'WR-000002', 'w2', 'USDC', 'ETHEREUM', '2000000', 'a2', '다른 조직 요청', 'DRAFT', 1, NULL, 'u3', '${t}', '${t}', NULL, NULL, 1, NULL, NULL, NULL);
    INSERT INTO approvals (request_id, user_id, decision, created_at) VALUES ('r1', 'u2', 'approved', '${t}');
    INSERT INTO request_intents (request_id, intent_version, intent_hash, pre_checks, reserved_wallet_id, reserved_asset_code, reserved_units, created_at) VALUES
      ('r1', 1, '${'a'.repeat(64)}', NULL, 'w1', 'USDC', '1000000', '${t}');
    INSERT INTO approval_intents (request_id, user_id, intent_hash, created_at) VALUES ('r1', 'u2', '${'a'.repeat(64)}', '${t}');
    INSERT INTO transactions (id, org_id, wallet_id, type, asset_code, network_code, amount_units, counterparty, status, occurred_at, request_id, tx_ref) VALUES
      ('t1', 'o1', 'w1', 'withdrawal', 'USDC', 'ETHEREUM', '1000000', '상대 1', 'completed', '${t}', 'r1', 'MOCK-TX-1');
  `);
  return db;
}

const insertRequest = (db: DB, id: string, org: string, ref: string, wallet: string, address: string, by: string) =>
  db.prepare(`INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'USDC', 'ETHEREUM', '1', ?, 'x', 'DRAFT', ?, 't', 't')`).run(id, org, ref, wallet, address, by);

describe('마이그레이션 007', () => {
  it('replaces the global ref_no unique with (org_id, ref_no) and keeps every row, foreign key, index and trigger', () => {
    const db = legacyDb();
    try {
      // 007 이전: 다른 조직이라도 같은 번호를 쓸 수 없다.
      expect(() => insertRequest(db, 'r9', 'o2', 'WR-000001', 'w2', 'a2', 'u3')).toThrow(/UNIQUE/);
      const before = JSON.stringify(db.prepare('SELECT * FROM withdrawal_requests ORDER BY id').all());
      const related = JSON.stringify(['approvals', 'approval_intents', 'request_intents', 'transactions'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));

      expect(migrate(db)).toEqual(['007_ref_no_per_org.sql', '008_request_attachments.sql']);
      expect(JSON.stringify(db.prepare('SELECT * FROM withdrawal_requests ORDER BY id').all())).toBe(before); // 열 이름·순서·값이 그대로
      expect(JSON.stringify(['approvals', 'approval_intents', 'request_intents', 'transactions'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()))).toBe(related);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect((db.prepare('PRAGMA defer_foreign_keys').get() as any).defer_foreign_keys).toBe(0);
      expect((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys).toBe(1);

      // 조직이 다르면 같은 번호를 쓸 수 있고, 같은 조직에서는 겹칠 수 없다.
      insertRequest(db, 'r3', 'o2', 'WR-000001', 'w2', 'a2', 'u3');
      expect(() => insertRequest(db, 'r4', 'o2', 'WR-000001', 'w2', 'a2', 'u3')).toThrow(/UNIQUE/);
      expect(() => insertRequest(db, 'r5', 'o1', 'WR-000001', 'w1', 'a1', 'u1')).toThrow(/UNIQUE/);

      // 외래 키·상태 제약은 그대로다.
      expect(() => insertRequest(db, 'r6', 'o1', 'WR-000100', 'w1', 'nope', 'u1')).toThrow(/FOREIGN KEY/);
      expect(() => db.prepare("DELETE FROM withdrawal_requests WHERE id = 'r1'").run()).toThrow(/FOREIGN KEY/);
      expect(() => db.prepare("UPDATE withdrawal_requests SET status = 'UNKNOWN' WHERE id = 'r2'").run()).toThrow(/CHECK constraint failed/);

      // 인덱스를 다시 만들었다(멱등 키 고유, 조직·상태 조회).
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'withdrawal_requests' ORDER BY name").all() as any[]).map((r) => r.name);
      expect(idx).toEqual(expect.arrayContaining(['withdrawal_idem', 'withdrawal_org_status']));
      expect(() => db.prepare(`INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, created_by, created_at, updated_at, idempotency_key)
        VALUES ('r7', 'o1', 'WR-000101', 'w1', 'USDC', 'ETHEREUM', '1', 'a1', 'x', 'DRAFT', 'u1', 't', 't', 'key-00000001')`).run()).toThrow(/UNIQUE/);

      // 다른 표의 트리거는 이 표를 이름으로 읽으므로 그대로 동작한다.
      expect(() => db.prepare("INSERT INTO approvals (request_id, user_id, decision, created_at) VALUES ('r1', 'u1', 'approved', 't')").run()).toThrow(/SELF_APPROVAL_FORBIDDEN/);
      expect(() => db.prepare("UPDATE request_intents SET reserved_units = '1' WHERE request_id = 'r1'").run()).toThrow(/REQUEST_INTENT_IMMUTABLE/);
      const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as any[]).map((r) => r.name);
      expect(triggers).toEqual(expect.arrayContaining(['approvals_no_self', 'approvals_no_update', 'approvals_no_delete', 'request_intents_no_update', 'audit_no_update']));
      expect(migrate(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('applies on a fresh database and the seed passes the foreign key check', () => {
    const db = openDb(':memory:');
    try {
      expect(migrate(db)).toContain('007_ref_no_per_org.sql');
      seed(db);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const refs = (db.prepare("SELECT ref_no FROM withdrawal_requests WHERE org_id = 'org-a' ORDER BY ref_no").all() as any[]).map((r) => r.ref_no);
      expect(refs).toEqual(['WR-000001', 'WR-000002', 'WR-000003', 'WR-000004', 'WR-000005', 'WR-000006']);
    } finally {
      db.close();
    }
  });
});
