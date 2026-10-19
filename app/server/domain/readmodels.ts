import type { DB } from '../db.ts';
import { now, tx } from '../db.ts';
import { AppError, Errors } from '../errors.ts';
import { writeAudit } from '../audit.ts';
import type { AuthContext } from '../auth.ts';
import type { AppConfig } from '../config.ts';
import { formatUnits, krwValue } from '../../shared/decimal.ts';
import { ROLE_LABEL, type Role } from '../../shared/terms.ts';
import { likePattern } from './addresses.ts';
import { validApprovals } from './requests.ts';

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
    `SELECT r.id, r.ref_no, r.status, r.asset_code, r.amount_units, a.precision, r.required_approvals, u.name creator_name, ab.label address_label, r.updated_at,
            (SELECT COUNT(*) FROM approvals x WHERE x.request_id = r.id AND x.decision = 'approved') approved
       FROM withdrawal_requests r JOIN assets a ON a.code = r.asset_code JOIN users u ON u.id = r.created_by JOIN address_book ab ON ab.id = r.address_id
      WHERE r.org_id = ? AND r.status IN ('REVIEW','PENDING_APPROVAL','PROCESSING') ORDER BY r.updated_at DESC LIMIT 6`,
  ).all(org) as any[];
  const inProgressCount = count("SELECT COUNT(*) c FROM withdrawal_requests WHERE org_id = ? AND status IN ('REVIEW','PENDING_APPROVAL','PROCESSING')", org);
  const recent = db.prepare(
    `SELECT t.id, t.type, t.asset_code, t.amount_units, a.precision, t.status, t.occurred_at, t.counterparty, n.name network_name
       FROM transactions t JOIN assets a ON a.code = t.asset_code JOIN networks n ON n.code = t.network_code WHERE t.org_id = ? ORDER BY t.occurred_at DESC LIMIT 5`,
  ).all(org) as any[];
  return {
    holdings: holdings(db, cfg, org),
    tasks,
    // 승인 대기 중인 요청의 승인 수는 지금 유효한 표만 센다(요청 상세의 approvedCount와 같은 기준).
    inProgress: inProgress.map((r) => ({ id: r.id, refNo: r.ref_no, status: r.status, assetCode: r.asset_code, amount: formatUnits(r.amount_units, r.precision), creatorName: r.creator_name, addressLabel: r.address_label, approved: r.status === 'PENDING_APPROVAL' ? validApprovals(db, r.id) : r.approved, requiredApprovals: r.required_approvals, updatedAt: r.updated_at })),
    inProgressCount,
    recentActivity: recent.map((t) => ({ id: t.id, type: t.type, assetCode: t.asset_code, amount: formatUnits(t.amount_units, t.precision), status: t.status, occurredAt: t.occurred_at, counterparty: t.counterparty, networkName: t.network_name })),
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
  return {
    total, page: q.page, pageSize: q.pageSize,
    items: rows.map((t) => ({ id: t.id, type: t.type, assetCode: t.asset_code, networkName: t.network_name, walletName: t.wallet_name, amount: formatUnits(t.amount_units, t.precision), counterparty: t.counterparty, status: t.status, occurredAt: t.occurred_at, txRef: t.tx_ref, requestId: t.request_id, requestRef: t.ref_no })),
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
  // seq는 DB 전체 순번이라 조직별로 보면 빈 번호가 생긴다. 조직 안 순번(orgSeq)은 필터를 걸기 전에 매긴다.
  const items = db.prepare(
    `SELECT seq, org_seq orgSeq, id, actor_id actorId, actor_name actorName, action, target_type targetType, target_id targetId, summary, detail, created_at createdAt, hash
       FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY seq) org_seq FROM audit_log WHERE org_id = ?)
      WHERE ${w} ORDER BY seq DESC LIMIT ? OFFSET ?`,
  ).all(auth.org.id, ...args, q.pageSize, (q.page - 1) * q.pageSize) as any[];
  const actions = (db.prepare('SELECT DISTINCT action FROM audit_log WHERE org_id = ? ORDER BY action').all(auth.org.id) as any[]).map((r) => r.action);
  return { total, page: q.page, pageSize: q.pageSize, actions, items: items.map((i) => ({ ...i, detail: JSON.parse(i.detail) })) };
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