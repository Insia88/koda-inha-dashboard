import type { DB } from '../db.ts';
import { now, tx } from '../db.ts';
import { AppError, Errors } from '../errors.ts';
import { writeAudit } from '../audit.ts';
import type { AuthContext } from '../auth.ts';
import type { AppConfig } from '../config.ts';
import { formatUnits, krwValue } from '../../shared/decimal.ts';
import { actionLabel, AUDIT_EXPORT_TEXT, AUDIT_INTEGRITY_TEXT, decisionEvidenceText, ROLE_LABEL, type DecisionEvidence, type Role } from '../../shared/terms.ts';
import { FORMULA_START, kstDateTime } from '../csv.ts';
import { activateDueAddresses, canStopCooling, likePattern, poisonFlags } from './addresses.ts';
import { DECISION_ACTIONS, decisionEvidence, displayAmount, validApprovals, waitingForMap } from './requests.ts';

export function priceState(db: DB, cfg: AppConfig) {
  const rows = db.prepare('SELECT asset_code, krw_price, as_of, source FROM prices').all() as any[];
  const oldest = rows.reduce<string | null>((m, r) => (m === null || r.as_of < m ? r.as_of : m), null);
  const stale = oldest ? Date.now() - Date.parse(oldest) > cfg.policy.priceStaleAfterMinutes * 60_000 : true;
  return {
    prices: Object.fromEntries(rows.map((r) => [r.asset_code, r])) as Record<string, any>,
    asOf: oldest,
    source: rows[0]?.source ?? null,
    state: rows.length === 0 ? 'unavailable' : stale ? 'stale' : 'mock',
    staleAfterMinutes: cfg.policy.priceStaleAfterMinutes,
  };
}

export function holdings(db: DB, cfg: AppConfig, orgId: string) {
  const ps = priceState(db, cfg);
  const rows = db.prepare(
    `SELECT b.asset_code, a.name, a.precision, b.total_units, b.reserved_units, w.id wallet_id, w.name wallet_name, w.network_code, n.name network_name, b.updated_at
       FROM balances b JOIN wallets w ON w.id = b.wallet_id JOIN assets a ON a.code = b.asset_code JOIN networks n ON n.code = w.network_code
      WHERE w.org_id = ? ORDER BY b.asset_code, w.network_code`,
  ).all(orgId) as any[];
  const byAsset = new Map<string, { assetCode: string; name: string; precision: number; total: bigint; reserved: bigint; rows: any[] }>();
  let lastUpdated: string | null = null;
  for (const r of rows) {
    const e = byAsset.get(r.asset_code) ?? { assetCode: r.asset_code, name: r.name, precision: r.precision, total: 0n, reserved: 0n, rows: [] as any[] };
    e.total += BigInt(r.total_units);
    e.reserved += BigInt(r.reserved_units);
    e.rows.push({ walletId: r.wallet_id, walletName: r.wallet_name, networkCode: r.network_code, networkName: r.network_name, total: formatUnits(r.total_units, r.precision), reserved: formatUnits(r.reserved_units, r.precision), available: formatUnits(BigInt(r.total_units) - BigInt(r.reserved_units), r.precision) });
    byAsset.set(r.asset_code, e);
    if (!lastUpdated || r.updated_at > lastUpdated) lastUpdated = r.updated_at;
  }
  let totalKrw = 0n;
  const assets = [...byAsset.values()].map((e) => {
    const p = ps.prices[e.assetCode];
    const value = p ? krwValue(e.total, e.precision, p.krw_price) : null;
    if (value !== null) totalKrw += value;
    return {
      assetCode: e.assetCode, name: e.name, precision: e.precision,
      total: formatUnits(e.total, e.precision), reserved: formatUnits(e.reserved, e.precision), available: formatUnits(e.total - e.reserved, e.precision),
      krwPrice: p?.krw_price ?? null, krwValue: value?.toString() ?? null, byWallet: e.rows,
    };
  });
  assets.sort((a, b) => (BigInt(b.krwValue ?? '0') > BigInt(a.krwValue ?? '0') ? 1 : -1));
  return { assets, totalKrw: totalKrw.toString(), balanceAsOf: lastUpdated, price: { asOf: ps.asOf, source: ps.source, state: ps.state, staleAfterMinutes: ps.staleAfterMinutes } };
}

export function dashboard(db: DB, cfg: AppConfig, auth: AuthContext) {
  const org = auth.org.id;
  const me = auth.user.id;
  const tasks: { kind: string; count: number; title: string; description: string; href: string; tone: string }[] = [];
  const count = (sql: string, ...args: any[]) => (db.prepare(sql).get(...args) as { c: number }).c;
  // 대기 시간이 끝난 주소가 '사용 대기'로 세어지지 않도록 먼저 상태를 맞춘다.
  activateDueAddresses(db);
  if (auth.perms.has('request.approve')) {
    // 받는 주소가 사용 가능 상태인 요청만 '승인할 요청'으로 센다. 나머지는 아래 '승인할 수 없는 요청'으로 따로 보인다.
    const undecided = "r.org_id = ? AND r.status = 'PENDING_APPROVAL' AND r.created_by <> ? AND NOT EXISTS (SELECT 1 FROM approvals x WHERE x.request_id = r.id AND x.user_id = ?)";
    const c = count(`SELECT COUNT(*) c FROM withdrawal_requests r JOIN address_book ab ON ab.id = r.address_id WHERE ${undecided} AND ab.status = 'ACTIVE'`, org, me, me);
    tasks.push({ kind: 'approve_requests', count: c, title: '승인할 출금 요청', description: '다른 담당자가 보낸 요청입니다. 받는 주소와 수량을 대조한 뒤 승인하거나 반려하세요.', href: '/requests?view=to_approve', tone: 'warning' });
    const blocked = count(`SELECT COUNT(*) c FROM withdrawal_requests r JOIN address_book ab ON ab.id = r.address_id WHERE ${undecided} AND ab.status <> 'ACTIVE'`, org, me, me);
    tasks.push({ kind: 'blocked_requests', count: blocked, title: '받는 주소가 사용 중지되어 승인할 수 없는 요청', description: '승인할 수 없는 상태입니다. 내용을 확인하고 사유와 함께 반려하세요. 반려하면 예약 수량이 풀립니다.', href: '/requests?view=blocked', tone: 'danger' });
  }
  if (auth.perms.has('address.review')) {
    const c = count("SELECT COUNT(*) c FROM address_book WHERE org_id = ? AND status = 'PENDING_REVIEW' AND created_by <> ?", org, me);
    tasks.push({ kind: 'review_addresses', count: c, title: '확인할 새 주소', description: '확인 전에는 출금에 쓸 수 없습니다. 받는 곳에 별도로 연락해 주소를 대조하세요.', href: '/addresses?status=PENDING_REVIEW', tone: 'warning' });
  }
  if (canStopCooling(auth)) {
    // 주소 등록·확인·사용 중지 권한이 있는 사람 모두에게 보인다. 요청하지 않은 등록이면 대기 중에 정지할 수 있다.
    const cooling = count("SELECT COUNT(*) c FROM address_book WHERE org_id = ? AND status = 'COOLING_DOWN'", org);
    tasks.push({
      kind: 'cooling_addresses', count: cooling,
      title: `새 받는 주소 ${cooling}건이 사용 대기 중입니다 — 요청하지 않은 등록이면 정지하세요`,
      description: '두 사람이 확인한 주소도 대기 시간이 지나야 출금에 쓸 수 있습니다. 등록을 요청한 적이 없거나 받는 곳에서 확인되지 않았다면 대기 중에 바로 정지하세요.',
      href: '/addresses?status=COOLING_DOWN', tone: 'warning',
    });
  }
  if (auth.perms.has('request.create')) {
    const drafts = count("SELECT COUNT(*) c FROM withdrawal_requests WHERE org_id = ? AND created_by = ? AND status IN ('DRAFT','REVIEW')", org, me);
    tasks.push({ kind: 'my_drafts', count: drafts, title: '제출 전 내 요청', description: '작성 중이거나 검토 중인 요청입니다. 승인 요청을 보내야 승인자에게 전달됩니다.', href: '/requests?view=mine&status=DRAFT,REVIEW', tone: 'info' });
    const since = new Date(Date.now() - 14 * 86400_000).toISOString();
    const rejected = count("SELECT COUNT(*) c FROM withdrawal_requests WHERE org_id = ? AND created_by = ? AND status IN ('REJECTED','FAILED') AND completed_at >= ?", org, me, since);
    tasks.push({ kind: 'my_rejected', count: rejected, title: '반려·실패한 내 요청 (14일)', description: '사유를 확인하고 필요하면 새 요청을 작성하세요.', href: '/requests?view=mine&status=REJECTED,FAILED', tone: 'danger' });
    const myBlocked = count("SELECT COUNT(*) c FROM withdrawal_requests r JOIN address_book ab ON ab.id = r.address_id WHERE r.org_id = ? AND r.created_by = ? AND r.status = 'PENDING_APPROVAL' AND ab.status <> 'ACTIVE'", org, me);
    tasks.push({ kind: 'my_blocked_requests', count: myBlocked, title: '받는 주소가 사용 중지된 내 요청', description: '승인할 수 없는 상태입니다. 요청을 취소하면 예약 수량이 풀립니다.', href: '/requests?view=blocked', tone: 'danger' });
    const pendingAddr = count("SELECT COUNT(*) c FROM address_book WHERE org_id = ? AND created_by = ? AND status = 'PENDING_REVIEW'", org, me);
    tasks.push({ kind: 'my_pending_addresses', count: pendingAddr, title: '확인을 기다리는 내 주소', description: '다른 담당자가 확인하면 출금 요청에 쓸 수 있습니다.', href: '/addresses?status=PENDING_REVIEW', tone: 'neutral' });
  }
  if (auth.perms.has('audit.read') && !auth.perms.has('request.create') && !auth.perms.has('request.approve')) {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const c = count("SELECT COUNT(*) c FROM audit_log WHERE org_id = ? AND created_at >= ? AND action NOT IN ('auth.login','auth.logout')", org, since);
    tasks.push({ kind: 'audit_recent', count: c, title: '최근 24시간 업무 기록', description: '요청·승인·주소·역할 변경 기록입니다. 감사 기록에서 내용과 무결성을 확인하세요.', href: '/audit', tone: 'neutral' });
  }
  const inProgress = db.prepare(
    `SELECT r.id, r.ref_no, r.status, r.asset_code, r.amount_units, a.precision, r.required_approvals, u.name creator_name, ab.label address_label, r.updated_at, r.submitted_at,
            (SELECT COUNT(*) FROM approvals x WHERE x.request_id = r.id AND x.decision = 'approved') approved
       FROM withdrawal_requests r JOIN assets a ON a.code = r.asset_code JOIN users u ON u.id = r.created_by JOIN address_book ab ON ab.id = r.address_id
      WHERE r.org_id = ? AND r.status IN ('REVIEW','PENDING_APPROVAL','PROCESSING') ORDER BY r.updated_at DESC LIMIT 6`,
  ).all(org) as any[];
  const inProgressCount = count("SELECT COUNT(*) c FROM withdrawal_requests WHERE org_id = ? AND status IN ('REVIEW','PENDING_APPROVAL','PROCESSING')", org);
  const recent = db.prepare(
    `SELECT t.id, t.type, t.asset_code, t.amount_units, a.precision, t.status, t.occurred_at, t.counterparty, t.counterparty_address, n.name network_name
       FROM transactions t JOIN assets a ON a.code = t.asset_code JOIN networks n ON n.code = t.network_code WHERE t.org_id = ? ORDER BY t.occurred_at DESC LIMIT 5`,
  ).all(org) as any[];
  const recentPoison = poisonFlags(db, org, recent);
  // 승인 대기 요청을 지금 누가 승인할 수 있는지(A2-1). 요청 조회 권한이 있을 때만 채운다(요청 상세의 approvalWait.candidates와 같은 판정).
  const waits = auth.perms.has('request.read')
    ? waitingForMap(db, org, inProgress.filter((r) => r.status === 'PENDING_APPROVAL').map((r) => r.id as string))
    : new Map<string, null>();
  return {
    holdings: holdings(db, cfg, org),
    tasks,
    // 승인 대기 중인 요청의 승인 수는 지금 유효한 표만 센다(요청 상세의 approvedCount와 같은 기준).
    // 수량은 저장 값을 정수로 읽을 수 없으면 null(화면은 '—')이다. 요청 한 건 때문에 홈 전체가 실패하지 않게 한다.
    // submittedAt: 승인 요청 시각(대기 시간의 시작). waitingFor: 승인 대기이고 승인할 수 있는 요청이면 지금 승인할 수 있는 사람
    // (이름순, 작성자·이미 결정한 사람 제외, 이름·id만), 그 밖에는 null.
    inProgress: inProgress.map((r) => ({
      id: r.id, refNo: r.ref_no, status: r.status, assetCode: r.asset_code, amount: displayAmount(r.amount_units, r.precision), creatorName: r.creator_name, addressLabel: r.address_label,
      approved: r.status === 'PENDING_APPROVAL' ? validApprovals(db, r.id) : r.approved, requiredApprovals: r.required_approvals, updatedAt: r.updated_at,
      submittedAt: (r.submitted_at ?? null) as string | null, waitingFor: waits.get(r.id) ?? null,
    })),
    inProgressCount,
    // 소액(0원 포함) 입금에는 주소 오염 의심 표시를 붙인다. 보낸 주소는 홈에 보이지 않는다(활동 내역에서 복사 버튼 없이 보여 준다).
    recentActivity: recent.map((t) => ({ id: t.id, type: t.type, assetCode: t.asset_code, amount: formatUnits(t.amount_units, t.precision), status: t.status, occurredAt: t.occurred_at, counterparty: t.counterparty, networkName: t.network_name, poison: recentPoison.get(t.id) ?? null })),
  };
}

export function activity(db: DB, auth: AuthContext, q: { type?: string; assetCode?: string; status?: string; q?: string; from?: string; to?: string; sort?: string; order?: string; page: number; pageSize: number }) {
  const where = ['t.org_id = ?'];
  const args: any[] = [auth.org.id];
  if (q.type && ['deposit', 'withdrawal', 'staking_reward'].includes(q.type)) { where.push('t.type = ?'); args.push(q.type); }
  if (q.status && ['completed', 'processing', 'failed'].includes(q.status)) { where.push('t.status = ?'); args.push(q.status); }
  if (q.assetCode) { where.push('t.asset_code = ?'); args.push(q.assetCode); }
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) { where.push('t.occurred_at >= ?'); args.push(new Date(`${q.from}T00:00:00+09:00`).toISOString()); }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) { where.push('t.occurred_at < ?'); args.push(new Date(new Date(`${q.to}T00:00:00+09:00`).getTime() + 86400_000).toISOString()); }
  if (q.q) { where.push("(t.counterparty LIKE ? ESCAPE '\\' OR t.tx_ref LIKE ? ESCAPE '\\')"); const l = likePattern(q.q); args.push(l, l); }
  const w = where.join(' AND ');
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const sort = q.sort === 'asset' ? `t.asset_code ${dir}, t.occurred_at DESC` : `t.occurred_at ${dir}`;
  const total = (db.prepare(`SELECT COUNT(*) c FROM transactions t WHERE ${w}`).get(...args) as { c: number }).c;
  const rows = db.prepare(
    `SELECT t.*, a.precision, n.name network_name, wl.name wallet_name, r.ref_no FROM transactions t JOIN assets a ON a.code = t.asset_code JOIN networks n ON n.code = t.network_code JOIN wallets wl ON wl.id = t.wallet_id LEFT JOIN withdrawal_requests r ON r.id = t.request_id
      WHERE ${w} ORDER BY ${sort}, t.id LIMIT ? OFFSET ?`,
  ).all(...args, q.pageSize, (q.page - 1) * q.pageSize) as any[];
  const poison = poisonFlags(db, auth.org.id, rows);
  return {
    total, page: q.page, pageSize: q.pageSize,
    items: rows.map((t) => ({
      id: t.id, type: t.type, assetCode: t.asset_code, networkName: t.network_name, walletName: t.wallet_name, amount: formatUnits(t.amount_units, t.precision), counterparty: t.counterparty, status: t.status, occurredAt: t.occurred_at, txRef: t.tx_ref, requestId: t.request_id, requestRef: t.ref_no,
      /** 입금을 보낸 주소(기록된 경우만). 화면은 복사 버튼 없이 보여 준다. */
      counterpartyAddress: (t.counterparty_address as string | null) ?? null,
      /** 소액(0원 포함) 입금이면 주소 오염 의심 표시 */
      poison: poison.get(t.id) ?? null,
    })),
  };
}

export function wallets(db: DB, cfg: AppConfig, auth: AuthContext) {
  const h = holdings(db, cfg, auth.org.id);
  const ws = db.prepare('SELECT w.*, n.name network_name, n.memo_required, n.memo_label FROM wallets w JOIN networks n ON n.code = w.network_code WHERE w.org_id = ? ORDER BY w.name').all(auth.org.id) as any[];
  const pairs = db.prepare('SELECT asset_code, network_code FROM asset_networks').all() as any[];
  return ws.map((w) => ({
    id: w.id, name: w.name, networkCode: w.network_code, networkName: w.network_name, depositAddress: w.deposit_address, depositMemo: w.deposit_memo, memoLabel: w.memo_label,
    acceptedAssets: pairs.filter((p) => p.network_code === w.network_code).map((p) => p.asset_code),
    balances: h.assets.flatMap((a) => a.byWallet.filter((b: any) => b.walletId === w.id).map((b: any) => ({ assetCode: a.assetCode, ...b }))),
  }));
}

export function staking(db: DB, auth: AuthContext) {
  const rows = db.prepare('SELECT s.*, a.precision, n.name network_name FROM staking_positions s JOIN assets a ON a.code = s.asset_code JOIN networks n ON n.code = s.network_code WHERE s.org_id = ? ORDER BY s.started_at DESC').all(auth.org.id) as any[];
  return rows.map((s) => ({ id: s.id, assetCode: s.asset_code, networkName: s.network_name, validatorLabel: s.validator_label, staked: formatUnits(s.staked_units, s.precision), reward30d: formatUnits(s.reward_units_30d, s.precision), status: s.status, startedAt: s.started_at }));
}

export function members(db: DB, auth: AuthContext) {
  const users = db.prepare('SELECT id, name, email, title, is_active, roles_version FROM users WHERE org_id = ? ORDER BY name').all(auth.org.id) as any[];
  return users.map((u) => ({
    id: u.id, name: u.name, email: u.email, title: u.title, isActive: !!u.is_active, rolesVersion: u.roles_version,
    roles: (db.prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role').all(u.id) as { role: Role }[]).map((r) => r.role),
  }));
}

export function updateRoles(db: DB, auth: AuthContext, userId: string, roles: Role[], rolesVersion: number) {
  return tx(db, () => {
    const u = db.prepare('SELECT id, name, roles_version FROM users WHERE id = ? AND org_id = ?').get(userId, auth.org.id) as any;
    if (!u) throw Errors.notFound('구성원');
    if (u.roles_version !== rolesVersion) throw Errors.conflict('다른 관리자가 먼저 이 구성원의 역할을 바꿨습니다.');
    const before = (db.prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role').all(userId) as { role: Role }[]).map((r) => r.role);
    const next = [...new Set(roles)].sort() as Role[];
    if (userId === auth.user.id && before.includes('admin') && !next.includes('admin')) {
      throw new AppError(422, 'SELF_ADMIN_REMOVAL', '본인의 조직 관리자 역할은 직접 해제할 수 없습니다.', '다른 조직 관리자에게 요청하세요.');
    }
    // 역할을 관리하는 사람이 스스로 출금 승인·작성 권한을 얻지 못하게 한다(직무 분리). 역할 해제는 위험을 줄이므로 막지 않는다.
    const TRANSACTIONAL: Role[] = ['approver', 'requester'];
    if (userId === auth.user.id && next.some((r) => TRANSACTIONAL.includes(r) && !before.includes(r))) {
      throw new AppError(422, 'SELF_ROLE_ESCALATION', '본인에게 승인자·자산 담당자 역할을 직접 부여할 수 없습니다.', '다른 조직 관리자에게 요청하세요.');
    }
    if (before.includes('admin') && !next.includes('admin')) {
      const admins = (db.prepare("SELECT COUNT(*) c FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE u.org_id = ? AND ur.role = 'admin'").get(auth.org.id) as { c: number }).c;
      if (admins <= 1) throw new AppError(422, 'LAST_ADMIN', '조직에 관리자가 한 명 이상 있어야 합니다.', '다른 구성원에게 관리자 역할을 먼저 부여하세요.');
    }
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
    for (const r of next) db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)').run(userId, r);
    db.prepare('UPDATE users SET roles_version = roles_version + 1 WHERE id = ?').run(userId);
    const label = (rs: Role[]) => (rs.length ? rs.map((r) => ROLE_LABEL[r].label).join(', ') : '없음');
    writeAudit(db, { orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'member.roles_changed', targetType: 'user', targetId: userId, summary: `${u.name} 역할 변경: ${label(before)} → ${label(next)}`, detail: { before, after: next } });
    return members(db, auth).find((m) => m.id === userId);
  });
}

export function auditList(db: DB, auth: AuthContext, q: { action?: string; actor?: string; q?: string; from?: string; to?: string; page: number; pageSize: number }) {
  const { w, args } = auditWhere(auth, q);
  const total = (db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE ${w}`).get(...args) as { c: number }).c;
  // seq는 DB 전체(모든 조직) 공용 순번이라 조직별로 보면 빈 번호가 생기고, 그 간격으로 다른 조직의 기록량을 짐작할 수 있다.
  // 그래서 응답에는 싣지 않고, 조직 안 순번(orgSeq, 필터를 걸기 전에 매김)만 준다. CSV 순번도 같은 번호다(auditOrgRows).
  const items = db.prepare(
    `SELECT org_seq orgSeq, id, actor_id actorId, actor_name actorName, action, target_type targetType, target_id targetId, summary, detail, created_at createdAt, hash
       FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY seq) org_seq FROM audit_log WHERE org_id = ?)
      WHERE ${w} ORDER BY seq DESC LIMIT ? OFFSET ?`,
  ).all(auth.org.id, ...args, q.pageSize, (q.page - 1) * q.pageSize) as any[];
  const actions = (db.prepare('SELECT DISTINCT action FROM audit_log WHERE org_id = ? ORDER BY action').all(auth.org.id) as any[]).map((r) => r.action);
  // 승인·반려 기록에는 결정 근거(A2-3)를 붙인다. 요청마다 한 번만 계산한다. 다른 행동 항목에는 evidence가 없다.
  const evidence = evidenceLookup(db, auth);
  return {
    total, page: q.page, pageSize: q.pageSize, actions,
    items: items.map((i) => {
      const item = { ...i, detail: JSON.parse(i.detail) };
      return DECISION_ACTIONS.has(i.action) ? { ...item, evidence: evidence(i.targetId, i.actorId) } : item;
    }),
  };
}

/**
 * 감사 기록 행(승인·반려)의 결정 근거를 찾는 함수. 요청마다 한 번만 계산해 둔다(감사 기록 목록·CSV).
 * 모든 조회는 조회자 조직(auth.org.id)으로 거르므로 다른 조직의 근거는 나오지 않는다. 요청을 찾을 수 없거나 그 사람의 표가 없으면 null.
 */
export function evidenceLookup(db: DB, auth: AuthContext): (requestId: string, actorId: string | null) => DecisionEvidence | null {
  const cache = new Map<string, Map<string, DecisionEvidence>>();
  return (requestId, actorId) => {
    if (!actorId) return null;
    let byUser = cache.get(requestId);
    if (!byUser) {
      let list: DecisionEvidence[] = [];
      try { list = decisionEvidence(db, auth.org.id, requestId, auth); } catch { list = []; }
      byUser = new Map(list.map((e) => [e.userId, e]));
      cache.set(requestId, byUser);
    }
    return byUser.get(actorId) ?? null;
  };
}

/**
 * CSV 내보내기용 행(오래된 순, 최대 limit행). 순번(orgSeq)은 목록·화면의 '번호'·검증 결과의 brokenAtNo와 같은 조직 안 순번이며
 * 필터를 걸기 전에 매긴다. 전체 공용 seq는 내보내지 않는다. actor_id는 결정 근거를 찾을 때만 쓰고 CSV 열에는 넣지 않는다.
 */
export function auditOrgRows(db: DB, auth: AuthContext, q: { action?: string; actor?: string; q?: string; from?: string; to?: string }, limit: number) {
  const { w, args } = auditWhere(auth, q);
  return db.prepare(
    `SELECT org_seq orgSeq, created_at, actor_id, actor_name, action, target_type, target_id, summary, hash
       FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY seq) org_seq FROM audit_log WHERE org_id = ?)
      WHERE ${w} ORDER BY seq ASC LIMIT ?`,
  ).all(auth.org.id, ...args, limit) as { orgSeq: number; created_at: string; actor_id: string | null; actor_name: string; action: string; target_type: string; target_id: string; summary: string; hash: string }[];
}

/** 조건에 맞는 감사 기록 수(내보내기 상한과 관계없이). CSV 표지의 '조건에 맞는 기록 n건'. */
export function auditMatchedCount(db: DB, auth: AuthContext, q: { action?: string; actor?: string; q?: string; from?: string; to?: string }): number {
  const { w, args } = auditWhere(auth, q);
  return (db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE ${w}`).get(...args) as { c: number }).c;
}

/** 감사 기록 CSV의 최대 행 수(표지에 잘림을 알린다) */
export const AUDIT_EXPORT_LIMIT = 50_000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const grouped = (n: number) => n.toLocaleString('en-US');

/**
 * 표지에 넣는 사용자 입력(필터 값): 줄바꿈·탭을 공백으로 바꿔 표지 줄 수가 늘지 않게 하고(머리글을 찾는 규칙이 흔들리지 않게),
 * 수식 문자(csvCell과 같은 FORMULA_START: =,+,-,@와 전각 ＝＋－＠)로 시작하면 앞에 작은따옴표를 붙인다. 셀 전체도 CSV 쓰기(csvCell)에서 다시 무력화한다.
 */
function coverInput(value: string): string {
  const s = value.replace(/[\r\n\t]+/g, ' ');
  return FORMULA_START.test(s) ? `'${s}` : s;
}

export interface AuditCsvCoverInput {
  /** 내보내기 조건(쿼리 그대로). 기간은 auditWhere와 같은 형식(YYYY-MM-DD)일 때만 적용되므로 표지도 그때만 쓴다. */
  filters: { action?: string; actor?: string; q?: string; from?: string; to?: string };
  rowCount: number;
  matchedCount: number;
  limit: number;
  exporter: { name: string; roleLabels: string[] };
  exportedAt: string;
  /** 조직 체인 검증 결과(조직 안 번호만, 전체 공용 순번은 쓰지 않는다) */
  chain: { ok: boolean; count: number; brokenAtNo: number | null; headHash: string | null };
}

/**
 * 감사 기록 CSV 표지(A2-4, 순수 함수). 첫 줄은 표지 제목 한 칸, 다음은 '항목,값' 두 열. 저장하지 않으며 해시 대상이 아니다.
 * 무결성 문장은 감사 기록 화면과 같은 A1 문장(AUDIT_INTEGRITY_TEXT)을 쓰고, '빠짐없이'·'변조 없음' 같은 보장 말은 쓰지 않는다.
 */
export function auditCsvCover(input: AuditCsvCoverInput): string[][] {
  const f = input.filters;
  const from = f.from && DATE_ONLY.test(f.from) ? f.from : null;
  const to = f.to && DATE_ONLY.test(f.to) ? f.to : null;
  const period = from || to ? `${from ?? '처음'} ~ ${to ?? '지금'} (한국 시간 날짜)` : '전체 기간';
  const conds = [
    f.action ? `행동: ${coverInput(actionLabel(f.action))}(${coverInput(f.action)})` : null,
    f.actor ? `수행자: ${coverInput(f.actor)}` : null,
    f.q ? `내용 검색: ${coverInput(f.q)}` : null,
  ].filter((x): x is string => !!x);
  const truncated = input.matchedCount > input.limit;
  const rows: string[][] = [
    [AUDIT_EXPORT_TEXT.coverTitle],
    ['항목', '값'],
    ['기간', period],
    ['조건', conds.length ? conds.join(' · ') : '조건 없음'],
    ['내보낸 행', truncated
      ? `${grouped(input.limit)}건까지만 내보냈습니다 · 조건에 맞는 기록 ${grouped(input.matchedCount)}건`
      : `${grouped(input.rowCount)}건 · 조건에 맞는 기록 ${grouped(input.matchedCount)}건`],
    ['내보낸 사람', `${input.exporter.name} (${input.exporter.roleLabels.join(', ') || '역할 없음'})`],
    ['내보낸 시각', `${kstDateTime(input.exportedAt, { seconds: true })} (한국 시간)`],
    ['해시 연결 확인(조직 전체)', input.chain.ok ? AUDIT_INTEGRITY_TEXT.ok(input.chain.count) : AUDIT_INTEGRITY_TEXT.broken(input.chain.brokenAtNo)],
  ];
  // 보관용 값과 확인 범위는 감사 기록 화면처럼 체인이 맞을 때만 쓴다(어긋난 체인의 끝 해시는 보관할 근거가 아니다).
  // 보관용 값은 이번 audit.exported를 쓰기 전 체인이다. 내보낸 직후 화면의 건수·해시와 다른 이유를 같은 칸에 적는다(해시된 행·verifyChain·상세는 그대로).
  if (input.chain.ok && input.chain.headHash) rows.push(['보관용 값', `${AUDIT_INTEGRITY_TEXT.anchor(input.chain.count, input.chain.headHash)} ${AUDIT_EXPORT_TEXT.anchorNote}`]);
  if (input.chain.ok) rows.push(['확인 범위', AUDIT_INTEGRITY_TEXT.scope('위')]);
  rows.push(['안내', AUDIT_EXPORT_TEXT.coverNote]);
  return rows;
}

/** CSV '결정 근거(내보낼 때 계산)' 열: 승인·반려 행에만 쓰고 다른 행은 비운다. 내보내기 권한자는 감사 기록 조회 권한도 있어 결정 당시 역할을 쓴다. */
export function auditCsvEvidence(db: DB, auth: AuthContext) {
  const lookup = evidenceLookup(db, auth);
  const showRoles = auth.perms.has('audit.read');
  return (row: { action: string; target_id: string; actor_id: string | null }): string => {
    if (!DECISION_ACTIONS.has(row.action)) return '';
    const e = lookup(row.target_id, row.actor_id);
    return e ? decisionEvidenceText(e, { showRoles }) : '';
  };
}

export function auditWhere(auth: AuthContext, q: { action?: string; actor?: string; q?: string; from?: string; to?: string }) {
  const where = ['org_id = ?'];
  const args: any[] = [auth.org.id];
  if (q.action) { where.push('action = ?'); args.push(q.action); }
  if (q.actor) { where.push('actor_name LIKE ? ESCAPE \'\\\''); args.push(likePattern(q.actor)); }
  if (q.q) { where.push("summary LIKE ? ESCAPE '\\'"); args.push(likePattern(q.q)); }
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) { where.push('created_at >= ?'); args.push(new Date(`${q.from}T00:00:00+09:00`).toISOString()); }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) { where.push('created_at < ?'); args.push(new Date(new Date(`${q.to}T00:00:00+09:00`).getTime() + 86400_000).toISOString()); }
  return { w: where.join(' AND '), args };
}

export function insights(db: DB, cfg: AppConfig, auth: AuthContext, q: { provider?: string; q?: string; limit: number; offset: number; includeHidden?: boolean; related?: boolean }) {
  const where: string[] = [];
  const args: any[] = [];
  const manage = auth.perms.has('insight.manage') && q.includeHidden;
  if (!manage) where.push("i.status = 'published'");
  if (cfg.insightPolicy.requireWhitelistedProvider && !manage) where.push('p.is_whitelisted = 1');
  if (q.provider) { where.push('i.provider_id = ?'); args.push(q.provider); }
  if (q.q) { where.push("i.title LIKE ? ESCAPE '\\'"); args.push(likePattern(q.q)); }
  // 실험(기본 꺼짐, docs/experiments.md): 자기 조직이 보유한 자산 코드와 자료의 자산 태그만 비교한다.
  // 고객사 특성·거래 내역 등 다른 정보는 쓰지 않으며 외부로 보내지 않는다.
  if (q.related) {
    const held = (db.prepare("SELECT DISTINCT b.asset_code c FROM balances b JOIN wallets w ON w.id = b.wallet_id WHERE w.org_id = ? AND b.total_units <> '0'").all(auth.org.id) as { c: string }[]).map((x) => x.c);
    if (held.length === 0) where.push('0');
    else {
      where.push(`(${held.map(() => "(',' || i.asset_tags || ',') LIKE ?").join(' OR ')})`);
      args.push(...held.map((h) => `%,${h},%`));
    }
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM insights i JOIN insight_providers p ON p.id = i.provider_id ${w}`).get(...args) as { c: number }).c;
  const rows = db.prepare(`SELECT i.*, p.name provider_name, p.is_whitelisted FROM insights i JOIN insight_providers p ON p.id = i.provider_id ${w} ORDER BY i.published_at DESC, i.id LIMIT ? OFFSET ?`).all(...args, q.limit, q.offset) as any[];
  const newSince = new Date(Date.now() - cfg.insightPolicy.newBadgeDays * 86400_000).toISOString().slice(0, 10);
  return {
    total, offset: q.offset, limit: q.limit, disclosure: cfg.insightPolicy.disclosure,
    items: rows.map((r) => ({ id: r.id, title: r.title, summary: r.summary, language: r.language, publishedAt: r.published_at, url: r.url, providerId: r.provider_id, providerName: r.provider_name, providerWhitelisted: !!r.is_whitelisted, status: r.status, assetTags: r.asset_tags ? String(r.asset_tags).split(',') : [], isNew: r.published_at >= newSince, curatedAt: r.curated_at })),
  };
}

export function providers(db: DB, auth: AuthContext) {
  const all = db.prepare('SELECT id, name, is_whitelisted isWhitelisted, homepage FROM insight_providers ORDER BY name').all() as any[];
  return auth.perms.has('insight.manage') ? all.map((p) => ({ ...p, isWhitelisted: !!p.isWhitelisted })) : all.filter((p) => p.isWhitelisted).map((p) => ({ ...p, isWhitelisted: true }));
}

export { now };