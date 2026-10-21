import type { DB } from '../db.ts';
import { permissionsFor } from '../authz.ts';
import { ROLE_LABEL, type DecisionEvidence, type Role } from '../../shared/terms.ts';

/**
 * 결정 근거(A2-3): 이미 저장된 기록에서 읽을 때 계산한다. 승인 표·지문 기록·감사 기록에 새로 쓰지 않는다(해시 대상 아님, 마이그레이션 없음).
 * - 결정 당시 역할: 같은 조직 감사 기록의 역할 변경(member.roles_changed {before, after})에서 결정 시각 이전의 마지막 행
 * - 결정한 지문: 표마다 남긴 approval_intents(수정·삭제 금지)
 * - 정족수 포함: 요청의 counted_approver_ids(결정이 끝난 요청) 또는 지금 역할(승인 대기). 호출 측(requests.ts)이 계산해 넘긴다.
 */

const ROLE_CODES = new Set<string>(Object.keys(ROLE_LABEL));

/** 결정을 남긴 감사 기록(request.approved·request.rejected)의 순번. 같은 밀리초의 역할 변경이 결정 뒤에 남았어도 결정 앞의 기록만 보게 한다. */
function decisionSeq(db: DB, orgId: string, requestId: string, userId: string): number | null {
  const row = db.prepare(
    `SELECT seq FROM audit_log WHERE org_id = ? AND target_type = 'request' AND target_id = ? AND actor_id = ? AND action IN ('request.approved', 'request.rejected')
      ORDER BY seq LIMIT 1`,
  ).get(orgId, requestId, userId) as { seq: number } | undefined;
  return row?.seq ?? null;
}

/**
 * 결정 당시 역할(역할 변경 기록 기준). 같은 조직의 역할 변경 기록 가운데 created_at ≤ 결정 시각이고 결정 기록보다 앞선 마지막 행(seq 내림차순)의 detail.after.
 * 기록이 없거나, after가 알려진 역할 코드의 배열이 아니면 null이다. 앱을 거치지 않고 저장 계층에서 바꾼 역할은 기록에 없으므로 알 수 없다(docs/assumptions.md A-36).
 */
export function rolesAtDecision(db: DB, orgId: string, userId: string, requestId: string, decidedAt: string): Role[] | null {
  const before = decisionSeq(db, orgId, requestId, userId);
  const params: (string | number)[] = [orgId, userId, decidedAt];
  if (before !== null) params.push(before);
  const row = db.prepare(
    `SELECT detail FROM audit_log
      WHERE org_id = ? AND action = 'member.roles_changed' AND target_type = 'user' AND target_id = ? AND created_at <= ?${before === null ? '' : ' AND seq < ?'}
      ORDER BY seq DESC LIMIT 1`,
  ).get(...params) as { detail: string } | undefined;
  if (!row) return null;
  try {
    const after = JSON.parse(row.detail)?.after;
    if (!Array.isArray(after) || !after.every((x) => typeof x === 'string' && ROLE_CODES.has(x))) return null;
    return after as Role[];
  } catch {
    return null;
  }
}

/** 결정 근거를 만들 표 하나(requests.ts approvalsOf + 정족수 포함 여부) */
export interface EvidenceVote {
  userId: string;
  name: string;
  decision: 'approved' | 'rejected';
  createdAt: string;
  intentHash: string | null;
  intentHashDisplay: string | null;
  counted: boolean;
}

/**
 * 표마다 결정 근거를 만든다. showRoles(조회자에게 감사 기록 조회 권한이 있음)가 아니면 역할 변경 기록을 읽지 않고 역할은 null로 둔다.
 * 역할 변경 기록은 지금도 audit.read로만 보이므로, 다른 역할에 새로 드러나는 정보가 없게 한다.
 */
export function evidenceOf(db: DB, orgId: string, requestId: string, requestIntentHash: string | null, votes: EvidenceVote[], showRoles: boolean): DecisionEvidence[] {
  return votes.map((v) => {
    const roles = showRoles ? rolesAtDecision(db, orgId, v.userId, requestId, v.createdAt) : null;
    return {
      userId: v.userId,
      name: v.name,
      decision: v.decision,
      decidedAt: v.createdAt,
      intentHashDisplay: v.intentHashDisplay,
      matchesRequestIntent: v.intentHash ? v.intentHash === requestIntentHash : null,
      counted: v.decision === 'approved' && v.counted,
      rolesAtDecision: roles,
      rolesSource: roles ? 'role_history' : null,
      // 역할→권한 표는 코드(A-01)라 저장되지 않으므로 지금 권한표로 본다.
      approveRoleAtDecision: roles ? permissionsFor(roles).has('request.approve') : null,
    };
  });
}
