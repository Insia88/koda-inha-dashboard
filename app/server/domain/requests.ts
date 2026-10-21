import { randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';
import { now, tx } from '../db.ts';
import { AppError, Errors } from '../errors.ts';
import { writeAudit } from '../audit.ts';
import type { AuthContext } from '../auth.ts';
import type { AppConfig } from '../config.ts';
import type { CustodyAdapter } from '../adapters/custody.ts';
import { permissionsFor } from '../authz.ts';
import { kstDateTime } from '../csv.ts';
import { AmountError, formatUnits, krwValue, parsePositiveUnits } from '../../shared/decimal.ts';
import { REQUEST_STATUS, type ApprovalWait, type ApproverRef, type DecisionEvidence, type DecisionEvidenceView, type RequestCheck, type RequestStatus, type Role } from '../../shared/terms.ts';
import { assertAssetOnNetwork, getAsset, getNetworkRule } from './catalog.ts';
import { getAddressRow, likePattern } from './addresses.ts';
import { evidenceOf } from './evidence.ts';
import { evidenceSnapshot, paymentEvidenceOf } from './attachment-store.ts';
import {
  attachCheckReasons, computeChecks, INTENT_VERSION, intentFieldsOf, intentHashDisplay, intentHashOf, normalizeIntentAddress, parseStoredChecks, readPrice, serializeChecks,
  type IntentRow,
} from './checks.ts';

export type RequestAction = 'edit' | 'review' | 'back_to_draft' | 'submit' | 'approve' | 'reject' | 'cancel';

/**
 * 제출 시 필요 승인 수를 정한 근거 (설계 가정, docs/assumptions.md A-03).
 * 시세가 없거나 오래되면 원화 평가액을 믿을 수 없으므로 고액 기준을 적용한다(fail closed).
 */
export type ApprovalBasis = 'value_below_threshold' | 'value_at_or_above_threshold' | 'price_missing' | 'price_stale';

/**
 * 승인 대기 요청이 승인될 수 없는 이유.
 * - INTENT_TAMPERED: 지금 저장된 내용으로 다시 계산한 지문이 제출 때 고정한 지문과 다르다(승인 요청 뒤 내용이 바뀜). 받는 주소 상태보다 먼저 본다.
 * - ADDRESS_NOT_ACTIVE: 받는 주소가 사용 가능 상태가 아니다.
 */
export type BlockedReason = 'INTENT_TAMPERED' | 'ADDRESS_NOT_ACTIVE';

/** 감사 기록에 남길 주소 끝자리 길이. 전체 주소는 남기지 않고 대조에 필요한 끝부분만 남긴다. */
const AUDIT_TAIL_LENGTH = 6;
const tailOf = (address: unknown) => String(address ?? '').slice(-AUDIT_TAIL_LENGTH);

/** 승인 대상 지문 불일치를 기록하는 감사 기록의 수행자 이름(사람이 아닌 서버의 재확인). */
export const INTENT_CHECK_ACTOR = '시스템(승인 대상 지문 재확인)';

/** 승인·반려 본문에서 받은 지문을 감사 기록에 남길 때의 앞부분 길이(화면 표시 지문과 같은 16자). */
const SUBMITTED_HASH_PREFIX_LENGTH = 16;

/**
 * 표시용 수량. 저장된 최소 단위 값을 정수로 읽을 수 없으면(앱을 거치지 않은 저장 계층 변경 등) null을 돌려준다.
 * 조회·목록·홈이 이 값 하나 때문에 실패하지 않게 하고, 화면은 null을 '—'로 보인다. 원래 저장 값은 amountUnits로 그대로 준다.
 */
export function displayAmount(units: unknown, precision: number): string | null {
  try {
    return formatUnits(String(units ?? ''), precision);
  } catch {
    return null;
  }
}

const OPEN: RequestStatus[] = ['DRAFT', 'REVIEW', 'PENDING_APPROVAL'];

/** 결정 근거를 붙이는 감사 기록 행동(승인·반려 표를 남긴 기록) */
export const DECISION_ACTIONS: ReadonlySet<string> = new Set(['request.approved', 'request.rejected']);

/** 허용 상태 전이 (설계 가정, docs/assumptions.md A-05) */
export const TRANSITIONS: Record<RequestAction, { from: RequestStatus[]; to: RequestStatus | null }> = {
  edit: { from: ['DRAFT'], to: 'DRAFT' },
  review: { from: ['DRAFT'], to: 'REVIEW' },
  back_to_draft: { from: ['REVIEW'], to: 'DRAFT' },
  submit: { from: ['REVIEW'], to: 'PENDING_APPROVAL' },
  approve: { from: ['PENDING_APPROVAL'], to: null },
  reject: { from: ['PENDING_APPROVAL'], to: 'REJECTED' },
  cancel: { from: OPEN, to: 'CANCELLED' },
};

const SELECT = `SELECT r.*, a.precision, n.name network_name, n.family network_family, w.name wallet_name, u.name creator_name,
    ab.label address_label, ab.address address_value, ab.memo address_memo, ab.status address_status, ab.counterparty address_counterparty, ab.active_from address_active_from,
    ri.intent_hash intent_hash, ri.pre_checks pre_checks,
    ri.reserved_wallet_id reserved_wallet_id, ri.reserved_asset_code reserved_asset_code, ri.reserved_units reserved_units
  FROM withdrawal_requests r
  JOIN assets a ON a.code = r.asset_code
  JOIN networks n ON n.code = r.network_code
  JOIN wallets w ON w.id = r.wallet_id
  JOIN users u ON u.id = r.created_by
  JOIN address_book ab ON ab.id = r.address_id
  LEFT JOIN request_intents ri ON ri.request_id = r.id`;

function approvalsOf(db: DB, id: string) {
  const rows = db.prepare(
    `SELECT ap.user_id userId, u.name, ap.decision, ap.reason, ap.created_at createdAt, ai.intent_hash intentHash
       FROM approvals ap JOIN users u ON u.id = ap.user_id
       LEFT JOIN approval_intents ai ON ai.request_id = ap.request_id AND ai.user_id = ap.user_id
      WHERE ap.request_id = ? ORDER BY ap.created_at`,
  ).all(id) as any[];
  // 표마다 그 사람이 결정할 때 본 승인 대상 지문(이 기능 도입 전 표는 null)
  return rows.map((a) => ({ ...a, intentHash: a.intentHash ?? null, intentHashDisplay: intentHashDisplay(a.intentHash) }));
}

/** 지금 이 순간 출금 승인 권한이 있는 사람인지: 같은 조직의 활성 사용자이고 현재 역할에 request.approve가 있다. */
function canApproveNow(db: DB, userId: string, orgId: string): boolean {
  const u = db.prepare('SELECT is_active, org_id FROM users WHERE id = ?').get(userId) as { is_active: number; org_id: string } | undefined;
  if (!u || !u.is_active || u.org_id !== orgId) return false;
  const roles = (db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(userId) as { role: Role }[]).map((x) => x.role);
  return permissionsFor(roles).has('request.approve');
}

/**
 * 지금 유효한 승인 표를 남긴 사람의 id (남긴 순서).
 * 승인 기록은 바꾸지 않는다(저장 계층에서 수정·삭제 금지). 대신 셀 때마다 승인자의 현재 상태를 다시 확인해
 * 비활성화되었거나 승인 권한을 잃은 사람의 표는 정족수에서 뺀다.
 */
export function validApproverIds(db: DB, requestId: string): string[] {
  const rows = db.prepare(
    `SELECT ap.user_id userId, r.org_id orgId, r.created_by createdBy FROM approvals ap JOIN withdrawal_requests r ON r.id = ap.request_id
      WHERE ap.request_id = ? AND ap.decision = 'approved' ORDER BY ap.created_at`,
  ).all(requestId) as { userId: string; orgId: string; createdBy: string }[];
  return rows.filter((x) => x.userId !== x.createdBy && canApproveNow(db, x.userId, x.orgId)).map((x) => x.userId);
}

/** 정족수 판단에 쓰는 유효 승인 수 */
export function validApprovals(db: DB, requestId: string): number {
  return validApproverIds(db, requestId).length;
}

/**
 * 지금 출금 승인 권한이 있는 같은 조직 활성 사용자(이름순, 이름·id만). canApproveNow와 같은 판정이다.
 * 제출 때 승인 가능 인원 검사(APPROVERS_INSUFFICIENT)와 화면의 '승인할 수 있는 사람'(approvalWaitOf)이 이 목록 하나를 써서 어긋나지 않는다.
 */
export function approverPool(db: DB, orgId: string): ApproverRef[] {
  const users = db.prepare('SELECT id, name FROM users WHERE org_id = ? AND is_active = 1 ORDER BY name, id').all(orgId) as { id: string; name: string }[];
  return users.filter((u) => canApproveNow(db, u.id, orgId)).map((u) => ({ id: u.id, name: u.name }));
}

/** 작성자를 뺀, 지금 승인할 수 있는 조직 구성원 수 */
function eligibleApprovers(db: DB, orgId: string, creatorId: string): number {
  return approverPool(db, orgId).filter((u) => u.id !== creatorId).length;
}

/**
 * 승인 대기 요청을 지금 누가 승인할 수 있는지(A2-1). 승인 대기이고 승인할 수 있는 요청(blockedReason 없음, 지문 있음)일 때만 값을 준다.
 * 후보: approverPool에서 작성자와 이 요청에 이미 결정(승인·반려)을 남긴 사람을 뺀다(서버의 자기 승인 금지·ALREADY_DECIDED와 같은 기준).
 * remaining: 필요 승인 수 − 지금 정족수에 든 승인 수. 표시용이며 정족수·승인 가능 여부는 승인 처리가 다시 정한다.
 * pool: 여러 요청을 한 번에 볼 때(홈) 조직 후보를 한 번만 읽도록 넘긴다.
 */
export function approvalWaitOf(db: DB, r: any, approvals: { userId: string; counted: boolean }[], pool?: ApproverRef[]): ApprovalWait | null {
  if (r.status !== 'PENDING_APPROVAL' || blockedReasonOf(r) || !r.intent_hash) return null;
  const decided = new Set(approvals.map((a) => a.userId));
  const candidates = (pool ?? approverPool(db, r.org_id)).filter((u) => u.id !== r.created_by && !decided.has(u.id));
  const remaining = Math.max(0, Number(r.required_approvals) - approvals.filter((a) => a.counted).length);
  return { candidates, remaining, shortfall: candidates.length < remaining };
}

/**
 * 화면에 보일 '정족수에 들어간 표'.
 * 승인 대기 중이면 현재 역할로 다시 판단한다. 결정이 끝난 요청은 결정 당시 남긴 목록을 쓰므로
 * 나중에 승인자가 퇴사하거나 역할이 바뀌어도 과거 승인 기록이 달라 보이지 않는다.
 * 목록이 없는 오래된 요청(이 기능 이전에 결정된 요청)은 당시 승인 표를 모두 센 것으로 본다.
 */
function countedApproverIds(db: DB, r: any, approvals: any[]): Set<string> {
  if (r.status === 'PENDING_APPROVAL') return new Set(validApproverIds(db, r.id));
  if (typeof r.counted_approver_ids === 'string') {
    try {
      const ids = JSON.parse(r.counted_approver_ids);
      if (Array.isArray(ids)) return new Set(ids.map(String));
    } catch { /* 아래 기본값을 쓴다 */ }
  }
  return new Set(approvals.filter((a) => a.decision === 'approved').map((a) => a.userId as string));
}

/**
 * 지금 저장된 요청·주소록 행으로 다시 계산한 지문이 제출 때 고정한 지문과 다른지(조회할 때마다 본다).
 * 지문이 없는 요청(제출 전·이 기능 도입 전)은 대조할 것이 없어 false. 행을 읽을 수 없으면(수량이 숫자가 아님 등) 다른 것으로 본다.
 */
function intentMismatch(r: any): boolean {
  if (!r.intent_hash) return false;
  try {
    return intentHashOf(intentFieldsOf(r as IntentRow)) !== r.intent_hash;
  } catch {
    return true;
  }
}

function blockedReasonOf(r: any): BlockedReason | null {
  if (r.status !== 'PENDING_APPROVAL') return null;
  if (intentMismatch(r)) return 'INTENT_TAMPERED';
  return r.address_status !== 'ACTIVE' ? 'ADDRESS_NOT_ACTIVE' : null;
}

/**
 * 승인 요청 때 실제로 예약한 지갑·자산·수량. 반려·취소·처리 결과 반영은 이 값으로 예약을 푼다.
 * 승인 요청 뒤 저장 계층에서 요청 행이 바뀌어도(INTENT_TAMPERED) 예약을 잡은 그대로 풀어, 반려·취소가 막히거나 다른 요청의 예약이 함께 풀리지 않게 한다.
 * 예약 기록이 없는 이전 요청은 지금 행의 값을 쓴다.
 */
function reservationOf(r: any): { walletId: string; assetCode: string; units: bigint } {
  if (r.reserved_units != null && r.reserved_wallet_id && r.reserved_asset_code) {
    return { walletId: String(r.reserved_wallet_id), assetCode: String(r.reserved_asset_code), units: BigInt(r.reserved_units) };
  }
  return { walletId: r.wallet_id, assetCode: r.asset_code, units: BigInt(r.amount_units) };
}

/** 예약을 풀고, 감사 기록에 남길 풀린 수량(표시용)을 돌려준다. */
function releaseReservation(db: DB, r: any): { released: string; assetCode: string } {
  const res = reservationOf(r);
  adjustReserved(db, res.walletId, res.assetCode, -res.units);
  return { released: formatUnits(res.units, getAsset(db, res.assetCode).precision), assetCode: res.assetCode };
}

export function allowedActions(r: any, approvals: any[], auth: AuthContext): RequestAction[] {
  const acts: RequestAction[] = [];
  const mine = r.created_by === auth.user.id;
  const can = (a: RequestAction) => TRANSITIONS[a].from.includes(r.status);
  if (mine && auth.perms.has('request.create')) {
    // 받는 주소가 사용 가능 상태가 아니거나(작성·검토 중에 사용 중지됨 등) 저장된 수량을 읽을 수 없으면(앱 밖 저장 계층 변경, A-30)
    // 검토 이동·승인 요청은 서버가 거부하므로 내보이지 않는다. 내용 수정(다른 주소·수량 입력)·작성 단계로 되돌리기·취소는 남긴다.
    const addressUsable = r.address_status === 'ACTIVE';
    const amountReadable = displayAmount(r.amount_units, r.precision) !== null;
    for (const a of ['edit', 'review', 'back_to_draft', 'submit', 'cancel'] as RequestAction[]) {
      if (!can(a)) continue;
      if ((a === 'review' || a === 'submit') && (!addressUsable || !amountReadable)) continue;
      acts.push(a);
    }
  }
  if (!mine && auth.perms.has('request.approve') && can('approve') && !approvals.some((x) => x.userId === auth.user.id)) {
    // 승인할 수 없는 요청(승인 요청 뒤 내용이 바뀜 INTENT_TAMPERED, 받는 주소가 사용 가능 상태가 아님 ADDRESS_NOT_ACTIVE)은
    // 승인을 내보이지 않고 반려만 남긴다. 서버의 승인 거부는 그대로 둔다.
    // 승인 대상 지문이 없는 이전 요청(이 기능 도입 전 제출)도 승인할 수 없으므로 반려만 남긴다(서버는 INTENT_MISSING).
    if (!blockedReasonOf(r) && r.intent_hash) acts.push('approve');
    acts.push('reject');
  }
  return acts;
}

/** 표마다 정족수 포함 여부를 붙인 승인·반려 표. counted: 이 표가 승인 정족수에 들어가는지(반려 표는 false). */
function countedApprovals(db: DB, r: any) {
  const raw = approvalsOf(db, r.id);
  const counted = countedApproverIds(db, r, raw);
  return raw.map((a) => ({ ...a, counted: a.decision === 'approved' && counted.has(a.userId) }));
}

/** 결정 근거(A2-3). 결정 당시 역할은 감사 기록 조회 권한(audit.read)이 있는 조회자에게만 채운다. */
function evidenceFor(db: DB, r: any, approvals: ReturnType<typeof countedApprovals>, auth: AuthContext): DecisionEvidence[] {
  return evidenceOf(db, r.org_id, r.id, (r.intent_hash ?? null) as string | null, approvals, auth.perms.has('audit.read'));
}

/**
 * 한 요청의 결정 근거(표마다). 다른 조직 요청은 404(getRow). 감사 기록 목록·CSV가 요청마다 한 번 부른다.
 */
export function decisionEvidence(db: DB, orgId: string, requestId: string, auth: AuthContext): DecisionEvidence[] {
  const r = getRow(db, orgId, requestId);
  return evidenceFor(db, r, countedApprovals(db, r), auth);
}

/**
 * 홈 진행 중 요청의 '지금 승인할 수 있는 사람'(요청 id → 후보, 승인할 수 없거나 승인 대기가 아니면 null).
 * 조직의 승인 후보는 한 번만 읽고 요청마다 작성자와 결정자를 뺀다. 한 요청을 계산하지 못해도(저장 계층의 이상한 값 등) 그 요청만 null로 두어 홈이 실패하지 않게 한다.
 */
export function waitingForMap(db: DB, orgId: string, ids: string[]): Map<string, ApproverRef[] | null> {
  const out = new Map<string, ApproverRef[] | null>();
  if (ids.length === 0) return out;
  const pool = approverPool(db, orgId);
  for (const id of ids) {
    try {
      const r = getRow(db, orgId, id);
      out.set(id, approvalWaitOf(db, r, countedApprovals(db, r), pool)?.candidates ?? null);
    } catch {
      out.set(id, null);
    }
  }
  return out;
}

export function toRequestDto(db: DB, r: any, auth: AuthContext, withApprovals = true) {
  const counted = withApprovals ? countedApprovals(db, r) : [];
  // 표마다 결정 근거의 지문 대조·결정 당시 역할을 붙인다(정족수 포함 여부 counted는 위에서 계산).
  const evidence = withApprovals ? evidenceFor(db, r, counted, auth) : [];
  const approvals = counted.map((a, i) => ({
    ...a,
    matchesRequestIntent: evidence[i]!.matchesRequestIntent,
    rolesAtDecision: evidence[i]!.rolesAtDecision,
    rolesSource: evidence[i]!.rolesSource,
    approveRoleAtDecision: evidence[i]!.approveRoleAtDecision,
  }));
  const st = REQUEST_STATUS[r.status as RequestStatus];
  return {
    id: r.id as string,
    refNo: r.ref_no as string,
    status: r.status as RequestStatus,
    statusLabel: st.label,
    statusDescription: st.description,
    step: st.step,
    assetCode: r.asset_code as string,
    networkCode: r.network_code as string,
    networkName: r.network_name as string,
    walletName: r.wallet_name as string,
    /** 표시용 수량. 저장 값을 정수로 읽을 수 없으면 null(이때 승인 대기 요청은 blockedReason INTENT_TAMPERED) */
    amount: displayAmount(r.amount_units, r.precision),
    amountUnits: r.amount_units as string,
    precision: r.precision as number,
    purpose: r.purpose as string,
    address: { id: r.address_id as string, label: r.address_label as string, counterparty: r.address_counterparty as string, address: r.address_value as string, memo: r.address_memo as string, status: r.address_status as string },
    requiredApprovals: r.required_approvals as number,
    approvedCount: approvals.filter((a) => a.counted).length,
    approvals,
    approvalBasis: (r.approval_basis ?? null) as ApprovalBasis | null,
    priceAsOfAtSubmit: (r.price_as_of_at_submit ?? null) as string | null,
    blockedReason: blockedReasonOf(r),
    krwValueAtSubmit: r.krw_value_at_submit as string | null,
    /** 승인 대상 지문(제출 때 고정, 16진수 64자). 승인·반려 본문에 그대로 보낸다. 제출 전·이 기능 도입 전 요청은 null */
    intentHash: (r.intent_hash ?? null) as string | null,
    /** 화면 표시용 지문(앞 16자, 4자 묶음) */
    intentHashDisplay: intentHashDisplay(r.intent_hash),
    createdBy: { id: r.created_by as string, name: r.creator_name as string },
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    submittedAt: r.submitted_at as string | null,
    completedAt: r.completed_at as string | null,
    rejectReason: r.reject_reason as string | null,
    failureReason: r.failure_reason as string | null,
    custodyRef: r.custody_ref as string | null,
    version: r.version as number,
    allowedActions: withApprovals ? allowedActions(r, approvals, auth) : [],
    /** 승인 대기 요청을 지금 누가 승인할 수 있는지(A2-1). 상세·행동 응답에만, 목록 응답과 승인할 수 없는 요청은 null. 대기 시작 시각은 submittedAt */
    approvalWait: withApprovals ? approvalWaitOf(db, r, approvals) : null,
  };
}

/** 조회자 조직의 요청 행(다른 조직이면 404). 지급 근거 처리(attachments.ts)도 쓴다. */
export function getRow(db: DB, orgId: string, id: string): any {
  const r = db.prepare(`${SELECT} WHERE r.id = ? AND r.org_id = ?`).get(id, orgId);
  if (!r) throw Errors.notFound('요청');
  return r;
}

/** 요청 행으로 출금 전 점검을 계산한다(작성·검토 중 요청은 볼 때마다, 제출 때는 저장용으로). */
function checksForRow(db: DB, cfg: AppConfig, r: any, nowIso: string): RequestCheck[] {
  return computeChecks(db, cfg.policy, {
    requestId: r.id, orgId: r.org_id, walletId: r.wallet_id, assetCode: r.asset_code, networkCode: r.network_code,
    amountUnits: BigInt(r.amount_units), precision: r.precision, address: normalizeIntentAddress(r.address_value, r.network_family), nowIso,
  });
}

/**
 * 화면에 보일 출금 전 점검. 작성·검토 중이면 지금 기준으로 다시 계산하고(stored=false),
 * 승인 요청 뒤에는 제출 때 저장한 결과와 요청자 사유를 그대로 보여 준다(stored=true). 기록이 없는 이전 요청은 null.
 */
function checksView(db: DB, cfg: AppConfig, r: any): { evaluatedAt: string; stored: boolean; items: RequestCheck[] } | null {
  if (r.status === 'DRAFT' || r.status === 'REVIEW') {
    const at = now();
    // 저장된 수량을 읽을 수 없으면 점검을 계산하지 않는다(null). 조회·수정·취소가 이 때문에 실패하지 않게 한다.
    if (displayAmount(r.amount_units, r.precision) === null) return null;
    return { evaluatedAt: at, stored: false, items: checksForRow(db, cfg, r, at) };
  }
  const s = parseStoredChecks(r.pre_checks);
  return s ? { evaluatedAt: s.evaluatedAt, stored: true, items: s.items } : null;
}

export function getRequest(db: DB, cfg: AppConfig, auth: AuthContext, id: string) {
  const r = getRow(db, auth.org.id, id);
  const dto = toRequestDto(db, r, auth);
  // 처리 기록의 승인·반려 행에는 수행자로 이은 결정 근거를 붙인다(A2-3). 수행자 id(actor_id)는 행에도 근거에도(userId 없음) 넣지 않는다.
  const byUser = new Map(dto.approvals.map((a): [string, DecisionEvidenceView] => [a.userId, {
    name: a.name, decision: a.decision, decidedAt: a.createdAt, intentHashDisplay: a.intentHashDisplay,
    matchesRequestIntent: a.matchesRequestIntent, counted: a.counted, rolesAtDecision: a.rolesAtDecision, rolesSource: a.rolesSource, approveRoleAtDecision: a.approveRoleAtDecision,
  }]));
  const rows = db.prepare("SELECT action, actor_id actorId, actor_name actorName, summary, created_at createdAt FROM audit_log WHERE org_id = ? AND target_type = 'request' AND target_id = ? ORDER BY seq").all(auth.org.id, id) as { action: string; actorId: string | null; actorName: string; summary: string; createdAt: string }[];
  const timeline = rows.map(({ actorId, ...t }) => (DECISION_ACTIONS.has(t.action) ? { ...t, evidence: (actorId && byUser.get(actorId)) || null } : t));
  const balance = balanceFor(db, r.wallet_id, r.asset_code);
  // 지급 근거(A2b, 설계 가정 A-38): 상세·행동 응답에만. 목록 응답(listRequests)의 모양은 그대로다.
  return { ...dto, timeline, available: formatUnits(balance.total - balance.reserved, r.precision), checks: checksView(db, cfg, r), paymentEvidence: paymentEvidenceOf(db, cfg, r, auth) };
}

export function listRequests(db: DB, auth: AuthContext, q: { status?: string; view?: string; q?: string; sort?: string; order?: string; page: number; pageSize: number }) {
  // base: 보기(view)·검색어 조건. 상태 칩의 건수도 같은 조건으로 세어 목록과 어긋나지 않게 한다.
  const base = ['r.org_id = ?'];
  const baseArgs: any[] = [auth.org.id];
  if (q.view === 'mine') { base.push('r.created_by = ?'); baseArgs.push(auth.user.id); }
  if (q.view === 'to_approve') {
    // 받는 주소가 사용 가능 상태가 아닌 요청은 승인할 수 없으므로 승인할 목록에서 뺀다(view=blocked에서 보인다).
    base.push("r.status = 'PENDING_APPROVAL' AND ab.status = 'ACTIVE' AND r.created_by <> ? AND NOT EXISTS (SELECT 1 FROM approvals x WHERE x.request_id = r.id AND x.user_id = ?)");
    baseArgs.push(auth.user.id, auth.user.id);
  }
  if (q.view === 'blocked') base.push("r.status = 'PENDING_APPROVAL' AND ab.status <> 'ACTIVE'");
  if (q.q) {
    base.push("(r.ref_no LIKE ? ESCAPE '\\' OR r.purpose LIKE ? ESCAPE '\\' OR ab.label LIKE ? ESCAPE '\\')");
    const like = likePattern(q.q);
    baseArgs.push(like, like, like);
  }
  const where = [...base];
  const args = [...baseArgs];
  if (q.status) {
    const sts = q.status.split(',').filter((s) => s in REQUEST_STATUS);
    if (sts.length) { where.push(`r.status IN (${sts.map(() => '?').join(',')})`); args.push(...sts); }
  }
  const sortCol = q.sort === 'updated' ? 'r.updated_at' : 'r.created_at';
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const w = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) c FROM withdrawal_requests r JOIN address_book ab ON ab.id = r.address_id WHERE ${w}`).get(...args) as { c: number }).c;
  const rows = db.prepare(`${SELECT} WHERE ${w} ORDER BY ${sortCol} ${dir}, r.ref_no ${dir} LIMIT ? OFFSET ?`).all(...args, q.pageSize, (q.page - 1) * q.pageSize);
  const counts = Object.fromEntries((db.prepare(`SELECT r.status, COUNT(*) c FROM withdrawal_requests r JOIN address_book ab ON ab.id = r.address_id WHERE ${base.join(' AND ')} GROUP BY r.status`).all(...baseArgs) as any[]).map((x) => [x.status, x.c]));
  return { items: rows.map((r) => ({ ...toRequestDto(db, r, auth, false) })), total, page: q.page, pageSize: q.pageSize, counts };
}

function balanceFor(db: DB, walletId: string, assetCode: string) {
  const b = db.prepare('SELECT total_units, reserved_units FROM balances WHERE wallet_id = ? AND asset_code = ?').get(walletId, assetCode) as any;
  return { total: BigInt(b?.total_units ?? '0'), reserved: BigInt(b?.reserved_units ?? '0') };
}

function adjustReserved(db: DB, walletId: string, assetCode: string, delta: bigint) {
  const b = balanceFor(db, walletId, assetCode);
  const next = b.reserved + delta;
  if (next < 0n) throw new AppError(500, 'RESERVE_INCONSISTENT', '예약 수량 계산이 맞지 않아 처리를 멈췄습니다.', '관리자에게 문의하세요.');
  db.prepare('UPDATE balances SET reserved_units = ?, updated_at = ? WHERE wallet_id = ? AND asset_code = ?').run(next.toString(), now(), walletId, assetCode);
}

function amountError(e: unknown): never {
  if (e instanceof AmountError) throw new AppError(422, e.code, e.message, '수량을 확인한 뒤 다시 입력하세요.', [{ field: 'amount', message: e.message }]);
  throw e;
}

/**
 * 받는 주소 검사를 부른 단계. 'new'는 아직 요청이 없는 작성(새 초안·새 초안의 점검 미리 보기),
 * 'DRAFT'·'REVIEW'는 그 상태의 기존 요청이다. 사용 중지된 주소의 복구 행동이 단계마다 다르다.
 */
type AddressCheckStage = 'new' | 'DRAFT' | 'REVIEW';

/** 사용 대기 주소로 요청할 때의 행동. 요청자도 주소 상세에서 직접 정지할 수 있다(설계 가정 A-31, 주소 등록·확인·사용 중지 권한). */
export const COOLING_DOWN_ACTION = '사용 가능해질 때까지 기다린 뒤 다시 요청하세요. 요청한 적 없는 등록이라면 주소 상세에서 「사용 대기 중 정지」로 바로 정지하세요.';

/**
 * 받는 주소가 사용 가능 상태가 아닐 때의 오류(422 ADDRESS_NOT_ACTIVE).
 * - 사용 대기(COOLING_DOWN): 언제부터 쓸 수 있는지(KST)와, 요청하지 않은 등록이면 주소 상세에서 바로 정지하라는 행동을 알린다.
 * - 사용 중지(DISABLED)·등록 거절(REJECTED): 다시 쓸 수 있게 되지 않으므로 다른 주소를 고르거나 요청을 취소하라고 알린다.
 * - 확인 대기(PENDING_REVIEW): 두 번째 담당자의 확인을 기다리라고 알린다.
 */
function addressNotActive(addr: { label: string; status: string; activeFrom: string | null }, withField: boolean, stage: AddressCheckStage = 'new'): AppError {
  if (addr.status === 'COOLING_DOWN') {
    const message = addr.activeFrom
      ? `'${addr.label}' 주소는 사용 대기 중입니다. ${kstDateTime(addr.activeFrom)} KST부터 출금 요청에 쓸 수 있습니다.`
      : `'${addr.label}' 주소는 사용 대기 중이라 아직 출금 요청에 쓸 수 없습니다.`;
    return new AppError(422, 'ADDRESS_NOT_ACTIVE', message, COOLING_DOWN_ACTION,
      withField ? [{ field: 'addressId', message: '사용 대기 중인 주소입니다.' }] : undefined,
      { addressStatus: 'COOLING_DOWN', activeFrom: addr.activeFrom });
  }
  if (addr.status === 'DISABLED' || addr.status === 'REJECTED') {
    const why = addr.status === 'DISABLED' ? '사용 중지되어' : '등록이 거절되어';
    const target = stage === 'new' ? '출금 요청에' : '이 요청에';
    const action = stage === 'new'
      ? '주소록에서 사용 가능한 다른 주소를 고르세요.'
      : stage === 'REVIEW'
        ? '작성 단계로 되돌린 뒤 내용 수정에서 다른 주소를 고르거나 요청을 취소하세요.'
        : '내용 수정에서 다른 주소를 고르거나 요청을 취소하세요.';
    return new AppError(422, 'ADDRESS_NOT_ACTIVE', `'${addr.label}' 주소는 ${why} ${target} 쓸 수 없습니다.`, action,
      withField ? [{ field: 'addressId', message: addr.status === 'DISABLED' ? '사용 중지된 주소입니다.' : '등록이 거절된 주소입니다.' }] : undefined,
      { addressStatus: addr.status });
  }
  const fields = withField ? [{ field: 'addressId', message: '사용 가능한 주소가 아닙니다.' }] : undefined;
  return new AppError(422, 'ADDRESS_NOT_ACTIVE', `'${addr.label}' 주소는 아직 사용할 수 없습니다(현재: ${addr.status === 'PENDING_REVIEW' ? '확인 대기' : '사용 불가'}).`, '두 번째 담당자의 주소 확인이 끝난 뒤 요청하세요.', fields);
}

/**
 * 검토 이동·승인 요청 전에 저장된 수량을 읽을 수 있는지 본다(422 AMOUNT_UNREADABLE).
 * 앱 밖에서 저장 계층의 수량이 정수가 아닌 값(예: '0.5', 'abc')으로 바뀐 작성·검토 중 요청은 수량을 다시 입력하거나 취소해야 한다.
 * 이 검사 없이 진행하면 수량 변환이 실패해 원인을 알 수 없는 500이 된다. 조회·수정·되돌리기·취소는 막지 않는다.
 */
function assertStoredAmountReadable(r: any, stage: 'DRAFT' | 'REVIEW') {
  if (displayAmount(r.amount_units, r.precision) !== null) return;
  throw new AppError(422, 'AMOUNT_UNREADABLE', '저장된 수량을 읽을 수 없어 진행할 수 없습니다.',
    stage === 'REVIEW' ? '작성 단계로 되돌린 뒤 내용 수정에서 수량을 다시 입력하거나 요청을 취소하세요.' : '내용 수정에서 수량을 다시 입력하거나 요청을 취소하세요.',
    [{ field: 'amount', message: '저장된 수량을 읽을 수 없습니다.' }]);
}

/** 입력값 검증: 자산·네트워크·주소·수량. 저장 계층에 넣기 전 서버 기준으로 다시 확인한다. */
function validateDraft(db: DB, auth: AuthContext, input: { assetCode: string; networkCode: string; addressId: string; amount: string }, stage: AddressCheckStage = 'new') {
  const asset = getAsset(db, input.assetCode);
  const network = getNetworkRule(db, input.networkCode);
  assertAssetOnNetwork(db, input.assetCode, input.networkCode);
  let units: bigint;
  try { units = parsePositiveUnits(input.amount, asset.precision); } catch (e) { amountError(e); }
  let addr: any;
  try { addr = getAddressRow(db, auth.org.id, input.addressId); } catch {
    throw new AppError(422, 'ADDRESS_NOT_FOUND', '선택한 받는 주소를 찾을 수 없습니다.', '주소록에서 주소를 다시 선택하세요.', [{ field: 'addressId', message: '주소를 다시 선택하세요.' }]);
  }
  if (addr.asset_code !== input.assetCode || addr.network_code !== input.networkCode) {
    throw new AppError(422, 'ADDRESS_NETWORK_MISMATCH', `선택한 주소는 ${addr.asset_code} / ${addr.network_name}용으로 등록되어 있어 이 요청(${input.assetCode} / ${input.networkCode})에 쓸 수 없습니다.`, '같은 자산·네트워크로 등록된 주소를 고르세요. 네트워크가 다르면 회수가 어려울 수 있습니다.', [{ field: 'addressId', message: '자산·네트워크가 다른 주소입니다.' }]);
  }
  if (addr.status !== 'ACTIVE') throw addressNotActive({ label: addr.label, status: addr.status, activeFrom: addr.active_from ?? null }, true, stage);
  const wallet = db.prepare('SELECT id FROM wallets WHERE org_id = ? AND network_code = ?').get(auth.org.id, input.networkCode) as { id: string } | undefined;
  if (!wallet) throw new AppError(422, 'WALLET_NOT_FOUND', '이 네트워크의 조직 지갑이 없습니다.', '지갑 관리에서 지원 네트워크를 확인하세요.', [{ field: 'networkCode', message: '조직 지갑이 없는 네트워크입니다.' }]);
  return { asset, units: units!, addr, walletId: wallet.id, family: network.family as string };
}

function assertAvailable(db: DB, walletId: string, assetCode: string, units: bigint, precision: number) {
  const b = balanceFor(db, walletId, assetCode);
  const avail = b.total - b.reserved;
  if (units > avail) {
    throw new AppError(422, 'INSUFFICIENT_AVAILABLE', `사용 가능 수량(${formatUnits(avail, precision)} ${assetCode})보다 많습니다.`, '수량을 줄이거나, 승인 대기 중인 다른 요청이 끝난 뒤 다시 시도하세요.', [{ field: 'amount', message: '사용 가능 수량을 넘었습니다.' }]);
  }
}

function lockRow(db: DB, auth: AuthContext, id: string, action: RequestAction, version: number) {
  const r = getRow(db, auth.org.id, id);
  if (!TRANSITIONS[action].from.includes(r.status)) {
    throw new AppError(409, 'INVALID_TRANSITION', `현재 '${REQUEST_STATUS[r.status as RequestStatus].label}' 상태에서는 이 작업을 할 수 없습니다.`, '화면을 새로 고쳐 최신 상태를 확인하세요.', undefined, { status: r.status });
  }
  if (r.version !== version) {
    throw new AppError(409, 'VERSION_CONFLICT', '다른 사용자가 먼저 이 요청을 변경했습니다.', '최신 내용을 다시 확인한 뒤 진행하세요.', undefined, { status: r.status, version: r.version });
  }
  return r;
}

export function requireCreator(r: any, auth: AuthContext) {
  if (!auth.perms.has('request.create')) throw Errors.forbidden('요청 작성·수정');
  if (r.created_by !== auth.user.id) throw new AppError(403, 'NOT_REQUEST_OWNER', '요청을 작성한 사람만 이 작업을 할 수 있습니다.', '작성자에게 요청하세요.');
}

/** 요청 행의 버전·수정 시각을 올린다(지급 근거를 바꿀 때도 올려, 그 전에 연 승인 요청 화면이 409로 다시 불러오게 한다). */
export function bump(db: DB, id: string, version: number, sets: Record<string, unknown>) {
  const keys = Object.keys(sets);
  const sql = `UPDATE withdrawal_requests SET ${keys.map((k) => `${k} = ?, `).join('')}updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`;
  const res = db.prepare(sql).run(...(Object.values(sets) as any[]), now(), id, version);
  if (res.changes !== 1) throw new AppError(409, 'VERSION_CONFLICT', '다른 사용자가 먼저 이 요청을 변경했습니다.', '최신 내용을 다시 확인한 뒤 진행하세요.');
}

/** 요청 감사 기록(내용 앞에 요청 번호). 해시 체인은 writeAudit 하나로만 이어진다. */
export function audit(db: DB, auth: AuthContext, r: any, action: string, summary: string, detail: Record<string, unknown> = {}) {
  writeAudit(db, { orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action, targetType: 'request', targetId: r.id, summary: `${r.ref_no} ${summary}`, detail });
}

/**
 * 조직 안 요청 번호(WR-000001부터). 다른 조직의 요청 수가 번호에 드러나지 않도록 조직마다 따로 센다(고유 제약도 조직·번호 단위, migrations/007).
 * 건수가 아니라 이 조직에서 가장 큰 번호 다음을 쓴다. 이 규칙 전에 전체 공용으로 매긴 번호가 남아 있어도 겹치지 않는다.
 * 호출 측 트랜잭션(BEGIN IMMEDIATE) 안에서 부르므로 동시에 같은 번호를 받지 않는다.
 */
function nextRefNo(db: DB, orgId: string): string {
  const row = db.prepare("SELECT MAX(CAST(SUBSTR(ref_no, 4) AS INTEGER)) n FROM withdrawal_requests WHERE org_id = ? AND ref_no GLOB 'WR-[0-9]*'").get(orgId) as { n: number | null };
  return `WR-${String((row.n ?? 0) + 1).padStart(6, '0')}`;
}

export function createDraft(db: DB, cfg: AppConfig, auth: AuthContext, input: { assetCode: string; networkCode: string; addressId: string; amount: string; purpose: string }, idemKey: string | null) {
  if (!auth.perms.has('request.create')) throw Errors.forbidden('출금 요청 작성');
  const v = validateDraft(db, auth, input);
  const id = randomUUID();
  const refNo = nextRefNo(db, auth.org.id);
  const t = now();
  db.prepare(
    `INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, created_by, created_at, updated_at, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
  ).run(id, auth.org.id, refNo, v.walletId, input.assetCode, input.networkCode, v.units.toString(), input.addressId, input.purpose.trim(), auth.user.id, t, t, idemKey);
  writeAudit(db, { orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'request.created', targetType: 'request', targetId: id, summary: `${refNo} 출금 요청 작성: ${formatUnits(v.units, v.asset.precision)} ${input.assetCode} → ${v.addr.label}` });
  return getRequest(db, cfg, auth, id);
}

export function updateDraft(db: DB, cfg: AppConfig, auth: AuthContext, id: string, input: { assetCode: string; networkCode: string; addressId: string; amount: string; purpose: string; version: number }) {
  return tx(db, () => {
    const r = lockRow(db, auth, id, 'edit', input.version);
    requireCreator(r, auth);
    const v = validateDraft(db, auth, input, 'DRAFT');
    bump(db, id, input.version, { wallet_id: v.walletId, asset_code: input.assetCode, network_code: input.networkCode, amount_units: v.units.toString(), address_id: input.addressId, purpose: input.purpose.trim() });
    // 해시 체인에 무엇이 무엇으로 바뀌었는지 남긴다. 주소는 끝자리만 남긴다.
    const before = { assetCode: r.asset_code, networkCode: r.network_code, amount: displayAmount(r.amount_units, r.precision), addressId: r.address_id, addressLabel: r.address_label, addressTail: tailOf(r.address_value) };
    const after = { assetCode: input.assetCode, networkCode: input.networkCode, amount: formatUnits(v.units, v.asset.precision), addressId: input.addressId, addressLabel: v.addr.label, addressTail: tailOf(v.addr.address) };
    audit(db, auth, r, 'request.updated', '작성 내용 수정', { before, after });
    return getRequest(db, cfg, auth, id);
  });
}

/**
 * 저장하기 전 작성 화면의 출금 전 점검 미리 보기. 아무것도 저장하지 않는다.
 * requestId: 고치는 중인 초안이 있으면 그 요청을 과거 기록·건수에서 뺀다.
 */
export function previewChecks(db: DB, cfg: AppConfig, auth: AuthContext, input: { assetCode: string; networkCode: string; addressId: string; amount: string; requestId?: string }) {
  if (!auth.perms.has('request.create')) throw Errors.forbidden('출금 전 점검');
  const v = validateDraft(db, auth, input, input.requestId ? 'DRAFT' : 'new');
  const evaluatedAt = now();
  const items = computeChecks(db, cfg.policy, {
    requestId: input.requestId ?? null, orgId: auth.org.id, walletId: v.walletId, assetCode: input.assetCode, networkCode: input.networkCode,
    amountUnits: v.units, precision: v.asset.precision, address: normalizeIntentAddress(v.addr.address, v.family), nowIso: evaluatedAt,
  });
  return { evaluatedAt, items };
}

export function moveToReview(db: DB, cfg: AppConfig, auth: AuthContext, id: string, version: number) {
  return tx(db, () => {
    const r = lockRow(db, auth, id, 'review', version);
    requireCreator(r, auth);
    assertStoredAmountReadable(r, 'DRAFT');
    validateDraft(db, auth, { assetCode: r.asset_code, networkCode: r.network_code, addressId: r.address_id, amount: formatUnits(r.amount_units, r.precision) }, 'DRAFT');
    assertAvailable(db, r.wallet_id, r.asset_code, BigInt(r.amount_units), r.precision);
    bump(db, id, version, { status: 'REVIEW' });
    audit(db, auth, r, 'request.reviewing', '검토 단계로 이동');
    return getRequest(db, cfg, auth, id);
  });
}

export function backToDraft(db: DB, cfg: AppConfig, auth: AuthContext, id: string, version: number) {
  return tx(db, () => {
    const r = lockRow(db, auth, id, 'back_to_draft', version);
    requireCreator(r, auth);
    bump(db, id, version, { status: 'DRAFT' });
    audit(db, auth, r, 'request.back_to_draft', '수정을 위해 작성 단계로 되돌림');
    return getRequest(db, cfg, auth, id);
  });
}

export function submitForApproval(db: DB, cfg: AppConfig, auth: AuthContext, id: string, input: { version: number; confirmTail: string; checkReasons?: Partial<Record<string, string>> }) {
  return tx(db, () => {
    const r = lockRow(db, auth, id, 'submit', input.version);
    requireCreator(r, auth);
    assertStoredAmountReadable(r, 'REVIEW');
    validateDraft(db, auth, { assetCode: r.asset_code, networkCode: r.network_code, addressId: r.address_id, amount: formatUnits(r.amount_units, r.precision) }, 'REVIEW');
    const n = cfg.policy.addressBook.confirmTailLength;
    if (input.confirmTail.trim().toUpperCase() !== String(r.address_value).slice(-n).toUpperCase()) {
      throw new AppError(422, 'CONFIRM_TAIL_MISMATCH', `입력한 끝 ${n}자리가 받는 주소와 다릅니다.`, '화면의 받는 주소를 받는 곳이 알려 준 원본과 대조한 뒤 다시 입력하세요.', [{ field: 'confirmTail', message: '주소 끝자리와 일치하지 않습니다.' }]);
    }
    const units = BigInt(r.amount_units);
    assertAvailable(db, r.wallet_id, r.asset_code, units, r.precision);
    // 출금 전 점검(F8·F13·F14): 제출 시점에 다시 계산하고, 사유가 필요한 주의 항목마다 요청자 사유를 받는다(설계 가정 A-27·A-28).
    const evaluatedAt = now();
    const checks = attachCheckReasons(checksForRow(db, cfg, r, evaluatedAt), input.checkReasons);
    const quorum = decideRequiredApprovals(db, cfg, r.asset_code, units, r.precision);
    const eligible = eligibleApprovers(db, auth.org.id, r.created_by);
    if (eligible < quorum.required) {
      const message = eligible === 0
        ? `승인할 수 있는 사람이 없어 필요한 ${quorum.required}명을 채울 수 없습니다.`
        : `승인 가능한 사람이 ${eligible}명뿐이라 필요한 ${quorum.required}명을 채울 수 없습니다.`;
      throw new AppError(422, 'APPROVERS_INSUFFICIENT', message, '조직 관리자에게 승인자 추가를 요청하세요.', undefined, { eligibleApprovers: eligible, requiredApprovals: quorum.required, approvalBasis: quorum.basis });
    }
    // 승인 대상 지문(F10): 무엇을 승인받는지(자산·네트워크·수량·받는 주소·메모·필요 승인 수)를 제출 때 고정한다(설계 가정 A-29).
    const intentHash = intentHashOf(intentFieldsOf({ ...(r as IntentRow), required_approvals: quorum.required }));
    const display = intentHashDisplay(intentHash);
    adjustReserved(db, r.wallet_id, r.asset_code, units);
    bump(db, id, input.version, { status: 'PENDING_APPROVAL', submitted_at: now(), required_approvals: quorum.required, krw_value_at_submit: quorum.krw?.toString() ?? null, approval_basis: quorum.basis, price_as_of_at_submit: quorum.priceAsOf });
    // 지문과 점검 결과, 실제로 예약한 지갑·자산·수량은 바꿀 수 없는 기록으로 한 번만 남긴다(migrations/006, 수정·삭제 트리거).
    // 반려·취소·처리 결과 반영은 이 예약 기록으로 예약을 푼다(reservationOf).
    db.prepare('INSERT INTO request_intents (request_id, intent_version, intent_hash, pre_checks, reserved_wallet_id, reserved_asset_code, reserved_units, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, INTENT_VERSION, intentHash, serializeChecks(evaluatedAt, checks), r.wallet_id, r.asset_code, units.toString(), evaluatedAt);
    const note = quorum.basis === 'price_missing' ? ' · 시세를 확인할 수 없어 고액 기준 적용' : quorum.basis === 'price_stale' ? ' · 시세가 지연되어 고액 기준 적용' : '';
    const cautions = checks.filter((c) => c.outcome !== 'pass');
    audit(db, auth, r, 'request.submitted', `승인 요청 (필요 승인 ${quorum.required}명${note}) · 지문 ${display}`, {
      requiredApprovals: quorum.required,
      approvalBasis: quorum.basis,
      krwValue: quorum.krw?.toString() ?? null,
      priceAsOf: quorum.priceAsOf,
      reserved: formatUnits(units, r.precision),
      assetCode: r.asset_code,
      networkCode: r.network_code,
      amount: formatUnits(units, r.precision),
      addressId: r.address_id,
      addressLabel: r.address_label,
      addressTail: tailOf(r.address_value),
      memoSet: String(r.address_memo ?? '') !== '',
      intentHash,
      checks: checks.map((c) => ({ id: c.id, outcome: c.outcome, requiresReason: c.requiresReason })),
      checkReasons: Object.fromEntries(cautions.filter((c) => c.reason).map((c) => [c.id, c.reason])),
      // 승인 요청 때 고정된 지급 근거 목록(A2b): 파일 id·이름·형식·크기·SHA-256과 메모의 길이·SHA-256만. 승인 대상 지문에는 넣지 않는다.
      paymentEvidence: evidenceSnapshot(db, id),
    });
    return getRequest(db, cfg, auth, id);
  });
}

/**
 * 필요 승인 수 결정 (설계 가정, A-03). 시세가 없거나 기준 시각이 priceStaleAfterMinutes보다 오래되었거나
 * 기준 시각을 믿을 수 없으면 평가액을 근거로 쓸 수 없으므로 고액 기준을 적용한다(fail closed).
 * 어떤 경우에도 기본 승인 수보다 적어지지 않는다. 시세 판단은 출금 전 점검과 같은 함수(readPrice)를 쓴다.
 */
export function decideRequiredApprovals(db: DB, cfg: AppConfig, assetCode: string, units: bigint, precision: number): { required: number; basis: ApprovalBasis; krw: bigint | null; priceAsOf: string | null } {
  const p = cfg.policy.approval;
  const high = Math.max(p.highValueRequiredApprovals, p.defaultRequiredApprovals);
  const price = readPrice(db, assetCode, cfg.policy.priceStaleAfterMinutes);
  if (price.kind === 'missing') return { required: high, basis: 'price_missing', krw: null, priceAsOf: null };
  const krw = krwValue(units, precision, price.krwPrice);
  if (price.kind === 'stale') return { required: high, basis: 'price_stale', krw, priceAsOf: price.asOf };
  if (krw >= BigInt(p.highValueThresholdKrw)) return { required: high, basis: 'value_at_or_above_threshold', krw, priceAsOf: price.asOf };
  return { required: p.defaultRequiredApprovals, basis: 'value_below_threshold', krw, priceAsOf: price.asOf };
}

/** 승인·반려 본문의 지문 형식: 없으면(undefined) 거부, null은 지문이 없는 이전 요청을 반려할 때만 받는다. */
export type ProvidedIntent = string | null | undefined;

export interface IntentMismatchRecord {
  orgId: string;
  requestId: string;
  refNo: string;
  decision: 'approve' | 'reject';
  /** 제출 때 고정한 지문(지문이 없는 이전 요청은 null) */
  storedHash: string | null;
  /** 결정 본문에 실려 온 지문의 앞부분(소문자, 최대 16자). 보내지 않았으면 null */
  submittedHashPrefix: string | null;
  actor: { id: string; name: string };
}

/**
 * 승인·반려 본문의 지문이 제출 때 고정한 지문과 다르다(409 INTENT_CHANGED).
 * 제출 뒤 지문 기록은 바뀌지 않으므로, 다른 지문이 왔다는 것은 결정하는 사람의 화면이 고정된 내용과 다른 것을 보였다는 신호다(F10).
 * 결정 트랜잭션은 되돌리고, 호출 측(app.ts)이 되돌림 뒤 recordIntentMismatch로 감사 기록을 남긴다. 응답에는 record를 싣지 않는다.
 */
export class IntentChangedError extends AppError {
  constructor(readonly record: IntentMismatchRecord) {
    super(409, 'INTENT_CHANGED', '결정하려던 내용과 지금 요청의 승인 대상 지문이 다릅니다.', '화면을 새로 고쳐 요청 내용과 승인 대상 지문을 다시 확인한 뒤 결정하세요.', undefined, { intentHashDisplay: intentHashDisplay(record.storedHash) });
  }
}

/** 결정 본문의 지문 불일치 감사 기록. 결정 트랜잭션이 되돌려진 뒤 별도 트랜잭션에서 부른다(되돌림에 함께 지워지지 않게). */
export function recordIntentMismatch(db: DB, e: IntentChangedError) {
  const x = e.record;
  const what = x.decision === 'approve' ? '승인' : '반려';
  writeAudit(db, {
    orgId: x.orgId, actorId: x.actor.id, actorName: x.actor.name, action: 'request.intent_mismatch', targetType: 'request', targetId: x.requestId,
    summary: `${x.refNo} 다른 승인 대상 지문으로 ${what}하려 해 거부 (${x.actor.name})`,
    // voteRecorded: 승인·반려 표를 남기지 않았다(결정 트랜잭션을 되돌림).
    detail: { decision: x.decision, storedHash: x.storedHash, submittedHashPrefix: x.submittedHashPrefix, actor: x.actor, voteRecorded: false },
  });
}

/**
 * 승인·반려하려는 사람이 화면에서 본 지문이 제출 때 고정한 지문과 같은지 확인한다.
 * - 본문에 지문이 없으면 422(필드 intentHash)
 * - 지문이 없는 이전 요청: 승인은 409 INTENT_MISSING(대조할 수 없어 fail closed), 반려는 지문 null로만 허용
 * - 다르면 409 INTENT_CHANGED(IntentChangedError, 감사 기록 request.intent_mismatch)
 */
function assertIntentMatches(r: any, provided: ProvidedIntent, kind: 'approve' | 'reject', auth: AuthContext) {
  if (provided === undefined || provided === '') {
    throw new AppError(422, 'VALIDATION', '승인 대상 지문이 없습니다.', '화면을 새로 고쳐 승인 대상 지문을 확인한 뒤 다시 시도하세요.', [{ field: 'intentHash', message: '승인 대상 지문을 함께 보내야 합니다.' }]);
  }
  const stored = (r.intent_hash ?? null) as string | null;
  if (!stored) {
    if (kind === 'reject' && provided === null) return;
    if (kind === 'approve') {
      throw new AppError(409, 'INTENT_MISSING', '이 요청은 승인 대상 지문을 기록하기 전에 승인 요청되어 지금 내용과 대조할 수 없습니다.', '승인하지 말고 반려하세요. 요청자는 같은 내용으로 새 요청을 작성할 수 있습니다.');
    }
  }
  if (provided === null || provided.trim().toLowerCase() !== stored) {
    throw new IntentChangedError({
      orgId: r.org_id, requestId: r.id, refNo: r.ref_no, decision: kind, storedHash: stored,
      submittedHashPrefix: provided === null ? null : provided.trim().toLowerCase().slice(0, SUBMITTED_HASH_PREFIX_LENGTH),
      actor: { id: auth.user.id, name: auth.user.name },
    });
  }
}

export interface IntentTamperRecord {
  orgId: string;
  requestId: string;
  refNo: string;
  stage: 'approve' | 'handoff';
  storedHash: string | null;
  /** 지금 저장된 행으로 다시 계산한 지문. 행을 읽을 수 없으면(수량이 정수가 아님 등) null */
  recomputedHash: string | null;
  /** 정족수에 든 승인 표 중 요청의 지문과 다른 지문(또는 지문 없음)을 승인한 사람 */
  mismatchedApproverIds: string[];
  attemptedBy: { id: string; name: string };
  current: Record<string, unknown>;
}

/**
 * 저장된 요청 행으로 다시 계산한 지문이 제출 때 고정한 지문과 다르다(저장 계층에서 내용이 바뀜).
 * 승인 트랜잭션은 되돌리고 커스터디로 넘기지 않는다. 호출 측(app.ts)이 되돌림 뒤 recordIntentTampered로 감사 기록을 남긴다.
 * 응답에는 원인과 행동만 보낸다(record는 보내지 않는다).
 */
export class IntentTamperedError extends AppError {
  constructor(readonly record: IntentTamperRecord) {
    super(409, 'INTENT_TAMPERED', '요청 내용이 승인 요청 때 고정한 승인 대상 지문과 맞지 않아 처리하지 않았습니다.', '이 요청은 승인하지 말고 사유와 함께 반려하세요. 보안 담당자에게 알리세요.');
  }
}

/** 지문 불일치 감사 기록. 승인 트랜잭션이 되돌려진 뒤 별도 트랜잭션에서 부른다(되돌림에 함께 지워지지 않게). */
export function recordIntentTampered(db: DB, e: IntentTamperedError) {
  const x = e.record;
  writeAudit(db, {
    orgId: x.orgId, actorId: null, actorName: INTENT_CHECK_ACTOR, action: 'request.intent_tampered', targetType: 'request', targetId: x.requestId,
    summary: `${x.refNo} 승인 대상 지문 불일치로 ${x.stage === 'handoff' ? '커스터디 전달' : '승인'} 중단 (${x.attemptedBy.name} 승인 시도)`,
    detail: {
      stage: x.stage, storedHash: x.storedHash, recomputedHash: x.recomputedHash, mismatchedApproverIds: x.mismatchedApproverIds,
      attemptedBy: x.attemptedBy, current: x.current, custodyCalled: false,
    },
  });
}

/**
 * 지금 저장된 행으로 지문을 다시 계산해 제출 때 고정한 지문과 대조한다(커스터디 전달 직전 재확인).
 * approverIds를 주면 그 사람들의 승인 표가 모두 같은 지문을 승인했는지도 본다.
 */
function assertIntentIntact(db: DB, auth: AuthContext, r: any, stage: 'approve' | 'handoff', approverIds: string[] = []) {
  // 행을 읽을 수 없으면(수량이 정수가 아님 등) 지문을 다시 계산할 수 없으므로 다른 것으로 본다(조회의 INTENT_TAMPERED와 같은 기준).
  let recomputed: string | null;
  try { recomputed = intentHashOf(intentFieldsOf(r as IntentRow)); } catch { recomputed = null; }
  const stored = (r.intent_hash ?? null) as string | null;
  const votes = new Map((db.prepare('SELECT user_id, intent_hash FROM approval_intents WHERE request_id = ?').all(r.id) as { user_id: string; intent_hash: string | null }[]).map((v) => [v.user_id, v.intent_hash]));
  const mismatched = approverIds.filter((uid) => !stored || votes.get(uid) !== stored);
  if (stored && recomputed === stored && mismatched.length === 0) return;
  throw new IntentTamperedError({
    orgId: r.org_id, requestId: r.id, refNo: r.ref_no, stage, storedHash: stored, recomputedHash: recomputed, mismatchedApproverIds: mismatched,
    attemptedBy: { id: auth.user.id, name: auth.user.name },
    current: {
      assetCode: r.asset_code, networkCode: r.network_code, amount: displayAmount(r.amount_units, r.precision), amountUnits: String(r.amount_units ?? ''), addressId: r.address_id,
      addressLabel: r.address_label, addressTail: tailOf(r.address_value), memoSet: String(r.address_memo ?? '') !== '', requiredApprovals: r.required_approvals,
    },
  });
}

export function approveRequest(db: DB, cfg: AppConfig, auth: AuthContext, custody: CustodyAdapter, id: string, input: { version: number; intentHash?: string | null }) {
  return tx(db, () => {
    if (!auth.perms.has('request.approve')) throw Errors.forbidden('요청 승인');
    const r = getRow(db, auth.org.id, id);
    if (r.created_by === auth.user.id) {
      throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', '본인이 작성한 요청은 승인할 수 없습니다.', '다른 승인자에게 승인을 요청하세요.');
    }
    if (approvalsOf(db, id).some((a) => a.userId === auth.user.id)) {
      throw new AppError(409, 'ALREADY_DECIDED', '이미 이 요청에 결정을 남겼습니다.', '다른 승인자의 결정을 기다리세요.');
    }
    lockRow(db, auth, id, 'approve', input.version);
    // 화면에서 본 지문 = 제출 때 지문 = 지금 저장된 내용으로 다시 계산한 지문이어야 승인 표를 남긴다.
    assertIntentMatches(r, input.intentHash, 'approve', auth);
    assertIntentIntact(db, auth, r, 'approve');
    if (r.address_status !== 'ACTIVE') {
      if (r.address_status === 'COOLING_DOWN') throw addressNotActive({ label: r.address_label, status: r.address_status, activeFrom: r.address_active_from ?? null }, false);
      throw new AppError(422, 'ADDRESS_NOT_ACTIVE', '받는 주소가 더 이상 사용 가능 상태가 아닙니다.', '요청을 반려하고 주소 상태를 확인하세요.');
    }
    const decidedAt = now();
    db.prepare("INSERT INTO approvals (request_id, user_id, decision, created_at) VALUES (?, ?, 'approved', ?)").run(id, auth.user.id, decidedAt);
    db.prepare('INSERT INTO approval_intents (request_id, user_id, intent_hash, created_at) VALUES (?, ?, ?, ?)').run(id, auth.user.id, r.intent_hash, decidedAt);
    // 정족수는 지금 유효한 표만 센다. 승인 뒤 역할을 잃었거나 비활성화된 사람의 표는 빠진다.
    const validIds = validApproverIds(db, id);
    const valid = validIds.length;
    const notCounted = approvalsOf(db, id).filter((a) => a.decision === 'approved' && !validIds.includes(a.userId)).map((a) => a.userId as string);
    const display = intentHashDisplay(r.intent_hash);
    audit(db, auth, r, 'request.approved', `승인 (유효 ${valid}/${r.required_approvals}) · 지문 ${display}`, { validApprovals: valid, required: r.required_approvals, notCountedApproverIds: notCounted, intentHash: r.intent_hash });
    const snapshot = JSON.stringify(validIds);
    if (valid >= r.required_approvals) {
      // 커스터디로 넘기기 직전: 지금 저장된 행을 다시 읽어 지문을 다시 계산하고, 정족수에 든 승인 표가 모두 같은 지문을 승인했는지 본다.
      // 다르면 IntentTamperedError로 이 트랜잭션(승인 표 포함)을 되돌리고 커스터디를 부르지 않는다.
      const fresh = getRow(db, auth.org.id, id);
      assertIntentIntact(db, auth, fresh, 'handoff', validIds);
      // 커스터디에는 지문에 묶은 정규화 값(10진 정수 수량, 계열 규칙으로 정규화한 주소, 앞뒤 공백을 지운 메모)을 그대로 넘긴다.
      // 저장된 글자열을 넘기면 숫자로는 같지만 다른 표기(16진수·앞자리 0·공백·대소문자)가 재확인을 통과한 채 커스터디에 닿는다.
      const bound = intentFieldsOf(fresh as IntentRow);
      // 커스터디 호출은 승인 트랜잭션 안, 상태 변경 바로 앞에 둔다. 뒤에서 실패해 되돌려지고 다시 시도되어도
      // 같은 멱등 키(요청 id)를 쓰므로 어댑터는 같은 접수 참조를 돌려준다.
      const idempotencyKey = id;
      const { ref } = custody.submitWithdrawal({
        requestId: id, idempotencyKey, assetCode: bound.assetCode, networkCode: bound.networkCode, amountUnits: bound.amountUnits,
        address: bound.address, memo: bound.memo, intentHash: fresh.intent_hash,
      });
      bump(db, id, input.version, { status: 'PROCESSING', processing_started_at: now(), custody_ref: ref, counted_approver_ids: snapshot });
      writeAudit(db, {
        orgId: auth.org.id, actorId: null, actorName: custody.name, action: 'request.processing', targetType: 'request', targetId: id,
        summary: `${r.ref_no} 커스터디 처리 시작 (${ref})`,
        detail: {
          idempotencyKey, custodyRef: ref, assetCode: bound.assetCode, networkCode: bound.networkCode, amount: formatUnits(bound.amountUnits, fresh.precision),
          addressId: bound.addressId, addressLabel: fresh.address_label, addressTail: tailOf(bound.address), memoSet: bound.memo !== '',
          approverIds: validIds, intentHash: fresh.intent_hash,
        },
      });
    } else {
      bump(db, id, input.version, { counted_approver_ids: snapshot });
    }
    return getRequest(db, cfg, auth, id);
  });
}

export function rejectRequest(db: DB, cfg: AppConfig, auth: AuthContext, id: string, input: { version: number; reason: string; intentHash?: string | null }) {
  return tx(db, () => {
    if (!auth.perms.has('request.approve')) throw Errors.forbidden('요청 반려');
    const r = getRow(db, auth.org.id, id);
    if (r.created_by === auth.user.id) {
      throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', '본인이 작성한 요청은 반려할 수 없습니다. 작성자는 취소를 사용하세요.', '요청을 거두려면 취소하세요.');
    }
    if (approvalsOf(db, id).some((a) => a.userId === auth.user.id)) {
      throw new AppError(409, 'ALREADY_DECIDED', '이미 이 요청에 결정을 남겼습니다.', '다른 승인자의 결정을 기다리세요.');
    }
    lockRow(db, auth, id, 'reject', input.version);
    // 반려도 어떤 내용을 반려했는지 지문으로 묶는다. 지문이 맞지 않는 요청(내용이 바뀐 요청)을 반려하는 것은 막지 않는다(위험을 줄이는 행동).
    assertIntentMatches(r, input.intentHash, 'reject', auth);
    const decidedAt = now();
    db.prepare("INSERT INTO approvals (request_id, user_id, decision, reason, created_at) VALUES (?, ?, 'rejected', ?, ?)").run(id, auth.user.id, input.reason.trim(), decidedAt);
    db.prepare('INSERT INTO approval_intents (request_id, user_id, intent_hash, created_at) VALUES (?, ?, ?, ?)').run(id, auth.user.id, r.intent_hash ?? null, decidedAt);
    // 지금 행의 수량이 아니라 승인 요청 때 예약한 수량을 푼다(내용이 바뀐 요청도 반려할 수 있게).
    const rel = releaseReservation(db, r);
    bump(db, id, input.version, { status: 'REJECTED', reject_reason: input.reason.trim(), completed_at: now(), counted_approver_ids: JSON.stringify(validApproverIds(db, id)) });
    audit(db, auth, r, 'request.rejected', '반려', {
      reason: input.reason.trim(), intentHash: r.intent_hash ?? null, released: rel.released, releasedAssetCode: rel.assetCode,
      ...(r.intent_hash ? { contentMatchesIntent: !intentMismatch(r) } : {}),
    });
    return getRequest(db, cfg, auth, id);
  });
}

export function cancelRequest(db: DB, cfg: AppConfig, auth: AuthContext, id: string, version: number) {
  return tx(db, () => {
    const r = lockRow(db, auth, id, 'cancel', version);
    requireCreator(r, auth);
    const wasPending = r.status === 'PENDING_APPROVAL';
    // 승인 대기였다면 승인 요청 때 예약한 수량을 그대로 푼다(지금 행의 수량이 바뀌었어도).
    const rel = wasPending ? releaseReservation(db, r) : null;
    bump(db, id, version, { status: 'CANCELLED', completed_at: now(), ...(wasPending ? { counted_approver_ids: JSON.stringify(validApproverIds(db, id)) } : {}) });
    audit(db, auth, r, 'request.cancelled', '요청자 취소', rel ? {
      released: rel.released, releasedAssetCode: rel.assetCode, ...(r.intent_hash ? { contentMatchesIntent: !intentMismatch(r) } : {}),
    } : {});
    return getRequest(db, cfg, auth, id);
  });
}

/** 모의 커스터디 처리 결과 반영. 서버 재시작 뒤에도 PROCESSING 건을 다시 확인한다. */
export function settleProcessing(db: DB, custody: CustodyAdapter): number {
  const rows = db.prepare(`${SELECT} WHERE r.status = 'PROCESSING'`).all() as any[];
  let n = 0;
  for (const r of rows) {
    const st = custody.getStatus(r.custody_ref, r.processing_started_at);
    if (st === 'processing') continue;
    tx(db, () => {
      const cur = db.prepare('SELECT status, version FROM withdrawal_requests WHERE id = ?').get(r.id) as any;
      if (cur.status !== 'PROCESSING') return;
      // 승인 요청 때 예약한 지갑·자산·수량. 커스터디로 넘기기 직전에 지문을 다시 대조했으므로 넘긴 수량과 같다.
      const res = reservationOf(r);
      const units = res.units;
      const b = balanceFor(db, res.walletId, res.assetCode);
      adjustReserved(db, res.walletId, res.assetCode, -units);
      if (st === 'completed' && b.total >= units) {
        db.prepare('UPDATE balances SET total_units = ?, updated_at = ? WHERE wallet_id = ? AND asset_code = ?').run((b.total - units).toString(), now(), res.walletId, res.assetCode);
        db.prepare("UPDATE withdrawal_requests SET status = 'COMPLETED', completed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(now(), now(), r.id);
        db.prepare("INSERT INTO transactions (id, org_id, wallet_id, type, asset_code, network_code, amount_units, counterparty, status, occurred_at, request_id, tx_ref) VALUES (?, ?, ?, 'withdrawal', ?, ?, ?, ?, 'completed', ?, ?, ?)")
          .run(randomUUID(), r.org_id, res.walletId, res.assetCode, r.network_code, units.toString(), r.address_label, now(), r.id, r.custody_ref);
        writeAudit(db, { orgId: r.org_id, actorId: null, actorName: custody.name, action: 'request.completed', targetType: 'request', targetId: r.id, summary: `${r.ref_no} 처리 완료 (모의)` });
      } else {
        const reason = st === 'failed' ? '커스터디 처리 실패(모의)' : '보유 수량 부족으로 처리하지 못했습니다.';
        db.prepare("UPDATE withdrawal_requests SET status = 'FAILED', failure_reason = ?, completed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(reason, now(), now(), r.id);
        writeAudit(db, { orgId: r.org_id, actorId: null, actorName: custody.name, action: 'request.failed', targetType: 'request', targetId: r.id, summary: `${r.ref_no} 처리 실패: ${reason}` });
      }
      n++;
    });
  }
  return n;
}
