import { randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';
import { now, tx } from '../db.ts';
import { AppError, Errors } from '../errors.ts';
import { writeAudit } from '../audit.ts';
import type { AuthContext } from '../auth.ts';
import type { AppConfig } from '../config.ts';
import type { CustodyAdapter } from '../adapters/custody.ts';
import { permissionsFor } from '../authz.ts';
import { AmountError, formatUnits, krwValue, parsePositiveUnits } from '../../shared/decimal.ts';
import { REQUEST_STATUS, type RequestStatus, type Role } from '../../shared/terms.ts';
import { assertAssetOnNetwork, getAsset, getNetworkRule } from './catalog.ts';
import { getAddressRow, likePattern } from './addresses.ts';

export type RequestAction = 'edit' | 'review' | 'back_to_draft' | 'submit' | 'approve' | 'reject' | 'cancel';

/**
 * 제출 시 필요 승인 수를 정한 근거 (설계 가정, docs/assumptions.md A-03).
 * 시세가 없거나 오래되면 원화 평가액을 믿을 수 없으므로 고액 기준을 적용한다(fail closed).
 */
export type ApprovalBasis = 'value_below_threshold' | 'value_at_or_above_threshold' | 'price_missing' | 'price_stale';

/** 승인 대기 요청이 승인될 수 없는 이유. 지금은 받는 주소가 사용 가능 상태가 아닌 경우뿐이다. */
export type BlockedReason = 'ADDRESS_NOT_ACTIVE';

/** 시세 기준 시각이 이보다 더 미래이면 잘못된 값으로 보고 지연과 같게 다룬다(시계 차이 허용 폭). */
const PRICE_FUTURE_SKEW_MS = 5 * 60_000;

/** 감사 기록에 남길 주소 끝자리 길이. 전체 주소는 남기지 않고 대조에 필요한 끝부분만 남긴다. */
const AUDIT_TAIL_LENGTH = 6;
const tailOf = (address: unknown) => String(address ?? '').slice(-AUDIT_TAIL_LENGTH);

const OPEN: RequestStatus[] = ['DRAFT', 'REVIEW', 'PENDING_APPROVAL'];

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

const SELECT = `SELECT r.*, a.precision, n.name network_name, w.name wallet_name, u.name creator_name,
    ab.label address_label, ab.address address_value, ab.memo address_memo, ab.status address_status, ab.counterparty address_counterparty
  FROM withdrawal_requests r
  JOIN assets a ON a.code = r.asset_code
  JOIN networks n ON n.code = r.network_code
  JOIN wallets w ON w.id = r.wallet_id
  JOIN users u ON u.id = r.created_by
  JOIN address_book ab ON ab.id = r.address_id`;

function approvalsOf(db: DB, id: string) {
  return db.prepare('SELECT ap.user_id userId, u.name, ap.decision, ap.reason, ap.created_at createdAt FROM approvals ap JOIN users u ON u.id = ap.user_id WHERE ap.request_id = ? ORDER BY ap.created_at').all(id) as any[];
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

/** 작성자를 뺀, 지금 승인할 수 있는 조직 구성원 수 */
function eligibleApprovers(db: DB, orgId: string, creatorId: string): number {
  const users = db.prepare('SELECT id FROM users WHERE org_id = ? AND is_active = 1 AND id <> ?').all(orgId, creatorId) as { id: string }[];
  return users.filter((u) => canApproveNow(db, u.id, orgId)).length;
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

function blockedReasonOf(r: any): BlockedReason | null {
  return r.status === 'PENDING_APPROVAL' && r.address_status !== 'ACTIVE' ? 'ADDRESS_NOT_ACTIVE' : null;
}

export function allowedActions(r: any, approvals: any[], auth: AuthContext): RequestAction[] {
  const acts: RequestAction[] = [];
  const mine = r.created_by === auth.user.id;
  const can = (a: RequestAction) => TRANSITIONS[a].from.includes(r.status);
  if (mine && auth.perms.has('request.create')) {
    for (const a of ['edit', 'review', 'back_to_draft', 'submit', 'cancel'] as RequestAction[]) if (can(a)) acts.push(a);
  }
  if (!mine && auth.perms.has('request.approve') && can('approve') && !approvals.some((x) => x.userId === auth.user.id)) {
    // 받는 주소가 사용 가능 상태가 아니면 승인은 내보이지 않고 반려만 남긴다. 서버의 승인 거부(ADDRESS_NOT_ACTIVE)는 그대로 둔다.
    if (r.address_status === 'ACTIVE') acts.push('approve');
    acts.push('reject');
  }
  return acts;
}

export function toRequestDto(db: DB, r: any, auth: AuthContext, withApprovals = true) {
  const raw = withApprovals ? approvalsOf(db, r.id) : [];
  const counted = withApprovals ? countedApproverIds(db, r, raw) : new Set<string>();
  // counted: 이 표가 승인 정족수에 들어가는지. 반려 표는 정족수 계산 대상이 아니므로 false다.
  const approvals = raw.map((a) => ({ ...a, counted: a.decision === 'approved' && counted.has(a.userId) }));
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
    amount: formatUnits(r.amount_units, r.precision),
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
  };
}

function getRow(db: DB, orgId: string, id: string): any {
  const r = db.prepare(`${SELECT} WHERE r.id = ? AND r.org_id = ?`).get(id, orgId);
  if (!r) throw Errors.notFound('요청');
  return r;
}

export function getRequest(db: DB, auth: AuthContext, id: string) {
  const r = getRow(db, auth.org.id, id);
  const dto = toRequestDto(db, r, auth);
  const timeline = db.prepare("SELECT action, actor_name actorName, summary, created_at createdAt FROM audit_log WHERE org_id = ? AND target_type = 'request' AND target_id = ? ORDER BY seq").all(auth.org.id, id);
  const balance = balanceFor(db, r.wallet_id, r.asset_code);
  return { ...dto, timeline, available: formatUnits(balance.total - balance.reserved, r.precision) };
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

/** 입력값 검증: 자산·네트워크·주소·수량. 저장 계층에 넣기 전 서버 기준으로 다시 확인한다. */
function validateDraft(db: DB, auth: AuthContext, input: { assetCode: string; networkCode: string; addressId: string; amount: string }) {
  const asset = getAsset(db, input.assetCode);
  getNetworkRule(db, input.networkCode);
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
  if (addr.status !== 'ACTIVE') {
    throw new AppError(422, 'ADDRESS_NOT_ACTIVE', `'${addr.label}' 주소는 아직 사용할 수 없습니다(현재: ${addr.status === 'PENDING_REVIEW' ? '확인 대기' : '사용 불가'}).`, '두 번째 담당자의 주소 확인이 끝난 뒤 요청하세요.', [{ field: 'addressId', message: '사용 가능한 주소가 아닙니다.' }]);
  }
  const wallet = db.prepare('SELECT id FROM wallets WHERE org_id = ? AND network_code = ?').get(auth.org.id, input.networkCode) as { id: string } | undefined;
  if (!wallet) throw new AppError(422, 'WALLET_NOT_FOUND', '이 네트워크의 조직 지갑이 없습니다.', '지갑 관리에서 지원 네트워크를 확인하세요.', [{ field: 'networkCode', message: '조직 지갑이 없는 네트워크입니다.' }]);
  return { asset, units: units!, addr, walletId: wallet.id };
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

function requireCreator(r: any, auth: AuthContext) {
  if (!auth.perms.has('request.create')) throw Errors.forbidden('요청 작성·수정');
  if (r.created_by !== auth.user.id) throw new AppError(403, 'NOT_REQUEST_OWNER', '요청을 작성한 사람만 이 작업을 할 수 있습니다.', '작성자에게 요청하세요.');
}

function bump(db: DB, id: string, version: number, sets: Record<string, unknown>) {
  const keys = Object.keys(sets);
  const sql = `UPDATE withdrawal_requests SET ${keys.map((k) => `${k} = ?, `).join('')}updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`;
  const res = db.prepare(sql).run(...(Object.values(sets) as any[]), now(), id, version);
  if (res.changes !== 1) throw new AppError(409, 'VERSION_CONFLICT', '다른 사용자가 먼저 이 요청을 변경했습니다.', '최신 내용을 다시 확인한 뒤 진행하세요.');
}

function audit(db: DB, auth: AuthContext, r: any, action: string, summary: string, detail: Record<string, unknown> = {}) {
  writeAudit(db, { orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action, targetType: 'request', targetId: r.id, summary: `${r.ref_no} ${summary}`, detail });
}

export function createDraft(db: DB, auth: AuthContext, input: { assetCode: string; networkCode: string; addressId: string; amount: string; purpose: string }, idemKey: string | null) {
  if (!auth.perms.has('request.create')) throw Errors.forbidden('출금 요청 작성');
  const v = validateDraft(db, auth, input);
  const id = randomUUID();
  const seq = (db.prepare('SELECT COUNT(*) c FROM withdrawal_requests').get() as { c: number }).c + 1;
  const refNo = `WR-${String(seq).padStart(6, '0')}`;
  const t = now();
  db.prepare(
    `INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, created_by, created_at, updated_at, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
  ).run(id, auth.org.id, refNo, v.walletId, input.assetCode, input.networkCode, v.units.toString(), input.addressId, input.purpose.trim(), auth.user.id, t, t, idemKey);
  writeAudit(db, { orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'request.created', targetType: 'request', targetId: id, summary: `${refNo} 출금 요청 작성: ${formatUnits(v.units, v.asset.precision)} ${input.assetCode} → ${v.addr.label}` });
  return getRequest(db, auth, id);
}

export function updateDraft(db: DB, auth: AuthContext, id: string, input: { assetCode: string; networkCode: string; addressId: string; amount: string; purpose: string; version: number }) {
  return tx(db, () => {
    const r = lockRow(db, auth, id, 'edit', input.version);
    requireCreator(r, auth);
    const v = validateDraft(db, auth, input);
    bump(db, id, input.version, { wallet_id: v.walletId, asset_code: input.assetCode, network_code: input.networkCode, amount_units: v.units.toString(), address_id: input.addressId, purpose: input.purpose.trim() });
    // 해시 체인에 무엇이 무엇으로 바뀌었는지 남긴다. 주소는 끝자리만 남긴다.
    const before = { assetCode: r.asset_code, networkCode: r.network_code, amount: formatUnits(r.amount_units, r.precision), addressId: r.address_id, addressLabel: r.address_label, addressTail: tailOf(r.address_value) };
    const after = { assetCode: input.assetCode, networkCode: input.networkCode, amount: formatUnits(v.units, v.asset.precision), addressId: input.addressId, addressLabel: v.addr.label, addressTail: tailOf(v.addr.address) };
    audit(db, auth, r, 'request.updated', '작성 내용 수정', { before, after });
    return getRequest(db, auth, id);
  });
}

export function moveToReview(db: DB, auth: AuthContext, id: string, version: number) {
  return tx(db, () => {
    const r = lockRow(db, auth, id, 'review', version);
    requireCreator(r, auth);
    validateDraft(db, auth, { assetCode: r.asset_code, networkCode: r.network_code, addressId: r.address_id, amount: formatUnits(r.amount_units, r.precision) });
    assertAvailable(db, r.wallet_id, r.asset_code, BigInt(r.amount_units), r.precision);
    bump(db, id, version, { status: 'REVIEW' });
    audit(db, auth, r, 'request.reviewing', '검토 단계로 이동');
    return getRequest(db, auth, id);
  });
}

export function backToDraft(db: DB, auth: AuthContext, id: string, version: number) {
  return tx(db, () => {
    const r = lockRow(db, auth, id, 'back_to_draft', version);
    requireCreator(r, auth);
    bump(db, id, version, { status: 'DRAFT' });
    audit(db, auth, r, 'request.back_to_draft', '수정을 위해 작성 단계로 되돌림');
    return getRequest(db, auth, id);
  });
}

export function submitForApproval(db: DB, cfg: AppConfig, auth: AuthContext, id: string, input: { version: number; confirmTail: string }) {
  return tx(db, () => {
    const r = lockRow(db, auth, id, 'submit', input.version);
    requireCreator(r, auth);
    validateDraft(db, auth, { assetCode: r.asset_code, networkCode: r.network_code, addressId: r.address_id, amount: formatUnits(r.amount_units, r.precision) });
    const n = cfg.policy.addressBook.confirmTailLength;
    if (input.confirmTail.trim().toUpperCase() !== String(r.address_value).slice(-n).toUpperCase()) {
      throw new AppError(422, 'CONFIRM_TAIL_MISMATCH', `입력한 끝 ${n}자리가 받는 주소와 다릅니다.`, '화면의 받는 주소를 받는 곳이 알려 준 원본과 대조한 뒤 다시 입력하세요.', [{ field: 'confirmTail', message: '주소 끝자리와 일치하지 않습니다.' }]);
    }
    const units = BigInt(r.amount_units);
    assertAvailable(db, r.wallet_id, r.asset_code, units, r.precision);
    const quorum = decideRequiredApprovals(db, cfg, r.asset_code, units, r.precision);
    const eligible = eligibleApprovers(db, auth.org.id, r.created_by);
    if (eligible < quorum.required) {
      const message = eligible === 0
        ? `승인할 수 있는 사람이 없어 필요한 ${quorum.required}명을 채울 수 없습니다.`
        : `승인 가능한 사람이 ${eligible}명뿐이라 필요한 ${quorum.required}명을 채울 수 없습니다.`;
      throw new AppError(422, 'APPROVERS_INSUFFICIENT', message, '조직 관리자에게 승인자 추가를 요청하세요.', undefined, { eligibleApprovers: eligible, requiredApprovals: quorum.required, approvalBasis: quorum.basis });
    }
    adjustReserved(db, r.wallet_id, r.asset_code, units);
    bump(db, id, input.version, { status: 'PENDING_APPROVAL', submitted_at: now(), required_approvals: quorum.required, krw_value_at_submit: quorum.krw?.toString() ?? null, approval_basis: quorum.basis, price_as_of_at_submit: quorum.priceAsOf });
    const note = quorum.basis === 'price_missing' ? ' · 시세를 확인할 수 없어 고액 기준 적용' : quorum.basis === 'price_stale' ? ' · 시세가 지연되어 고액 기준 적용' : '';
    audit(db, auth, r, 'request.submitted', `승인 요청 (필요 승인 ${quorum.required}명${note})`, {
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
    });
    return getRequest(db, auth, id);
  });
}

/**
 * 필요 승인 수 결정 (설계 가정, A-03). 시세가 없거나 기준 시각이 priceStaleAfterMinutes보다 오래되었거나
 * 기준 시각을 믿을 수 없으면 평가액을 근거로 쓸 수 없으므로 고액 기준을 적용한다(fail closed).
 * 어떤 경우에도 기본 승인 수보다 적어지지 않는다.
 */
export function decideRequiredApprovals(db: DB, cfg: AppConfig, assetCode: string, units: bigint, precision: number): { required: number; basis: ApprovalBasis; krw: bigint | null; priceAsOf: string | null } {
  const p = cfg.policy.approval;
  const high = Math.max(p.highValueRequiredApprovals, p.defaultRequiredApprovals);
  const price = db.prepare('SELECT krw_price, as_of FROM prices WHERE asset_code = ?').get(assetCode) as { krw_price: string; as_of: string } | undefined;
  if (!price) return { required: high, basis: 'price_missing', krw: null, priceAsOf: null };
  const krw = krwValue(units, precision, price.krw_price);
  const age = Date.now() - Date.parse(price.as_of);
  const stale = !Number.isFinite(age) || age > cfg.policy.priceStaleAfterMinutes * 60_000 || age < -PRICE_FUTURE_SKEW_MS;
  if (stale) return { required: high, basis: 'price_stale', krw, priceAsOf: price.as_of };
  if (krw >= BigInt(p.highValueThresholdKrw)) return { required: high, basis: 'value_at_or_above_threshold', krw, priceAsOf: price.as_of };
  return { required: p.defaultRequiredApprovals, basis: 'value_below_threshold', krw, priceAsOf: price.as_of };
}

export function approveRequest(db: DB, auth: AuthContext, custody: CustodyAdapter, id: string, version: number) {
  return tx(db, () => {
    if (!auth.perms.has('request.approve')) throw Errors.forbidden('요청 승인');
    const r = getRow(db, auth.org.id, id);
    if (r.created_by === auth.user.id) {
      throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', '본인이 작성한 요청은 승인할 수 없습니다.', '다른 승인자에게 승인을 요청하세요.');
    }
    if (approvalsOf(db, id).some((a) => a.userId === auth.user.id)) {
      throw new AppError(409, 'ALREADY_DECIDED', '이미 이 요청에 결정을 남겼습니다.', '다른 승인자의 결정을 기다리세요.');
    }
    lockRow(db, auth, id, 'approve', version);
    if (r.address_status !== 'ACTIVE') {
      throw new AppError(422, 'ADDRESS_NOT_ACTIVE', '받는 주소가 더 이상 사용 가능 상태가 아닙니다.', '요청을 반려하고 주소 상태를 확인하세요.');
    }
    db.prepare("INSERT INTO approvals (request_id, user_id, decision, created_at) VALUES (?, ?, 'approved', ?)").run(id, auth.user.id, now());
    // 정족수는 지금 유효한 표만 센다. 승인 뒤 역할을 잃었거나 비활성화된 사람의 표는 빠진다.
    const validIds = validApproverIds(db, id);
    const valid = validIds.length;
    const notCounted = approvalsOf(db, id).filter((a) => a.decision === 'approved' && !validIds.includes(a.userId)).map((a) => a.userId as string);
    audit(db, auth, r, 'request.approved', `승인 (유효 ${valid}/${r.required_approvals})`, { validApprovals: valid, required: r.required_approvals, notCountedApproverIds: notCounted });
    const snapshot = JSON.stringify(validIds);
    if (valid >= r.required_approvals) {
      // 커스터디 호출은 승인 트랜잭션 안, 상태 변경 바로 앞에 둔다. 뒤에서 실패해 되돌려지고 다시 시도되어도
      // 같은 멱등 키(요청 id)를 쓰므로 어댑터는 같은 접수 참조를 돌려준다.
      const idempotencyKey = id;
      const { ref } = custody.submitWithdrawal({ requestId: id, idempotencyKey, assetCode: r.asset_code, networkCode: r.network_code, amountUnits: r.amount_units, address: r.address_value, memo: r.address_memo });
      bump(db, id, version, { status: 'PROCESSING', processing_started_at: now(), custody_ref: ref, counted_approver_ids: snapshot });
      writeAudit(db, {
        orgId: auth.org.id, actorId: null, actorName: custody.name, action: 'request.processing', targetType: 'request', targetId: id,
        summary: `${r.ref_no} 커스터디 처리 시작 (${ref})`,
        detail: {
          idempotencyKey, custodyRef: ref, assetCode: r.asset_code, networkCode: r.network_code, amount: formatUnits(r.amount_units, r.precision),
          addressId: r.address_id, addressLabel: r.address_label, addressTail: tailOf(r.address_value), memoSet: String(r.address_memo ?? '') !== '',
          approverIds: validIds,
        },
      });
    } else {
      bump(db, id, version, { counted_approver_ids: snapshot });
    }
    return getRequest(db, auth, id);
  });
}

export function rejectRequest(db: DB, auth: AuthContext, id: string, input: { version: number; reason: string }) {
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
    db.prepare("INSERT INTO approvals (request_id, user_id, decision, reason, created_at) VALUES (?, ?, 'rejected', ?, ?)").run(id, auth.user.id, input.reason.trim(), now());
    adjustReserved(db, r.wallet_id, r.asset_code, -BigInt(r.amount_units));
    bump(db, id, input.version, { status: 'REJECTED', reject_reason: input.reason.trim(), completed_at: now(), counted_approver_ids: JSON.stringify(validApproverIds(db, id)) });
    audit(db, auth, r, 'request.rejected', '반려', { reason: input.reason.trim() });
    return getRequest(db, auth, id);
  });
}

export function cancelRequest(db: DB, auth: AuthContext, id: string, version: number) {
  return tx(db, () => {
    const r = lockRow(db, auth, id, 'cancel', version);
    requireCreator(r, auth);
    const wasPending = r.status === 'PENDING_APPROVAL';
    if (wasPending) adjustReserved(db, r.wallet_id, r.asset_code, -BigInt(r.amount_units));
    bump(db, id, version, { status: 'CANCELLED', completed_at: now(), ...(wasPending ? { counted_approver_ids: JSON.stringify(validApproverIds(db, id)) } : {}) });
    audit(db, auth, r, 'request.cancelled', '요청자 취소');
    return getRequest(db, auth, id);
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
      const units = BigInt(r.amount_units);
      const b = balanceFor(db, r.wallet_id, r.asset_code);
      adjustReserved(db, r.wallet_id, r.asset_code, -units);
      if (st === 'completed' && b.total >= units) {
        db.prepare('UPDATE balances SET total_units = ?, updated_at = ? WHERE wallet_id = ? AND asset_code = ?').run((b.total - units).toString(), now(), r.wallet_id, r.asset_code);
        db.prepare("UPDATE withdrawal_requests SET status = 'COMPLETED', completed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(now(), now(), r.id);
        db.prepare("INSERT INTO transactions (id, org_id, wallet_id, type, asset_code, network_code, amount_units, counterparty, status, occurred_at, request_id, tx_ref) VALUES (?, ?, ?, 'withdrawal', ?, ?, ?, ?, 'completed', ?, ?, ?)")
          .run(randomUUID(), r.org_id, r.wallet_id, r.asset_code, r.network_code, r.amount_units, r.address_label, now(), r.id, r.custody_ref);
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