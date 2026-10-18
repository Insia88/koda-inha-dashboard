import { randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';
import { now, tx } from '../db.ts';
import { AppError, Errors } from '../errors.ts';
import { writeAudit } from '../audit.ts';
import type { AuthContext } from '../auth.ts';
import { checkAddressFormat, isLookalike, normalizeAddress, type Finding } from '../../shared/address-rules.ts';
import { assertAssetOnNetwork, getAsset, getNetworkRule, getNetworkRules } from './catalog.ts';
import type { Policy } from '../config.ts';
import { ADDRESS_STATUS, type AddressStatus } from '../../shared/terms.ts';

export function toAddressDto(r: any, auth?: AuthContext) {
  const dto = {
    id: r.id as string,
    label: r.label as string,
    counterparty: r.counterparty as string,
    assetCode: r.asset_code as string,
    networkCode: r.network_code as string,
    networkName: r.network_name as string,
    address: r.address as string,
    memo: r.memo as string,
    status: r.status as AddressStatus,
    statusLabel: ADDRESS_STATUS[r.status as AddressStatus].label,
    createdBy: { id: r.created_by as string, name: r.creator_name as string },
    createdAt: r.created_at as string,
    reviewedBy: r.reviewed_by ? { id: r.reviewed_by as string, name: r.reviewer_name as string } : null,
    reviewedAt: r.reviewed_at as string | null,
    reviewNote: r.review_note as string | null,
    version: r.version as number,
    allowedActions: [] as string[],
  };
  if (auth) {
    if (r.status === 'PENDING_REVIEW' && auth.perms.has('address.review') && r.created_by !== auth.user.id) dto.allowedActions.push('review');
    if ((r.status === 'ACTIVE' || r.status === 'PENDING_REVIEW') && auth.perms.has('address.disable')) dto.allowedActions.push('disable');
  }
  return dto;
}

const SELECT = `SELECT a.*, n.name network_name, cu.name creator_name, ru.name reviewer_name
  FROM address_book a JOIN networks n ON n.code = a.network_code
  JOIN users cu ON cu.id = a.created_by LEFT JOIN users ru ON ru.id = a.reviewed_by`;

export function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
}

export function listAddresses(db: DB, auth: AuthContext, q: { status?: string; assetCode?: string; networkCode?: string; q?: string; sort?: string }) {
  const where = ['a.org_id = ?'];
  const args: any[] = [auth.org.id];
  if (q.status) { where.push('a.status = ?'); args.push(q.status); }
  if (q.assetCode) { where.push('a.asset_code = ?'); args.push(q.assetCode); }
  if (q.networkCode) { where.push('a.network_code = ?'); args.push(q.networkCode); }
  if (q.q) {
    where.push("(a.label LIKE ? ESCAPE '\\' OR a.counterparty LIKE ? ESCAPE '\\' OR a.address LIKE ? ESCAPE '\\')");
    const like = likePattern(q.q);
    args.push(like, like, like);
  }
  const order = q.sort === 'label' ? 'a.label COLLATE NOCASE ASC'
    : q.sort === 'status' ? "CASE a.status WHEN 'PENDING_REVIEW' THEN 0 WHEN 'ACTIVE' THEN 1 WHEN 'REJECTED' THEN 2 ELSE 3 END, a.created_at DESC"
    : 'a.created_at DESC';
  const rows = db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`).all(...args);
  const total = (db.prepare('SELECT COUNT(*) c FROM address_book WHERE org_id = ?').get(auth.org.id) as { c: number }).c;
  return { items: rows.map((r) => toAddressDto(r, auth)), totalInOrg: total };
}

export function getAddressRow(db: DB, orgId: string, id: string): any {
  const r = db.prepare(`${SELECT} WHERE a.id = ? AND a.org_id = ?`).get(id, orgId);
  if (!r) throw Errors.notFound('주소');
  return r;
}

/** 서버 기준 형식 점검 + 같은 조직 주소록의 중복·유사 주소 점검 */
export function checkAddress(db: DB, orgId: string, input: { assetCode: string; networkCode: string; address: string; memo?: string }): { findings: Finding[]; normalized: string } {
  getAsset(db, input.assetCode);
  const network = getNetworkRule(db, input.networkCode);
  assertAssetOnNetwork(db, input.assetCode, input.networkCode);
  const findings = checkAddressFormat(input, network, getNetworkRules(db));
  const normalized = normalizeAddress(input.address, network.family);
  if (!findings.some((f) => f.level === 'error')) {
    const live = db.prepare("SELECT label, address, memo, asset_code, network_code FROM address_book WHERE org_id = ? AND status IN ('PENDING_REVIEW','ACTIVE')").all(orgId) as any[];
    const memo = (input.memo ?? '').trim();
    const dup = live.find((r) => r.address === normalized && r.network_code === input.networkCode && r.asset_code === input.assetCode && r.memo === memo);
    if (dup) {
      findings.unshift({ code: 'ADDRESS_DUPLICATE', level: 'error', message: `이미 '${dup.label}'(으)로 등록된 주소입니다.`, action: '기존 주소를 사용하거나, 사용 중지 후 다시 등록하세요.' });
    }
    const look = live.find((r) => isLookalike(r.address, normalized));
    if (look) {
      findings.unshift({ code: 'ADDRESS_LOOKALIKE', level: 'warning', message: `기존 주소 '${look.label}'과(와) 앞·뒤 글자가 같지만 다른 주소입니다.`, action: '앞·뒤만 같은 가짜 주소를 이용한 사기일 수 있습니다. 전체 글자를 받는 곳과 다시 대조하세요.' });
    }
  }
  return { findings, normalized };
}

function tailMismatch(n: number, action: string) {
  return new AppError(422, 'CONFIRM_TAIL_MISMATCH', `다시 입력한 끝 ${n}자리가 주소와 다릅니다.`, action, [{ field: 'confirmTail', message: '주소 끝자리와 일치하지 않습니다.' }]);
}

export function createAddress(db: DB, auth: AuthContext, policy: Policy, input: { label: string; counterparty: string; assetCode: string; networkCode: string; address: string; memo: string; confirmTail: string }) {
  return tx(db, () => {
    const { findings, normalized } = checkAddress(db, auth.org.id, input);
    const errors = findings.filter((f) => f.level === 'error');
    if (errors.length) {
      const e = errors[0]!;
      throw new AppError(422, e.code, e.message, e.action, [{ field: e.code.startsWith('MEMO') ? 'memo' : 'address', message: e.message }], { findings });
    }
    const n = policy.addressBook.confirmTailLength;
    if (input.confirmTail.trim().toUpperCase() !== normalized.slice(-n).toUpperCase()) {
      throw tailMismatch(n, '받는 곳이 알려 준 주소의 마지막 글자를 직접 보고 다시 입력하세요.');
    }
    const id = randomUUID();
    const status: AddressStatus = policy.addressBook.requireSecondPersonReview ? 'PENDING_REVIEW' : 'ACTIVE';
    db.prepare(
      `INSERT INTO address_book (id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, auth.org.id, input.label.trim(), input.counterparty.trim(), input.assetCode, input.networkCode, normalized, (input.memo ?? '').trim(), status, auth.user.id, now());
    writeAudit(db, {
      orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'address.created', targetType: 'address', targetId: id,
      summary: `주소 등록 요청: ${input.label.trim()} (${input.assetCode}/${input.networkCode})`,
      detail: { assetCode: input.assetCode, networkCode: input.networkCode, addressTail: normalized.slice(-6), memoSet: !!(input.memo ?? '').trim(), warnings: findings.filter((f) => f.level === 'warning').map((f) => f.code) },
    });
    return { address: toAddressDto(getAddressRow(db, auth.org.id, id), auth), findings };
  });
}

export function reviewAddress(db: DB, auth: AuthContext, policy: Policy, id: string, input: { decision: 'approve' | 'reject'; note: string; version: number; confirmTail: string }) {
  return tx(db, () => {
    const r = getAddressRow(db, auth.org.id, id);
    if (r.created_by === auth.user.id) {
      throw new AppError(403, 'SELF_REVIEW_FORBIDDEN', '본인이 등록한 주소는 직접 확인할 수 없습니다.', '다른 승인자에게 확인을 요청하세요.');
    }
    if (r.status !== 'PENDING_REVIEW') throw Errors.conflict(`이미 '${ADDRESS_STATUS[r.status as AddressStatus].label}' 상태인 주소입니다.`);
    if (r.version !== input.version) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
    if (input.decision === 'reject' && input.note.trim().length < 5) {
      throw new AppError(422, 'VALIDATION', '거절 사유를 5자 이상 입력하세요.', '등록자가 무엇을 고쳐야 하는지 알 수 있게 적어 주세요.', [{ field: 'note', message: '거절 사유를 5자 이상 입력하세요.' }]);
    }
    if (input.decision === 'approve') {
      const n = policy.addressBook.confirmTailLength;
      if (input.confirmTail.trim().toUpperCase() !== String(r.address).slice(-n).toUpperCase()) {
        throw tailMismatch(n, '받는 곳에서 받은 원본 주소와 직접 대조한 뒤 입력하세요.');
      }
    }
    const status: AddressStatus = input.decision === 'approve' ? 'ACTIVE' : 'REJECTED';
    const res = db.prepare('UPDATE address_book SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, version = version + 1 WHERE id = ? AND org_id = ? AND version = ?')
      .run(status, auth.user.id, now(), input.note.trim() || null, id, auth.org.id, input.version);
    if (res.changes !== 1) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
    writeAudit(db, {
      orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name,
      action: input.decision === 'approve' ? 'address.approved' : 'address.rejected', targetType: 'address', targetId: id,
      summary: `${input.decision === 'approve' ? '주소 확인 완료' : '주소 등록 거절'}: ${r.label}`,
      detail: input.decision === 'reject' ? { reason: input.note.trim() } : {},
    });
    return toAddressDto(getAddressRow(db, auth.org.id, id), auth);
  });
}

export function disableAddress(db: DB, auth: AuthContext, id: string, version: number) {
  return tx(db, () => {
    const r = getAddressRow(db, auth.org.id, id);
    if (!['ACTIVE', 'PENDING_REVIEW'].includes(r.status)) throw Errors.conflict('이미 사용할 수 없는 주소입니다.');
    const res = db.prepare("UPDATE address_book SET status = 'DISABLED', version = version + 1 WHERE id = ? AND org_id = ? AND version = ?").run(id, auth.org.id, version);
    if (res.changes !== 1) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
    writeAudit(db, { orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'address.disabled', targetType: 'address', targetId: id, summary: `주소 사용 중지: ${r.label}` });
    return toAddressDto(getAddressRow(db, auth.org.id, id), auth);
  });
}