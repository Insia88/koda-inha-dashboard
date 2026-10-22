import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { api, key, login, makeApp, type Session } from './helpers.ts';
import { loadConfig } from '../server/config.ts';
import { createRuntime, type Runtime } from '../server/runtime.ts';

// 공개 데모 무상태 세션. Vercel이 다음 요청을 다른 함수 인스턴스로 보내도 로그인이 유지되는지,
// 인스턴스 두 개(메모리 DB 각각, 같은 DEMO_SESSION_SECRET)로 확인한다. 로컬 저장소 세션은 그대로인지도 함께 본다.
const ENV_KEYS = ['NODE_ENV', 'VERCEL', 'DEMO_PUBLIC', 'DEMO_SESSION_SECRET', 'SESSION_TTL_MINUTES', 'DB_PATH', 'HOST', 'AUTH_MODE', 'LOG_LEVEL', 'DEV_ALLOW_LAN'] as const;
let savedEnv: Record<string, string | undefined> = {};
const cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// 서명 값은 실행마다 새로 만든다(저장소에 값을 두지 않는다).
const SECRET = randomBytes(32).toString('base64url');
const OTHER_SECRET = randomBytes(32).toString('base64url');
const TTL_SEC = 120 * 60;

async function demoInstance(): Promise<Runtime> {
  Object.assign(process.env, { VERCEL: '1', DEMO_PUBLIC: '1', DEMO_SESSION_SECRET: SECRET });
  const cfg = loadConfig({ logLevel: 'silent', rateLimitMax: 10000 });
  cfg.policy.mockCustodyProcessingMs = 0;
  const rt = await createRuntime(cfg);
  cleanups.push(() => rt.close());
  return rt;
}
/** 같은 서명 값을 쓰는 서로 다른 인스턴스 두 개(각자 메모리 DB). */
async function twoInstances() {
  const a = await demoInstance();
  const b = await demoInstance();
  expect(a.instanceId).not.toBe(b.instanceId);
  expect(a.db).not.toBe(b.db);
  return { a, b };
}

// 쿠키 형식을 서버 코드와 따로 구현해 명세(base64url(payload JSON) + '.' + base64url(HMAC-SHA256(secret, payload 부분)))를 확인한다.
const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest();
const sign = (payload: object, secret = SECRET) => { const body = b64(JSON.stringify(payload)); return `${body}.${b64(hmac(secret, body))}`; };
const tokenOf = (s: Session) => s.cookie.slice('koda_sid='.length);
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));
const nowSec = () => Math.floor(Date.now() / 1000);
const getMe = (rt: Runtime, token: string) => rt.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `koda_sid=${token}` } });
const sessionRows = (rt: { db: Runtime['db'] }) => (rt.db.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c;
const auditCount = (rt: Runtime, action: string, actorId: string) =>
  (rt.db.prepare('SELECT COUNT(*) c FROM audit_log WHERE action = ? AND actor_id = ?').get(action, actorId) as { c: number }).c;
const draft = { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '12.5', purpose: '다른 인스턴스 확인용 모의 요청' };

describe('공개 데모 무상태 세션: 다른 인스턴스에서도 로그인 유지', () => {
  it('issues a signed cookie {v:1, sid, uid, org, iat, exp} and stores no session row', async () => {
    const { a, b } = await twoInstances();
    const res = await a.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { userId: 'u-a-han' } });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^koda_sid=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43};/);
    for (const flag of [/;\s*Secure/, /;\s*HttpOnly/, /;\s*SameSite=Strict/, /;\s*Path=\/(;|$)/]) expect(setCookie).toMatch(flag);
    const token = setCookie.split(';')[0]!.slice('koda_sid='.length);
    const p = payloadOf(token);
    expect(Object.keys(p).sort()).toEqual(['exp', 'iat', 'org', 'sid', 'uid', 'v']);
    expect(p).toMatchObject({ v: 1, uid: 'u-a-han', org: 'org-a' });
    expect(p.sid).toMatch(/^[0-9a-f]{32}$/);
    expect(p.exp - p.iat).toBe(TTL_SEC);
    expect(Math.abs(p.iat - nowSec())).toBeLessThanOrEqual(5);
    // 쿠키 만료 시각은 토큰의 exp와 같다.
    expect(new Date(/Expires=([^;]+)/.exec(setCookie)![1]!).getTime()).toBe(p.exp * 1000);
    // 같은 형식을 따로 계산한 서명과 일치한다.
    expect(sign(p)).toBe(token);
    expect(sessionRows(a)).toBe(0);
    expect(sessionRows(b)).toBe(0);
  });

  it('a cookie issued by instance A authenticates /api/me on instance B', async () => {
    const { a, b } = await twoInstances();
    const s = await login(a.app, 'u-a-han');
    const onB = await getMe(b, tokenOf(s));
    expect(onB.statusCode).toBe(200);
    expect(onB.headers['x-demo-instance']).toBe(b.instanceId);
    const body = onB.json();
    expect(body.user.id).toBe('u-a-han');
    expect(body.org.id).toBe('org-a');
    expect(body.roles).toEqual(['requester']);
    expect(body.environment).toMatchObject({ mode: 'public-demo', instanceId: b.instanceId });
    // CSRF 값은 sid에서 계산하므로 어느 인스턴스에서 받아도 같다.
    expect(body.csrfToken).toBe(s.csrf);
    expect(body.csrfToken).toBe(b64(hmac(SECRET, `csrf:${payloadOf(tokenOf(s)).sid}`)));
    // 번갈아 응답해도 계속 같은 사용자다.
    for (let i = 0; i < 6; i++) {
      const r = await getMe(i % 2 ? a : b, tokenOf(s));
      expect(r.statusCode).toBe(200);
      expect(r.json().user.id).toBe('u-a-han');
    }
  });

  it("a CSRF-protected mutation with A's cookie and CSRF token succeeds on B, and the data stays on B", async () => {
    const { a, b } = await twoInstances();
    const s = await login(a.app, 'u-a-han');
    const onB = api(b.app, s);
    const created = await onB.post('/api/requests', draft, { 'idempotency-key': key() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.status).toBe('DRAFT');
    expect(created.body.createdBy.id).toBe('u-a-han');
    const check = await onB.post('/api/addresses/check', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: `MOCK-EVM-${'ab'.repeat(20)}`, memo: '' });
    expect(check.status).toBe(200);
    expect(Array.isArray(check.body.findings)).toBe(true);
    // 데이터 쓰기는 응답한 인스턴스에만 남는다(로그인과 달리 공유되지 않는다).
    expect((await onB.get(`/api/requests/${created.body.id}`)).status).toBe(200);
    expect((await api(a.app, s).get(`/api/requests/${created.body.id}`)).status).toBe(404);
    const createdAudit = (rt: Runtime) => (rt.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'request.created' AND target_id = ?").get(created.body.id) as { c: number }).c;
    expect(createdAudit(b)).toBe(1);
    expect(createdAudit(a)).toBe(0);
  });

  it('still requires the CSRF token on another instance and rejects one from a different session or secret', async () => {
    const { a, b } = await twoInstances();
    const s = await login(a.app, 'u-a-han');
    const other = await login(a.app, 'u-a-han');
    expect(other.csrf).not.toBe(s.csrf);
    const post = (csrf?: string) => b.app.inject({
      method: 'POST', url: '/api/requests', payload: draft,
      headers: { cookie: s.cookie, 'idempotency-key': key(), ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }) },
    });
    for (const csrf of [undefined, '', other.csrf, b64(hmac(OTHER_SECRET, `csrf:${payloadOf(tokenOf(s)).sid}`)), s.csrf.slice(0, -1)]) {
      const r = await post(csrf);
      expect(r.statusCode, String(csrf)).toBe(403);
      expect(r.json().error.code).toBe('CSRF_REJECTED');
    }
    expect((await post(s.csrf)).statusCode).toBe(201);
  });

  it('rejects tampered, expired, foreign-secret, cross-org and malformed tokens with 401', async () => {
    const { a, b } = await twoInstances();
    const s = await login(a.app, 'u-a-han');
    const token = tokenOf(s);
    const [body, sig] = token.split('.') as [string, string];
    const p = payloadOf(token);
    // 대조군: 같은 내용을 같은 키로 서명하면 통과한다(아래 401은 바꾼 부분 때문이다).
    expect((await getMe(b, sign(p))).statusCode).toBe(200);

    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    const cases: Record<string, string> = {
      'payload changed (uid), signature kept': `${b64(JSON.stringify({ ...p, uid: 'u-a-oh' }))}.${sig}`,
      'payload changed (exp extended), signature kept': `${b64(JSON.stringify({ ...p, exp: p.exp + 3600 }))}.${sig}`,
      'payload byte flipped': `${flip(body, 5)}.${sig}`,
      'signature first char flipped': `${body}.${flip(sig, 0)}`,
      'signature last char flipped': `${body}.${flip(sig, sig.length - 1)}`,
      'signature truncated': `${body}.${sig.slice(0, -2)}`,
      'signature with padding': `${body}.${sig}=`,
      'signature of another session': `${body}.${tokenOf(await login(a.app, 'u-a-oh')).split('.')[1]}`,
      'expired': sign({ ...p, iat: nowSec() - TTL_SEC - 60, exp: nowSec() - 60 }),
      'expires right now': sign({ ...p, iat: nowSec() - TTL_SEC, exp: nowSec() }),
      'longer than the configured lifetime': sign({ ...p, exp: p.iat + TTL_SEC + 60 }),
      'issued in the future': sign({ ...p, iat: nowSec() + 3600, exp: nowSec() + 3600 + 60 }),
      'signed with another secret': sign(p, OTHER_SECRET),
      'user of another org (org claim mismatch)': sign({ ...p, uid: 'u-b-bae', org: 'org-a' }),
      'org claim of another org': sign({ ...p, org: 'org-b' }),
      'unknown user': sign({ ...p, uid: 'u-nobody' }),
      'unknown version': sign({ ...p, v: 2 }),
      'missing version': sign({ sid: p.sid, uid: p.uid, org: p.org, iat: p.iat, exp: p.exp }),
      'non-hex sid': sign({ ...p, sid: 'z'.repeat(32) }),
      'string exp': sign({ ...p, exp: String(p.exp) }),
      'array payload': (() => { const bd = b64(JSON.stringify([p])); return `${bd}.${b64(hmac(SECRET, bd))}`; })(),
      'not JSON': (() => { const bd = b64('not json'); return `${bd}.${b64(hmac(SECRET, bd))}`; })(),
      'no dot': body + sig,
      'two dots': `${body}.${sig}.x`,
      'empty payload': `.${sig}`,
      'too long': `${b64('x'.repeat(600))}.${sig}`,
      'old-style random token': randomBytes(32).toString('base64url'),
    };
    for (const [name, t] of Object.entries(cases)) {
      for (const rt of [a, b]) {
        const r = await getMe(rt, t);
        expect(r.statusCode, name).toBe(401);
        expect(r.json().error.code, name).toBe('UNAUTHENTICATED');
      }
    }
    // 변조한 쿠키로는 변경 요청도 인증되지 않는다(CSRF 값이 맞아도 401).
    const forged = await b.app.inject({ method: 'POST', url: '/api/requests', payload: draft, headers: { cookie: `koda_sid=${cases['payload changed (uid), signature kept']}`, 'x-csrf-token': s.csrf, 'idempotency-key': key() } });
    expect(forged.statusCode).toBe(401);
  });

  it('loads the user on every request from the answering instance: inactive there means 401 there', async () => {
    const { a, b } = await twoInstances();
    const s = await login(a.app, 'u-a-kang');
    b.db.prepare("UPDATE users SET is_active = 0 WHERE id = 'u-a-kang'").run();
    expect((await getMe(b, tokenOf(s))).statusCode).toBe(401);
    expect((await getMe(a, tokenOf(s))).statusCode).toBe(200);
    // 역할도 매 요청 다시 읽는다.
    a.db.prepare("DELETE FROM user_roles WHERE user_id = 'u-a-kang' AND role = 'approver'").run();
    expect((await getMe(a, tokenOf(s))).json().roles).toEqual(['requester']);
  });

  it('logout clears the cookie with the same flags and is audited on the answering instance', async () => {
    const { a, b } = await twoInstances();
    const s = await login(a.app, 'u-a-han');
    expect(auditCount(a, 'auth.login', 'u-a-han')).toBe(1);
    const out = await b.app.inject({ method: 'POST', url: '/api/auth/logout', payload: {}, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });
    expect(out.statusCode).toBe(200);
    const c = String(out.headers['set-cookie']);
    expect(c).toMatch(/^koda_sid=;/);
    expect(c).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    expect(c).toMatch(/Max-Age=0/);
    for (const flag of [/;\s*Secure/, /;\s*HttpOnly/, /;\s*SameSite=Strict/, /;\s*Path=\/(;|$)/]) expect(c).toMatch(flag);
    expect(auditCount(b, 'auth.logout', 'u-a-han')).toBe(1);
    // 로그아웃에도 CSRF 값이 필요하다.
    const noCsrf = await b.app.inject({ method: 'POST', url: '/api/auth/logout', payload: {}, headers: { cookie: s.cookie } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('documents the trade-off: a copied cookie value stays valid until exp because the server keeps no session state', async () => {
    const { a, b } = await twoInstances();
    const s = await login(a.app, 'u-a-han');
    await api(b.app, s).post('/api/auth/logout');
    // 서버에서 폐기할 수 없다. 브라우저는 쿠키를 지웠지만 값을 따로 보관했다면 만료(120분)까지 쓸 수 있다(docs/deploy-vercel.md).
    expect((await getMe(a, tokenOf(s))).statusCode).toBe(200);
    // 끊는 방법은 서명 값 교체뿐이다: 새 값으로 뜬 인스턴스는 이전 쿠키를 받지 않는다.
    process.env.DEMO_SESSION_SECRET = OTHER_SECRET;
    const rotated = await createRuntime(loadConfig({ logLevel: 'silent' }));
    cleanups.push(() => rotated.close());
    expect((await getMe(rotated, tokenOf(s))).statusCode).toBe(401);
  });

  it('re-login replaces the cookie with a new sid and keeps the login rate limit and audit', async () => {
    const { a } = await twoInstances();
    const s = await login(a.app, 'u-a-han');
    const again = await a.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { userId: 'u-a-oh' }, headers: { cookie: s.cookie } });
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-ratelimit-limit']).toBe('30');
    const next = String(again.headers['set-cookie']).split(';')[0]!.slice('koda_sid='.length);
    expect(payloadOf(next)).toMatchObject({ uid: 'u-a-oh', org: 'org-a' });
    expect(payloadOf(next).sid).not.toBe(payloadOf(tokenOf(s)).sid);
    expect(auditCount(a, 'auth.login', 'u-a-oh')).toBe(1);
  });
});

describe('로컬 모드: 저장소 세션과 서버 폐기는 그대로', () => {
  it('issues opaque DB sessions, revokes them on logout, and never accepts a signed demo cookie', async () => {
    // 같은 프로세스에 서명 값이 있어도 로컬은 읽지 않는다.
    process.env.DEMO_SESSION_SECRET = SECRET;
    const ctx = await makeApp();
    cleanups.push(async () => { await ctx.app.close(); ctx.db.close(); });
    const s = await login(ctx.app, 'u-a-han');
    const token = tokenOf(s);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = ctx.db.prepare('SELECT user_id, csrf_token, revoked_at FROM sessions WHERE id_hash = ?').get(createHash('sha256').update(token).digest('hex')) as any;
    expect(row).toMatchObject({ user_id: 'u-a-han', csrf_token: s.csrf, revoked_at: null });
    expect((await api(ctx.app, s).post('/api/auth/logout')).status).toBe(200);
    expect((ctx.db.prepare('SELECT revoked_at FROM sessions WHERE user_id = ?').get('u-a-han') as any).revoked_at).toBeTruthy();
    expect((await api(ctx.app, s).get('/api/me')).status).toBe(401);
    // 공개 데모 형식의 서명된 쿠키는 로컬에서 의미가 없다.
    const demoToken = sign({ v: 1, sid: randomBytes(16).toString('hex'), uid: 'u-a-han', org: 'org-a', iat: nowSec(), exp: nowSec() + 600 });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `koda_sid=${demoToken}` } });
    expect(r.statusCode).toBe(401);
  });

  it('a cookie issued by a public demo instance does not authenticate a local app', async () => {
    const demo = await demoInstance();
    const s = await login(demo.app, 'u-a-han');
    for (const k of ['VERCEL', 'DEMO_PUBLIC'] as const) delete process.env[k];
    const ctx = await makeApp();
    cleanups.push(async () => { await ctx.app.close(); ctx.db.close(); });
    expect((await api(ctx.app, s).get('/api/me')).status).toBe(401);
    expect(sessionRows(ctx)).toBe(0);
  });
});
