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

/** 조직 체인의 첫 기록이 가리키는 이전 해시. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);
const GENESIS = AUDIT_GENESIS_HASH;

/** writeAudit이 새 기록에 쓰는 해시 방식. */
export const AUDIT_HASH_VERSION = 2;

/**
 * 해시 v1(구 방식). hash_version = 1인 기존 기록을 검증할 때만 쓴다. 새 기록에는 쓰지 않는다.
 * 계산식은 v1 도입 당시와 한 글자도 다르지 않아야 한다(바꾸면 기존 체인이 깨진다).
 * actor_name을 포함하지 않고, 필드를 U+001F로 이어 붙이므로 값에 U+001F가 들어가면 경계가 모호하다.
 * 테스트가 구 방식 체인을 만들 수 있도록 내보낸다.
 */
export function hashRowV1(r: { prev_hash: string; id: string; org_id: string; actor_id: string | null; action: string; target_type: string; target_id: string; summary: string; detail: string; created_at: string }) {
  return createHash('sha256')
    .update([r.prev_hash, r.id, r.org_id, r.actor_id ?? '', r.action, r.target_type, r.target_id, r.summary, r.detail, r.created_at].join('\u001f'))
    .digest('hex');
}

export interface AuditHashFieldsV2 {
  prev_hash: string;
  id: string;
  org_id: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  target_type: string;
  target_id: string;
  summary: string;
  detail: string;
  created_at: string;
}

/** 짝 없는 UTF-16 서로게이트(상위 다음에 하위가 없거나, 하위 앞에 상위가 없는 것). 플래그 없이 코드 단위로 찾는다. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 저장소(SQLite)가 실제로 보관하는 문자열. 문자열은 UTF-8로 저장되므로 짝 없는 서로게이트는 U+FFFD로 바뀐다.
 * String.prototype.toWellFormed와 같은 결과이며, 올바른 문자열(서로게이트 쌍 포함)은 그대로 돌려준다.
 */
function asStored(s: string): string {
  return s.replace(LONE_SURROGATE, '�');
}

/**
 * 해시 v2. 수행자 이름(actor_name)을 포함하고, 필드를 고정 순서의 JSON 배열로 인코딩해 경계가 모호하지 않다.
 * 첫 원소 2는 방식 표시로, 같은 값을 다른 방식으로 해석해 맞추는 일을 막는다. actor_id가 없으면 null로 남는다.
 * 문자열은 저장소가 보관하는 형태(asStored)로 바꾼 뒤 인코딩한다. 그래야 기록할 때와 저장된 행으로 검증할 때 해시가 같다
 * (JSON.stringify는 짝 없는 서로게이트를 \uXXXX로 이스케이프하지만, 저장된 값은 이미 U+FFFD다).
 * 올바른 문자열은 바뀌지 않으므로 이미 기록된 v2 행의 해시는 그대로다.
 */
export function hashRowV2(r: AuditHashFieldsV2) {
  const fields = [r.prev_hash, r.id, r.org_id, r.actor_id, r.actor_name, r.action, r.target_type, r.target_id, r.summary, r.detail, r.created_at];
  return createHash('sha256')
    .update(JSON.stringify([2, ...fields.map((v) => (typeof v === 'string' ? asStored(v) : v))]))
    .digest('hex');
}

/**
 * 감사 기록 추가. 호출 측 트랜잭션 안에서 실행해 업무 변경과 원자적으로 남긴다. 항상 해시 v2로 기록한다.
 * 문자열은 저장소가 보관하는 형태로 바꿔 넣는다. 해시한 값과 저장한 값이 글자 그대로 같다.
 */
export function writeAudit(db: DB, a: AuditInput): void {
  const orgId = asStored(a.orgId);
  const last = db.prepare('SELECT hash FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1').get(orgId) as { hash: string } | undefined;
  const row: AuditHashFieldsV2 = {
    id: randomUUID(),
    org_id: orgId,
    actor_id: a.actorId === null ? null : asStored(a.actorId),
    actor_name: asStored(a.actorName),
    action: asStored(a.action),
    target_type: asStored(a.targetType),
    target_id: asStored(a.targetId),
    summary: asStored(a.summary),
    // JSON.stringify는 짝 없는 서로게이트를 \uXXXX로 이스케이프하므로 결과가 늘 올바른 문자열이다(원래 값도 그대로 담긴다).
    detail: asStored(JSON.stringify(a.detail ?? {})),
    created_at: asStored(a.at ?? now()),
    prev_hash: last?.hash ?? GENESIS,
  };
  const hash = hashRowV2(row);
  db.prepare(
    `INSERT INTO audit_log (id, org_id, actor_id, actor_name, action, target_type, target_id, summary, detail, created_at, prev_hash, hash, hash_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.org_id, row.actor_id, row.actor_name, row.action, row.target_type, row.target_id, row.summary, row.detail, row.created_at, row.prev_hash, hash, AUDIT_HASH_VERSION);
}

export interface ChainVerification {
  /** 체인 전체가 맞으면 true. */
  ok: boolean;
  /** 이 조직의 기록 수. */
  count: number;
  /** 처음 어긋난 기록의 seq(전체 공용 번호). 맞으면 null. */
  brokenAtSeq: number | null;
  /** 처음 어긋난 기록이 조직 체인에서 몇 번째인지(1부터). 맞으면 null. */
  brokenAtNo: number | null;
  /**
   * 가장 최근 기록의 해시. 체인이 맞을 때만 채운다(어긋난 체인의 끝 해시는 보관할 근거가 되지 못한다).
   * 기록이 없으면 null. 감사 담당자가 count와 함께 앱 밖에 보관하면, 나중에 최근 기록이 지워졌는지 대조할 수 있다.
   */
  headHash: string | null;
}

interface StoredAuditRow extends AuditHashFieldsV2 {
  seq: number;
  hash: string;
  hash_version: number;
}

/** 행이 가져야 할 해시. 알 수 없는 방식이거나 v2 뒤에 v1이 오면(되돌림) null — 어긋남으로 본다. */
function expectedHash(r: StoredAuditRow, afterV2: boolean): string | null {
  if (r.hash_version === 2) return hashRowV2(r);
  if (r.hash_version === 1 && !afterV2) return hashRowV1(r);
  return null;
}

/**
 * 조직별 해시 체인 검증. 행마다 저장된 hash_version에 맞는 방식으로 다시 계산한다.
 * 이전 해시 연결, 행 해시, 방식 표시(v2 다음 v1 금지, 알 수 없는 방식 금지)를 모두 확인한다.
 * 체인 중간의 수정·삭제는 찾지만, 가장 최근 기록을 지운 경우는 앱 밖에 보관한 headHash·count와 대조해야 알 수 있다.
 * 저장된 행을 다시 쓰지 않는다.
 */
export function verifyChain(db: DB, orgId: string): ChainVerification {
  const rows = db.prepare('SELECT * FROM audit_log WHERE org_id = ? ORDER BY seq ASC').all(orgId) as unknown as StoredAuditRow[];
  let prev = GENESIS;
  let afterV2 = false;
  for (const [i, r] of rows.entries()) {
    const expected = expectedHash(r, afterV2);
    if (r.prev_hash !== prev || expected === null || expected !== r.hash) {
      return { ok: false, count: rows.length, brokenAtSeq: r.seq, brokenAtNo: i + 1, headHash: null };
    }
    if (r.hash_version === 2) afterV2 = true;
    prev = r.hash;
  }
  return { ok: true, count: rows.length, brokenAtSeq: null, brokenAtNo: null, headHash: rows.length > 0 ? prev : null };
}
