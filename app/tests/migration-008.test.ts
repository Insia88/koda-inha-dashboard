// 마이그레이션 008: 지급 근거 짝 표(request_attachments·request_evidence_notes)와 잠금 트리거(A2b).
// 기존 표는 모양·값이 그대로이고, 승인 요청 뒤에는 저장 계층에서도 근거를 넣거나 지우거나 고칠 수 없는지 확인한다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ROOT } from '../server/config.ts';
import { migrate, openDb, type DB } from '../server/db.ts';
import { seed } from '../server/seed.ts';

const MIGRATIONS = path.join(APP_ROOT, 'server', 'migrations');
const BEFORE_008 = ['001_init.sql', '002_request_integrity.sql', '003_address_protection.sql', '004_audit_hash_v2.sql', '005_address_lifecycle.sql', '006_request_checks.sql', '007_ref_no_per_org.sql'];
const EXISTING = ['withdrawal_requests', 'request_intents', 'approvals', 'approval_intents', 'transactions', 'audit_log', 'address_book'];
const T = '2026-10-01T00:00:00.000Z';
const SHA = 'a'.repeat(64);

/** 008 이전 상태(001~007)의 DB. 작성 중(r2)·승인 대기(r3)·처리 완료(r1) 요청이 있다. */
function legacyDb(): DB {
  const db = openDb(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const f of BEFORE_008) {
    db.exec('BEGIN IMMEDIATE');
    db.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, T);
    db.exec('COMMIT');
  }
  db.exec(`
    INSERT INTO organizations VALUES ('o1', '모의 조직 1', 'customer', 1, '${T}'), ('o2', '모의 조직 2', 'customer', 1, '${T}');
    INSERT INTO users (id, org_id, name, email, title, created_at) VALUES
      ('u1', 'o1', '요청자', 'u1@mock.example', '담당', '${T}'), ('u2', 'o1', '승인자', 'u2@mock.example', '승인', '${T}'), ('u3', 'o2', '요청자 2', 'u3@mock.example', '담당', '${T}');
    INSERT INTO assets VALUES ('USDC', 'USD 코인', 6);
    INSERT INTO networks VALUES ('ETHEREUM', 'Ethereum', 'MOCK_EVM', 0, NULL);
    INSERT INTO wallets VALUES ('w1', 'o1', '지갑 1', 'ETHEREUM', 'MOCK-EVM-0000000000000000000000000000000000000001', NULL, '${T}');
    INSERT INTO address_book (id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at, reviewed_by, reviewed_at, version) VALUES
      ('a1', 'o1', '주소 1', '상대 1', 'USDC', 'ETHEREUM', 'MOCK-EVM-1111111111111111111111111111111111111111', '', 'ACTIVE', 'u1', '${T}', 'u2', '${T}', 2);
    INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, required_approvals, created_by, created_at, updated_at, version) VALUES
      ('r1', 'o1', 'WR-000001', 'w1', 'USDC', 'ETHEREUM', '1000000', 'a1', '처리 완료', 'COMPLETED', 1, 'u1', '${T}', '${T}', 4),
      ('r2', 'o1', 'WR-000002', 'w1', 'USDC', 'ETHEREUM', '2000000', 'a1', '작성 중', 'DRAFT', 1, 'u1', '${T}', '${T}', 1),
      ('r3', 'o1', 'WR-000003', 'w1', 'USDC', 'ETHEREUM', '3000000', 'a1', '승인 대기', 'PENDING_APPROVAL', 1, 'u1', '${T}', '${T}', 3);
    INSERT INTO approvals (request_id, user_id, decision, created_at) VALUES ('r1', 'u2', 'approved', '${T}');
    INSERT INTO request_intents (request_id, intent_version, intent_hash, pre_checks, reserved_wallet_id, reserved_asset_code, reserved_units, created_at) VALUES
      ('r1', 1, '${'b'.repeat(64)}', NULL, 'w1', 'USDC', '1000000', '${T}'), ('r3', 1, '${'c'.repeat(64)}', NULL, 'w1', 'USDC', '3000000', '${T}');
    INSERT INTO transactions (id, org_id, wallet_id, type, asset_code, network_code, amount_units, counterparty, status, occurred_at, request_id, tx_ref) VALUES
      ('t1', 'o1', 'w1', 'withdrawal', 'USDC', 'ETHEREUM', '1000000', '상대 1', 'completed', '${T}', 'r1', 'MOCK-TX-1');
  `);
  return db;
}

const attach = (db: DB, o: { id?: string; request?: string; org?: string; by?: string; sha?: string; size?: number; content?: Uint8Array; type?: string; name?: string } = {}) => {
  const content = o.content ?? new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
  return db.prepare('INSERT INTO request_attachments (id, request_id, org_id, file_name, content_type, size_bytes, sha256, added_by, added_at, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(o.id ?? 'f1', o.request ?? 'r2', o.org ?? 'o1', o.name ?? 'a.pdf', o.type ?? 'application/pdf', o.size ?? content.length, o.sha ?? SHA, o.by ?? 'u1', T, content);
};
const note = (db: DB, request: string, by = 'u1', text = 'INV-1') =>
  db.prepare('INSERT INTO request_evidence_notes (request_id, note, updated_by, updated_at) VALUES (?, ?, ?, ?)').run(request, text, by, T);

describe('마이그레이션 008', () => {
  it('runs only 008 on a 007 database, keeps every existing table byte-identical, and is not re-run', () => {
    const db = legacyDb();
    try {
      const snapshot = () => JSON.stringify(EXISTING.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
      const columns = () => JSON.stringify(EXISTING.map((t) => db.prepare(`PRAGMA table_info(${t})`).all()));
      const before = snapshot();
      const cols = columns();
      expect(migrate(db)).toEqual(['008_request_attachments.sql']);
      expect(snapshot()).toBe(before);
      expect(columns()).toBe(cols);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name = 'request_attachments' OR tbl_name = 'request_evidence_notes') ORDER BY name").all() as any[]).map((r) => r.name);
      expect(triggers).toEqual([
        'request_attachments_guard_delete', 'request_attachments_guard_insert', 'request_attachments_no_update',
        'request_evidence_notes_guard_delete', 'request_evidence_notes_guard_insert', 'request_evidence_notes_guard_update',
      ]);
      // 파일 내용(content)은 맨 끝 열이다(메타데이터 조회가 넘침 페이지를 읽지 않게).
      const cols8 = (db.prepare('PRAGMA table_info(request_attachments)').all() as any[]).map((c) => c.name);
      expect(cols8.at(-1)).toBe('content');
      expect(migrate(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('applies on a fresh database and the seed passes the foreign key check', () => {
    const db = openDb(':memory:');
    try {
      expect(migrate(db)).toContain('008_request_attachments.sql');
      seed(db);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect((db.prepare('SELECT COUNT(*) c FROM request_attachments').get() as any).c).toBe(0);
    } finally {
      db.close();
    }
  });

  it('lets the creator add and remove evidence while DRAFT or REVIEW, and locks it at the storage layer after submission', () => {
    const db = legacyDb();
    try {
      migrate(db);
      attach(db);
      note(db, 'r2');
      expect(() => db.prepare("UPDATE request_attachments SET file_name = 'b.pdf' WHERE id = 'f1'").run()).toThrow(/REQUEST_ATTACHMENT_IMMUTABLE/);
      expect(() => attach(db, { id: 'f2' })).toThrow(/UNIQUE/); // 같은 요청에 같은 SHA-256
      db.prepare("UPDATE withdrawal_requests SET status = 'REVIEW' WHERE id = 'r2'").run();
      attach(db, { id: 'f2', sha: 'b'.repeat(64) });
      db.prepare("UPDATE request_evidence_notes SET note = 'INV-2' WHERE request_id = 'r2'").run();
      db.prepare("DELETE FROM request_attachments WHERE id = 'f2'").run();

      // 승인 요청 뒤: 넣기·지우기·메모 고치기·메모 지우기 모두 거부
      db.prepare("UPDATE withdrawal_requests SET status = 'PENDING_APPROVAL' WHERE id = 'r2'").run();
      expect(() => attach(db, { id: 'f3', sha: 'c'.repeat(64) })).toThrow(/REQUEST_EVIDENCE_LOCKED/);
      expect(() => db.prepare("DELETE FROM request_attachments WHERE id = 'f1'").run()).toThrow(/REQUEST_EVIDENCE_LOCKED/);
      expect(() => db.prepare("UPDATE request_evidence_notes SET note = 'INV-3' WHERE request_id = 'r2'").run()).toThrow(/REQUEST_EVIDENCE_LOCKED/);
      expect(() => db.prepare("DELETE FROM request_evidence_notes WHERE request_id = 'r2'").run()).toThrow(/REQUEST_EVIDENCE_LOCKED/);
      expect(() => attach(db, { id: 'f4', request: 'r3', sha: 'd'.repeat(64) })).toThrow(/REQUEST_EVIDENCE_LOCKED/);
      expect(() => note(db, 'r3')).toThrow(/REQUEST_EVIDENCE_LOCKED/);
      expect(() => attach(db, { id: 'f5', request: 'r1', sha: 'e'.repeat(64) })).toThrow(/REQUEST_EVIDENCE_LOCKED/);
      expect((db.prepare("SELECT COUNT(*) c FROM request_attachments WHERE request_id = 'r2'").get() as any).c).toBe(1);
    } finally {
      db.close();
    }
  });

  it('refuses another org, a non-creator, a changed note key and malformed rows', () => {
    const db = legacyDb();
    try {
      migrate(db);
      expect(() => attach(db, { org: 'o2' })).toThrow(/REQUEST_ATTACHMENT_ORG_MISMATCH/);
      expect(() => attach(db, { by: 'u2' })).toThrow(/REQUEST_EVIDENCE_NOT_OWNER/);
      expect(() => note(db, 'r2', 'u2')).toThrow(/REQUEST_EVIDENCE_NOT_OWNER/);
      note(db, 'r2');
      expect(() => db.prepare("UPDATE request_evidence_notes SET updated_by = 'u2' WHERE request_id = 'r2'").run()).toThrow(/REQUEST_EVIDENCE_NOT_OWNER/);
      expect(() => db.prepare("UPDATE request_evidence_notes SET request_id = 'r1' WHERE request_id = 'r2'").run()).toThrow(/REQUEST_EVIDENCE_NOTE_KEY_IMMUTABLE/);
      expect(() => attach(db, { request: 'nope' })).toThrow(/FOREIGN KEY/);
      expect(() => attach(db, { type: 'image/svg+xml' })).toThrow(/CHECK constraint failed/);
      expect(() => attach(db, { sha: 'A'.repeat(64) })).toThrow(/CHECK constraint failed/);
      expect(() => attach(db, { size: 6 })).toThrow(/CHECK constraint failed/); // 크기와 내용 길이가 다름
      expect(() => attach(db, { name: '' })).toThrow(/CHECK constraint failed/);
      expect(() => attach(db, { size: 2097153, content: new Uint8Array(2097153) })).toThrow(/CHECK constraint failed/);
      expect(() => note(db, 'r2', 'u1', '')).toThrow(/CHECK constraint failed|UNIQUE/);
    } finally {
      db.close();
    }
  });
});
