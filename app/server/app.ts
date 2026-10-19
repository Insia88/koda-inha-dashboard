import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { APP_ROOT, type AppConfig } from './config.ts';
import { type DB, tx } from './db.ts';
import { AppError, Errors } from './errors.ts';
import { checkCsrf, createSession, loadAuth, requireAuth, requirePerm, revokeSession, SESSION_COOKIE, setSessionCookie } from './auth.ts';
import { writeAudit, verifyChain } from './audit.ts';
import { toCsv } from './csv.ts';
import type { CustodyAdapter } from './adapters/custody.ts';
import { getCatalog } from './domain/catalog.ts';
import { assertCanStopCooling, checkAddress, createAddress, disableAddress, getAddressRow, listAddresses, reviewAddress, stopCoolingAddress, toAddressDto } from './domain/addresses.ts';
import { approveRequest, backToDraft, cancelRequest, createDraft, getRequest, listRequests, moveToReview, rejectRequest, submitForApproval, updateDraft } from './domain/requests.ts';
import { readIdemKey, withIdempotency } from './domain/idempotency.ts';
import * as rm from './domain/readmodels.ts';
import {
  addressCheckSchema, addressCreateSchema, addressReviewSchema, addressStopSchema, insightCreateSchema, insightStatusSchema, pageQuery,
  requestDraftSchema, requestRejectSchema, requestSubmitSchema, requestUpdateSchema, roleUpdateSchema, versionSchema,
} from '../shared/schemas.ts';
import { ROLE_LABEL } from '../shared/terms.ts';

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  return schema.parse(data ?? {});
}

const str = z.string().max(200).optional();
const idParam = z.object({ id: z.string().min(1).max(64) });

/** 서버 인스턴스 정보(runtime.ts). 없으면 buildApp이 instanceId만 새로 만든다. */
export interface RuntimeInfo { instanceId: string; seededAt: string | null; tick?: () => void }
export interface AppDeps { cfg: AppConfig; db: DB; custody: CustodyAdapter; runtime?: RuntimeInfo }

/** 원문 링크가 제공 기관 홈페이지와 같은 호스트인지 확인한다(모든 모드). */
function assertProviderDomain(p: { name: string; homepage: string }, url: string) {
  let host = '';
  let expected = '';
  try { host = new URL(url).host; } catch { host = ''; }
  try { expected = new URL(p.homepage).host; } catch { expected = ''; }
  if (!host || !expected || host !== expected) {
    throw new AppError(422, 'PROVIDER_DOMAIN_MISMATCH', `원문 링크의 도메인(${host || '알 수 없음'})이 '${p.name}'의 등록 도메인(${expected || '미등록'})과 다릅니다.`, `'${p.name}'의 등록 도메인(${expected || '미등록'})에 있는 원문 링크만 게시하세요.`, [{ field: 'url', message: `${expected || '등록된'} 도메인의 링크만 게시할 수 있습니다.` }]);
  }
}

function assertWhitelisted(cfg: AppConfig, p: { name: string; is_whitelisted: number }) {
  if (cfg.insightPolicy.requireWhitelistedProvider && !p.is_whitelisted) {
    throw new AppError(422, 'PROVIDER_NOT_WHITELISTED', `'${p.name}'은(는) 화이트리스트에 없는 기관이라 게시할 수 없습니다.`, '화이트리스트 기관의 자료만 게시하세요. 기관 추가는 운영 기준에 따라 별도로 결정합니다.', [{ field: 'providerId', message: '화이트리스트 기관이 아닙니다.' }]);
  }
}

const DEMO_CAP_TABLE = { addresses: 'address_book', requests: 'withdrawal_requests', insights: 'insights' } as const;
const DEMO_CAP_LABEL: Record<keyof typeof DEMO_CAP_TABLE, string> = { addresses: '주소 등록', requests: '출금 요청', insights: '인사이트 게시' };

export async function buildApp({ cfg, db, custody, runtime }: AppDeps): Promise<FastifyInstance> {
  const demo = cfg.deployment === 'public-demo';
  const instance = { instanceId: runtime?.instanceId ?? randomUUID(), seededAt: runtime?.seededAt ?? null };
  const app = Fastify({
    logger: cfg.logLevel === 'silent' ? false : {
      level: cfg.logLevel,
      // 세션 쿠키·CSRF 값·요청 본문은 로그에 남기지 않는다.
      redact: { paths: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers.authorization', 'res.headers["set-cookie"]'], censor: '[가림]' },
    },
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
    // 공개 데모(Vercel)는 플랫폼이 X-Forwarded-For를 덮어쓰므로 그 값을 접속 IP로 쓴다. 로컬에서는 무시한다.
    trustProxy: cfg.trustProxy,
  });

  // 공개 데모: 인스턴스마다 사용자가 새로 만든 행 수를 종류별로 제한한다(기동 시점의 모의 데이터는 세지 않는다).
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  const demoBaseline = demo ? Object.fromEntries(Object.entries(DEMO_CAP_TABLE).map(([k, t]) => [k, count(t)])) as Record<keyof typeof DEMO_CAP_TABLE, number> : null;
  const assertDemoCapacity = (kind: keyof typeof DEMO_CAP_TABLE) => {
    if (!demoBaseline) return;
    if (count(DEMO_CAP_TABLE[kind]) - demoBaseline[kind] >= cfg.demoCreateLimit) {
      throw new AppError(422, 'DEMO_LIMIT', `공개 데모에서 새로 만들 수 있는 ${DEMO_CAP_LABEL[kind]} 건수(${cfg.demoCreateLimit}건)를 모두 사용했습니다.`, '이미 만들어진 항목으로 계속 확인하세요. 데모 데이터가 처음 상태로 돌아가면 다시 만들 수 있습니다.');
    }
  };

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: cfg.rateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, error: { code: 'RATE_LIMITED', message: '요청이 너무 많아 잠시 처리를 멈췄습니다.', action: `${Math.ceil(ctx.ttl / 1000)}초 후 다시 시도하세요.` } }),
  });

  // 상주 타이머가 없는 런타임(공개 데모 함수): /api 요청 때 정산·시세 기준 시각 갱신을 1초에 한 번까지 실행한다.
  const tick = runtime?.tick;
  if (cfg.lazyTicks && tick) {
    let lastTick = 0;
    app.addHook('onRequest', async (req) => {
      if (!req.url.startsWith('/api/')) return;
      const t = Date.now();
      if (t - lastTick < 1000) return;
      lastTick = t;
      tick();
    });
  }

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    req.auth = loadAuth(db, req.cookies[SESSION_COOKIE]);
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating && req.auth && req.url !== '/api/auth/dev-login') checkCsrf(req);
  });
  app.addHook('onSend', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    // 공개 데모: 응답한 인스턴스를 알려 화면이 데이터 초기화(다른 인스턴스·재시작)를 감지하게 한다.
    if (demo) reply.header('X-Demo-Instance', instance.instanceId);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      const fields = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
      return reply.status(422).send({ error: { code: 'VALIDATION', message: fields[0]?.message ?? '입력값을 확인하세요.', action: '표시된 항목을 고친 뒤 다시 시도하세요.', fields }, requestId: req.id });
    }
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, action: err.action, fields: err.fields, ...err.extra }, requestId: req.id });
    }
    if (err?.statusCode === 429) return reply.status(429).send(err);
    if (err?.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'BAD_REQUEST', message: '요청 형식이 올바르지 않습니다.', action: '페이지를 새로 고친 뒤 다시 시도하세요.' }, requestId: req.id });
    }
    const msg = String(err?.message ?? '');
    if (msg.includes('SELF_APPROVAL_FORBIDDEN')) {
      return reply.status(403).send({ error: { code: 'SELF_APPROVAL_FORBIDDEN', message: '본인이 작성한 요청은 승인할 수 없습니다.', action: '다른 승인자에게 요청하세요.' }, requestId: req.id });
    }
    req.log.error({ err: { message: msg, code: err?.code } }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '서버에서 요청을 처리하지 못했습니다. 변경 사항은 저장되지 않았습니다.', action: `잠시 후 다시 시도하세요. 계속되면 문의 시 요청 번호(${req.id.slice(0, 8)})를 알려 주세요.` }, requestId: req.id });
  });

  // ---------- 상태·인증 ----------
  app.get('/api/healthz', async () => ({ ok: true, env: cfg.nodeEnv, authMode: cfg.authMode, custody: custody.name, mode: cfg.deployment, instanceId: instance.instanceId, seededAt: instance.seededAt }));

  app.get('/api/auth/dev-users', async () => {
    const users = db.prepare('SELECT u.id, u.name, u.title, o.name org_name, o.id org_id FROM users u JOIN organizations o ON o.id = u.org_id WHERE u.is_active = 1 ORDER BY o.kind, o.name, u.name').all() as any[];
    return users.map((u) => ({ ...u, roles: (db.prepare('SELECT role FROM user_roles WHERE user_id = ?').all(u.id) as any[]).map((r) => r.role) }));
  });

  app.post('/api/auth/dev-login', { config: { rateLimit: { max: cfg.loginRateLimitMax, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { userId } = parse(z.object({ userId: z.string().min(1).max(64) }), req.body);
    const u = db.prepare('SELECT u.id, u.name, u.org_id FROM users u WHERE u.id = ? AND u.is_active = 1').get(userId) as any;
    if (!u) throw new AppError(401, 'LOGIN_FAILED', '선택한 개발용 계정으로 로그인할 수 없습니다.', '목록에서 다른 계정을 고르세요.');
    if (req.auth) revokeSession(db, req.auth.sessionHash);
    const s = createSession(db, u.id, cfg.sessionTtlMinutes);
    tx(db, () => writeAudit(db, { orgId: u.org_id, actorId: u.id, actorName: u.name, action: 'auth.login', targetType: 'user', targetId: u.id, summary: `${u.name} 로그인 (개발용 로그인)` }));
    setSessionCookie(reply, s.token, s.expires, cfg.cookieSecure);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) {
      const a = req.auth;
      revokeSession(db, a.sessionHash);
      tx(db, () => writeAudit(db, { orgId: a.org.id, actorId: a.user.id, actorName: a.user.name, action: 'auth.logout', targetType: 'user', targetId: a.user.id, summary: `${a.user.name} 로그아웃` }));
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/', secure: cfg.cookieSecure });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const a = requireAuth(req);
    return {
      user: a.user, org: a.org, roles: a.roles, roleLabels: a.roles.map((r) => ROLE_LABEL[r].label), permissions: [...a.perms], csrfToken: a.csrf,
      environment: { name: cfg.nodeEnv, authMode: cfg.authMode, custody: custody.name, custodyIsMock: custody.isMock, dataIsMock: a.org.isMock, mode: cfg.deployment, instanceId: instance.instanceId, seededAt: instance.seededAt },
      policy: { confirmTailLength: cfg.policy.addressBook.confirmTailLength, approval: cfg.policy.approval },
      insight: { experiments: cfg.insightPolicy.experiments },
    };
  });

  // ---------- 자산 ----------
  app.get('/api/dashboard', async (req) => rm.dashboard(db, cfg, requirePerm(req, 'dashboard.read', '대시보드 조회')));
  app.get('/api/balances', async (req) => rm.holdings(db, cfg, requirePerm(req, 'asset.read', '잔고 조회').org.id));
  app.get('/api/activity', async (req) => {
    const a = requirePerm(req, 'activity.read', '활동 내역 조회');
    const q = parse(pageQuery.extend({ type: str, assetCode: str, status: str, q: str, from: str, to: str, sort: str, order: str }), req.query);
    return rm.activity(db, a, q);
  });
  app.get('/api/catalog', async (req) => { requirePerm(req, 'catalog.read', '토큰 목록 조회'); return getCatalog(db); });
  app.get('/api/wallets', async (req) => rm.wallets(db, cfg, requirePerm(req, 'wallet.read', '지갑 조회')));
  app.get('/api/staking', async (req) => rm.staking(db, requirePerm(req, 'staking.read', '스테이킹 조회')));

  // ---------- 주소록 ----------
  app.get('/api/addresses', async (req) => {
    const a = requirePerm(req, 'address.read', '주소록 조회');
    return listAddresses(db, a, parse(z.object({ status: str, assetCode: str, networkCode: str, q: str, sort: str }), req.query));
  });
  app.get('/api/addresses/:id', async (req) => {
    const a = requirePerm(req, 'address.read', '주소록 조회');
    const { id } = parse(idParam, req.params);
    const row = getAddressRow(db, a.org.id, id);
    const history = db.prepare("SELECT action, actor_name actorName, summary, created_at createdAt FROM audit_log WHERE org_id = ? AND target_type = 'address' AND target_id = ? ORDER BY seq").all(a.org.id, id);
    return { ...toAddressDto(row, a), history };
  });
  app.post('/api/addresses/check', async (req) => {
    const a = requirePerm(req, 'address.read', '주소 점검');
    const input = parse(addressCheckSchema, req.body);
    return checkAddress(db, a.org.id, input);
  });
  app.post('/api/addresses', async (req, reply) => {
    const a = requirePerm(req, 'address.create', '주소 등록');
    assertDemoCapacity('addresses');
    const input = parse(addressCreateSchema, req.body);
    reply.status(201);
    return createAddress(db, a, cfg.policy, input);
  });
  app.post('/api/addresses/:id/review', async (req) => {
    const a = requirePerm(req, 'address.review', '주소 확인');
    const { id } = parse(idParam, req.params);
    return reviewAddress(db, a, cfg.policy, id, parse(addressReviewSchema, req.body));
  });
  app.post('/api/addresses/:id/disable', async (req) => {
    const a = requirePerm(req, 'address.disable', '주소 사용 중지');
    const { id } = parse(idParam, req.params);
    return disableAddress(db, a, id, parse(versionSchema, req.body).version);
  });
  // 사용 대기 중 정지: 주소 등록·확인·사용 중지 권한 중 하나만 있으면 된다(위험을 줄이는 행동). 사유 5자 이상.
  app.post('/api/addresses/:id/stop', async (req) => {
    const a = requireAuth(req);
    assertCanStopCooling(a);
    const { id } = parse(idParam, req.params);
    return stopCoolingAddress(db, a, id, parse(addressStopSchema, req.body));
  });

  // ---------- 출금 요청 ----------
  app.get('/api/requests', async (req) => {
    const a = requirePerm(req, 'request.read', '요청 조회');
    return listRequests(db, a, parse(pageQuery.extend({ status: str, view: str, q: str, sort: str, order: str }), req.query));
  });
  app.get('/api/requests/:id', async (req) => getRequest(db, requirePerm(req, 'request.read', '요청 조회'), parse(idParam, req.params).id));
  app.post('/api/requests', async (req, reply) => {
    const a = requirePerm(req, 'request.create', '출금 요청 작성');
    const key = readIdemKey(req.headers['idempotency-key'], true);
    const input = parse(requestDraftSchema, req.body);
    const out = tx(db, () => withIdempotency(db, a.user.id, 'POST /api/requests', key, input, () => {
      assertDemoCapacity('requests');
      return { status: 201, body: createDraft(db, a, input, key) };
    }));
    if (out.replayed) reply.header('Idempotent-Replayed', 'true');
    reply.status(out.status);
    return out.body;
  });
  app.put('/api/requests/:id', async (req) => updateDraft(db, requirePerm(req, 'request.create', '요청 수정'), parse(idParam, req.params).id, parse(requestUpdateSchema, req.body)));

  const action = (name: string, fn: (a: ReturnType<typeof requireAuth>, id: string, body: unknown) => unknown, perm: 'request.create' | 'request.approve') => {
    app.post(`/api/requests/:id/${name}`, async (req, reply) => {
      const a = requirePerm(req, perm, perm === 'request.create' ? '요청 작성·제출' : '요청 승인·반려');
      const { id } = parse(idParam, req.params);
      const key = readIdemKey(req.headers['idempotency-key'], false);
      const out = tx(db, () => withIdempotency(db, a.user.id, `POST /api/requests/${id}/${name}`, key, req.body ?? null, () => ({ status: 200, body: fn(a, id, req.body) })));
      if (out.replayed) reply.header('Idempotent-Replayed', 'true');
      reply.status(out.status);
      return out.body;
    });
  };
  action('review', (a, id, b) => moveToReview(db, a, id, parse(versionSchema, b).version), 'request.create');
  action('back-to-draft', (a, id, b) => backToDraft(db, a, id, parse(versionSchema, b).version), 'request.create');
  action('submit', (a, id, b) => submitForApproval(db, cfg, a, id, parse(requestSubmitSchema, b)), 'request.create');
  action('cancel', (a, id, b) => cancelRequest(db, a, id, parse(versionSchema, b).version), 'request.create');
  action('approve', (a, id, b) => approveRequest(db, a, custody, id, parse(versionSchema, b).version), 'request.approve');
  action('reject', (a, id, b) => rejectRequest(db, a, id, parse(requestRejectSchema, b)), 'request.approve');

  // ---------- 조직 ----------
  app.get('/api/org/members', async (req) => rm.members(db, requirePerm(req, 'org.read', '조직 조회')));
  app.put('/api/org/members/:id/roles', async (req) => {
    const a = requirePerm(req, 'org.manage', '역할 변경');
    const { id } = parse(idParam, req.params);
    const body = parse(roleUpdateSchema, req.body);
    return rm.updateRoles(db, a, id, body.roles, body.rolesVersion);
  });
  app.get('/api/org/policy', async (req) => {
    requirePerm(req, 'org.read', '조직 조회');
    return { approval: cfg.policy.approval, addressBook: cfg.policy.addressBook, isDesignAssumption: true };
  });

  // ---------- 감사 ----------
  const auditQuery = z.object({ action: str, actor: str, q: str, from: str, to: str });
  app.get('/api/audit', async (req) => {
    const a = requirePerm(req, 'audit.read', '감사 기록 조회');
    return rm.auditList(db, a, parse(pageQuery.merge(auditQuery), req.query));
  });
  app.get('/api/audit/verify', async (req) => verifyChain(db, requirePerm(req, 'audit.read', '감사 기록 조회').org.id));
  app.get('/api/audit/export.csv', async (req, reply) => {
    const a = requirePerm(req, 'audit.export', '감사 기록 내보내기');
    const q = parse(auditQuery, req.query);
    const { w, args } = rm.auditWhere(a, q);
    const rows = db.prepare(`SELECT seq, created_at, actor_name, action, target_type, target_id, summary, hash FROM audit_log WHERE ${w} ORDER BY seq ASC LIMIT 50000`).all(...args) as any[];
    tx(db, () => writeAudit(db, { orgId: a.org.id, actorId: a.user.id, actorName: a.user.name, action: 'audit.exported', targetType: 'audit', targetId: a.org.id, summary: `감사 기록 ${rows.length}건 내보내기`, detail: { filters: q } }));
    const csv = toCsv(['순번', '시각(UTC)', '수행자', '행동', '대상 종류', '대상 ID', '내용', '해시'], rows.map((r) => [r.seq, r.created_at, r.actor_name, r.action, r.target_type, r.target_id, r.summary, r.hash]));
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="koda-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
    return csv;
  });

  // ---------- Market Insight ----------
  app.get('/api/insights', async (req) => {
    const a = requirePerm(req, 'insight.read', 'Market Insight 조회');
    const q = parse(z.object({ provider: str, q: str, related: z.enum(['1', '0']).optional(), includeHidden: z.enum(['1', '0']).optional(), offset: z.coerce.number().int().min(0).max(100000).default(0), limit: z.coerce.number().int().min(1).max(50).default(cfg.insightPolicy.listBatchSize) }), req.query);
    if (q.related === '1' && !cfg.insightPolicy.experiments.holdingRelatedFilter) throw new AppError(404, 'EXPERIMENT_DISABLED', '보유 자산 관련 자료 보기는 꺼져 있는 실험 기능입니다.', '전체 자료 목록을 이용하세요.');
    return rm.insights(db, cfg, a, { ...q, includeHidden: q.includeHidden === '1', related: q.related === '1' });
  });
  app.get('/api/insights/providers', async (req) => rm.providers(db, requirePerm(req, 'insight.read', 'Market Insight 조회')));
  app.post('/api/insights', async (req, reply) => {
    const a = requirePerm(req, 'insight.manage', 'Market Insight 게시');
    const input = parse(insightCreateSchema, req.body);
    const p = db.prepare('SELECT id, name, is_whitelisted, homepage FROM insight_providers WHERE id = ?').get(input.providerId) as any;
    if (!p) throw new AppError(422, 'PROVIDER_NOT_FOUND', '제공 기관을 찾을 수 없습니다.', '기관 목록에서 다시 선택하세요.', [{ field: 'providerId', message: '기관을 선택하세요.' }]);
    assertWhitelisted(cfg, p);
    assertProviderDomain(p, input.url);
    assertDemoCapacity('insights');
    const id = randomUUID();
    tx(db, () => {
      db.prepare("INSERT INTO insights (id, provider_id, title, summary, language, published_at, url, asset_tags, status, curated_by, curated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)")
        .run(id, input.providerId, input.title, input.summary, input.language, input.publishedAt, input.url, input.assetTags.join(','), a.user.id, new Date().toISOString());
      writeAudit(db, { orgId: a.org.id, actorId: a.user.id, actorName: a.user.name, action: 'insight.published', targetType: 'insight', targetId: id, summary: `리서치 게시: ${input.title} (${p.name})` });
    });
    reply.status(201);
    return { id };
  });
  app.patch('/api/insights/:id', async (req) => {
    const a = requirePerm(req, 'insight.manage', 'Market Insight 관리');
    const { id } = parse(idParam, req.params);
    const { status } = parse(insightStatusSchema, req.body);
    const row = db.prepare('SELECT i.id, i.title, i.url, p.name, p.is_whitelisted, p.homepage FROM insights i JOIN insight_providers p ON p.id = i.provider_id WHERE i.id = ?').get(id) as any;
    if (!row) throw Errors.notFound('리서치 자료');
    // 다시 게시할 때도 게시 때와 같은 기준(화이트리스트·기관 도메인)을 다시 확인한다.
    if (status === 'published') {
      assertWhitelisted(cfg, row);
      assertProviderDomain(row, row.url);
    }
    tx(db, () => {
      db.prepare('UPDATE insights SET status = ? WHERE id = ?').run(status, id);
      writeAudit(db, { orgId: a.org.id, actorId: a.user.id, actorName: a.user.name, action: status === 'hidden' ? 'insight.hidden' : 'insight.published', targetType: 'insight', targetId: id, summary: `리서치 ${status === 'hidden' ? '숨김' : '게시'}: ${row.title}` });
    });
    return { id, status };
  });

  app.all('/api/*', async () => { throw Errors.notFound('API 경로'); });

  // ---------- 화면 ----------
  const dist = path.join(APP_ROOT, 'dist');
  if (cfg.serveClient && existsSync(dist)) {
    // 공개 데모(Vercel)는 화면을 CDN이 서빙하므로 이 플러그인을 불러오지 않는다. Vercel 함수 런타임은
    // CommonJS에서 ES 모듈을 require()하지 못해, 맨 위 정적 불러오기만으로도 함수가 시작하지 못했다.
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, { root: dist, prefix: '/', wildcard: true, index: false });
    app.get('/', (_req, reply) => reply.sendFile('index.html'));
    app.setNotFoundHandler((req: FastifyRequest, reply) => {
      if (req.method !== 'GET' || /\.[a-z0-9]+$/i.test(req.url.split('?')[0]!)) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '경로를 찾을 수 없습니다.' } });
      return reply.sendFile('index.html');
    });
  }
  return app;
}