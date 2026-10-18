import { createHash, randomUUID } from 'node:crypto';
import type { DB } from './db.ts';
import { now } from './db.ts';

export interface AuditInput {
  orgId: string;
  actorId: string | null;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  detail?: Record<string, unknown>;
  at?: string;
}

const GENESIS = '0'.repeat(64);

function hashRow(r: { prev_hash: string; id: string; org_id: string; actor_id: string | null; action: string; target_type: string; target_id: string; summary: string; detail: string; created_at: string }) {
  return createHash('sha256')
    .update([r.prev_hash, r.id, r.org_id, r.actor_id ?? '', r.action, r.target_type, r.target_id, r.summary, r.detail, r.created_at].join('\u001f'))
    .digest('hex');
}

/** 감사 기록 추가. 호출 측 트랜잭션 안에서 실행해 업무 변경과 원자적으로 남긴다. */
export function writeAudit(db: DB, a: AuditInput): void {
  const last = db.prepare('SELECT hash FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1').get(a.orgId) as { hash: string } | undefined;
  const row = {
    id: randomUUID(),
    org_id: a.orgId,
    actor_id: a.actorId,
    action: a.action,
    target_type: a.targetType,
    target_id: a.targetId,
    summary: a.summary,
    detail: JSON.stringify(a.detail ?? {}),
    created_at: a.at ?? now(),
    prev_hash: last?.hash ?? GENESIS,
  };
  const hash = hashRow(row);
  db.prepare(
    `INSERT INTO audit_log (id, org_id, actor_id, actor_name, action, target_type, target_id, summary, detail, created_at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.org_id, row.actor_id, a.actorName, row.action, row.target_type, row.target_id, row.summary, row.detail, row.created_at, row.prev_hash, hash);
}

export function verifyChain(db: DB, orgId: string): { ok: boolean; count: number; brokenAtSeq: number | null } {
  const rows = db.prepare('SELECT * FROM audit_log WHERE org_id = ? ORDER BY seq ASC').all(orgId) as any[];
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || hashRow(r) !== r.hash) return { ok: false, count: rows.length, brokenAtSeq: r.seq };
    prev = r.hash;
  }
  return { ok: true, count: rows.length, brokenAtSeq: null };
}
