import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { inspect } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { api, key, login, makeApp, upload } from './helpers.ts';
import { APP_ROOT, loadConfig, type AppConfig } from '../server/config.ts';
import { createRuntime, type Runtime } from '../server/runtime.ts';
import { migrate, openDb } from '../server/db.ts';
import { seed } from '../server/seed.ts';
import { buildApp } from '../server/app.ts';
import { MockCustodyAdapter, type CustodyAdapter } from '../server/adapters/custody.ts';

// 공개 데모(DEMO_PUBLIC=1) 실행 형태와 그 안전 잠금. 환경변수는 매 사례마다 비우고 끝나면 되돌린다.
const ENV_KEYS = [
  'NODE_ENV', 'VERCEL', 'DEMO_PUBLIC', 'HOST', 'DEV_ALLOW_LAN', 'DB_PATH', 'SESSION_TTL_MINUTES', 'AUTH_MODE', 'MOCK_PRICE_FEED',
  'LOG_LEVEL', 'PORT', 'RATE_LIMIT_MAX', 'LOGIN_RATE_LIMIT_MAX', 'MOCK_CUSTODY_PROCESSING_MS', 'DEMO_SESSION_SECRET',
  'REQUEST_ATTACHMENTS', 'ATTACHMENT_UPLOAD_RATE_LIMIT_MAX',
] as const;
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
const setEnv = (vars: Record<string, string>) => Object.assign(process.env, vars);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tail = (addr: string) => addr.slice(-6);
// 공개 데모 세션 서명 값은 실행마다 새로 만든다(저장소에 값을 두지 않는다).
const SECRET = randomBytes(32).toString('base64url');
const DEMO_ENV = { VERCEL: '1', DEMO_PUBLIC: '1', DEMO_SESSION_SECRET: SECRET };

async function demoRuntime(over: Partial<AppConfig> = {}): Promise<Runtime> {
  setEnv(DEMO_ENV);
  const cfg = loadConfig({ logLevel: 'silent', rateLimitMax: 10000, ...over });
  cfg.policy.mockCustodyProcessingMs = 0;
  const rt = await createRuntime(cfg);
  cleanups.push(() => rt.close());
  return rt;
}

/** 같은 사례 안에서 데모 런타임을 만든 뒤 로컬 앱을 만들 때 데모 환경변수를 지운다. */
function asLocal() {
  for (const k of ['VERCEL', 'DEMO_PUBLIC', 'NODE_ENV'] as const) delete process.env[k];
}

async function localApp(over: Partial<AppConfig> = {}) {
  asLocal();
  if (!Object.keys(over).length) {
    const ctx = await makeApp();
    cleanups.push(async () => { await ctx.app.close(); ctx.db.close(); });
    return ctx;
  }
  const cfg = loadConfig({ dbPath: ':memory:', logLevel: 'silent', serveClient: false, rateLimitMax: 10000, ...over });
  const db = openDb(':memory:');
  migrate(db);
  seed(db);
  const app = await buildApp({ cfg, db, custody: new MockCustodyAdapter(0) });
  cleanups.push(async () => { await app.close(); db.close(); });
  return { app, db };
}

async function toPending(app: Runtime['app'], userId: string, amount = '10') {
  const s = await login(app, userId);
  const a = api(app, s);
  const r = await a.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount, purpose: '공개 데모 테스트' }, { 'idempotency-key': key() });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const rv = await a.post(`/api/requests/${r.body.id}/review`, { version: r.body.version });
  expect(rv.status).toBe(200);
  const sub = await a.post(`/api/requests/${r.body.id}/submit`, { version: rv.body.version, confirmTail: tail(r.body.address.address), ackIrreversible: true });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return sub.body;
}

describe('설정 잠금(loadConfig)', () => {
  it('refuses hosted runtimes without the explicit DEMO_PUBLIC opt-in', () => {
    setEnv({ NODE_ENV: 'production' });
    expect(() => loadConfig()).toThrow(/DEMO_PUBLIC=1/);
    delete process.env.NODE_ENV;
    setEnv({ VERCEL: '1' });
    expect(() => loadConfig()).toThrow(/VERCEL=1/);
    setEnv({ DEMO_PUBLIC: '0' });
    expect(() => loadConfig()).toThrow(/개발용 로그인/);
  });

  it('keeps refusing unimplemented auth modes even in the demo', () => {
    setEnv({ VERCEL: '1', DEMO_PUBLIC: '1', AUTH_MODE: 'oidc' });
    expect(() => loadConfig()).toThrow(/AUTH_MODE=oidc/);
  });

  it('refuses the public demo without a DEMO_SESSION_SECRET of at least 32 bytes and never echoes the value', () => {
    setEnv({ VERCEL: '1', DEMO_PUBLIC: '1' });
    expect(() => loadConfig()).toThrow(/DEMO_SESSION_SECRET이 설정되지 않았습니다/);
    setEnv({ DEMO_SESSION_SECRET: '' });
    expect(() => loadConfig()).toThrow(/DEMO_SESSION_SECRET이 설정되지 않았습니다/);
    const short = 'short-secret-31-bytes-long-xxxx';
    expect(Buffer.byteLength(short)).toBe(31);
    setEnv({ DEMO_SESSION_SECRET: short });
    let msg = '';
    try { loadConfig(); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/32바이트보다 짧습니다/);
    expect(msg).toMatch(/Vercel 프로젝트 환경변수/);
    // CI·로컬 함수 점검(check:vercel 등)에서 이 오류를 만난 사람이 배포 값을 가져다 쓰지 않도록 임시 값을 안내한다.
    expect(msg).toMatch(/그 실행에만 쓰는 임시 값/);
    expect(msg).not.toContain(short);
    // 바이트 기준: 한글 11자(33바이트)는 받아들인다.
    setEnv({ DEMO_SESSION_SECRET: '가나다라마바사아자차카' });
    expect(loadConfig().demoSessionSecret?.byteLength).toBe(33);
    setEnv({ DEMO_SESSION_SECRET: SECRET });
    expect(loadConfig().demoSessionSecret?.byteLength).toBe(Buffer.byteLength(SECRET));
  });

  it('keeps the session secret out of JSON, inspect output and error text', () => {
    setEnv(DEMO_ENV);
    const cfg = loadConfig();
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
    expect(JSON.stringify(cfg)).toContain('"demoSessionSecret":"[가림]"');
    expect(inspect(cfg, { depth: 5, showHidden: true })).not.toContain(SECRET);
    expect(String(cfg.demoSessionSecret)).toBe('[가림]');
  });

  it('refuses a public demo session lifetime that cannot be computed', () => {
    setEnv({ ...DEMO_ENV, SESSION_TTL_MINUTES: 'abc' });
    expect(() => loadConfig()).toThrow(/SESSION_TTL_MINUTES=abc/);
    setEnv({ SESSION_TTL_MINUTES: '0' });
    expect(() => loadConfig()).toThrow(/0보다 큰 숫자/);
    setEnv({ SESSION_TTL_MINUTES: '30' });
    expect(loadConfig().sessionTtlMinutes).toBe(30);
  });

  it('refuses to build a public demo app whose config carries no session secret', async () => {
    setEnv(DEMO_ENV);
    const cfg = { ...loadConfig({ logLevel: 'silent' }), demoSessionSecret: null };
    const db = openDb(':memory:');
    cleanups.push(() => db.close());
    migrate(db);
    seed(db);
    await expect(buildApp({ cfg, db, custody: new MockCustodyAdapter(0) })).rejects.toThrow(/세션 서명 값/);
  });

  it('VERCEL=1 + DEMO_PUBLIC=1 starts the public demo with in-memory data, Secure cookies and proxy-aware IPs', () => {
    setEnv({ ...DEMO_ENV, DB_PATH: './data/should-not-be-used.sqlite' });
    const cfg = loadConfig();
    expect(cfg.deployment).toBe('public-demo');
    expect(cfg.dbPath).toBe(':memory:');
    expect(cfg.trustProxy).toBe(true);
    expect(cfg.cookieSecure).toBe(true);
    expect(cfg.serveClient).toBe(false);
    expect(cfg.lazyTicks).toBe(true);
    expect(cfg.sessionTtlMinutes).toBe(120);
    expect(cfg.authMode).toBe('dev');
    delete process.env.VERCEL;
    setEnv({ NODE_ENV: 'production' });
    expect(loadConfig().deployment).toBe('public-demo');
  });

  it('default env stays local and identical to the existing defaults', () => {
    const cfg = loadConfig();
    expect(cfg).toMatchObject({
      deployment: 'local', nodeEnv: 'development', host: '127.0.0.1', port: 4300, authMode: 'dev',
      dbPath: path.resolve(APP_ROOT, './data/koda-dev.sqlite'), sessionTtlMinutes: 480, serveClient: true, logLevel: 'info',
      rateLimitMax: 600, loginRateLimitMax: 30, trustProxy: false, cookieSecure: false, lazyTicks: false, mockPriceFeed: true,
      demoSessionSecret: null,
    });
    // 로컬은 저장소 세션을 쓰므로 서명 값이 있어도 읽지 않는다.
    setEnv({ DEMO_SESSION_SECRET: SECRET });
    expect(loadConfig().demoSessionSecret).toBeNull();
  });

  it("keeps DB_PATH=':memory:' as an in-memory database instead of resolving it to a file", () => {
    setEnv({ DB_PATH: ':memory:' });
    expect(loadConfig().dbPath).toBe(':memory:');
    setEnv({ DB_PATH: './data/x.sqlite' });
    expect(loadConfig().dbPath).toBe(path.resolve(APP_ROOT, './data/x.sqlite'));
  });

  it('refuses a non-loopback HOST unless DEV_ALLOW_LAN=1', () => {
    setEnv({ HOST: '0.0.0.0' });
    expect(() => loadConfig()).toThrow(/DEV_ALLOW_LAN=1/);
    setEnv({ HOST: '192.168.0.10' });
    expect(() => loadConfig()).toThrow(/HOST=192\.168\.0\.10/);
    setEnv({ DEV_ALLOW_LAN: '1' });
    expect(loadConfig().host).toBe('192.168.0.10');
    delete process.env.DEV_ALLOW_LAN;
    for (const h of ['127.0.0.1', 'localhost', '::1']) {
      setEnv({ HOST: h });
      expect(loadConfig().host).toBe(h);
    }
  });

  it('reads REQUEST_ATTACHMENTS=off and ATTACHMENT_UPLOAD_RATE_LIMIT_MAX, and keeps uploads on with a 32 MiB demo total by default', () => {
    const d = loadConfig();
    expect({ on: d.attachmentsEnabled, rate: d.attachmentUploadRateLimitMax, total: d.demoAttachmentTotalBytes }).toEqual({ on: true, rate: 30, total: 32 * 1024 * 1024 });
    setEnv({ REQUEST_ATTACHMENTS: 'off', ATTACHMENT_UPLOAD_RATE_LIMIT_MAX: '5' });
    const off = loadConfig();
    expect({ on: off.attachmentsEnabled, rate: off.attachmentUploadRateLimitMax }).toEqual({ on: false, rate: 5 });
  });

  it('reads MOCK_PRICE_FEED=off', () => {
    setEnv({ MOCK_PRICE_FEED: 'off' });
    expect(loadConfig().mockPriceFeed).toBe(false);
  });
});

describe('런타임(createRuntime)', () => {
  it('refuses to start the public demo with a non-mock custody adapter', async () => {
    setEnv(DEMO_ENV);
    const real: CustodyAdapter = { name: '실제 커스터디(가정)', isMock: false, submitWithdrawal: () => ({ ref: 'X' }), getStatus: () => 'processing' };
    await expect(createRuntime(loadConfig({ logLevel: 'silent' }), real)).rejects.toThrow(/모의 커스터디로만/);
  });

  it('refuses to start the public demo when the store holds a non-mock organization', async () => {
    const file = path.join(os.tmpdir(), `koda-demo-guard-${Date.now()}.sqlite`);
    cleanups.push(() => { for (const s of ['', '-wal', '-shm']) rmSync(file + s, { force: true }); });
    const db = openDb(file);
    migrate(db);
    seed(db);
    db.prepare("UPDATE organizations SET is_mock = 0 WHERE id = 'org-a'").run();
    db.close();
    setEnv(DEMO_ENV);
    await expect(createRuntime(loadConfig({ logLevel: 'silent', dbPath: file }))).rejects.toThrow(/모의 데이터가 아닌 조직 1곳/);
  });

  it('seeds a fresh in-memory store and reports instance and seed time', async () => {
    const rt = await demoRuntime();
    expect(rt.seeded).toBe(true);
    expect(rt.seededAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rt.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    const other = await demoRuntime();
    expect(other.instanceId).not.toBe(rt.instanceId);
  });

  it('tick() refreshes the mock price time only when it is older than 60s, and not with MOCK_PRICE_FEED=off', async () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    const rt = await demoRuntime();
    rt.db.prepare('UPDATE prices SET as_of = ?').run(old);
    rt.tick();
    const fresh = (rt.db.prepare('SELECT MIN(as_of) m FROM prices').get() as { m: string }).m;
    expect(fresh > old).toBe(true);
    rt.tick();
    expect((rt.db.prepare('SELECT MIN(as_of) m FROM prices').get() as { m: string }).m).toBe(fresh);

    const off = await demoRuntime({ mockPriceFeed: false });
    off.db.prepare('UPDATE prices SET as_of = ?').run(old);
    off.tick();
    expect((off.db.prepare('SELECT MAX(as_of) m FROM prices').get() as { m: string }).m).toBe(old);
  });
});

describe('공개 데모 앱', () => {
  it('sets a Secure, HttpOnly, SameSite=Strict session cookie', async () => {
    const rt = await demoRuntime();
    const res = await rt.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { userId: 'u-a-han' } });
    expect(res.statusCode).toBe(200);
    const c = String(res.headers['set-cookie']);
    expect(c).toMatch(/;\s*Secure/);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).toMatch(/Path=\/(;|$)/);
    const local = await localApp();
    const lc = String((await local.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { userId: 'u-a-han' } })).headers['set-cookie']);
    expect(lc).not.toMatch(/;\s*Secure/);
  });

  it('gives each X-Forwarded-For client its own login bucket in the demo, and ignores the header locally', async () => {
    const loginFrom = async (app: Runtime['app'], ip: string) =>
      (await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { userId: 'u-a-han' }, headers: { 'x-forwarded-for': ip } })).statusCode;
    const rt = await demoRuntime({ loginRateLimitMax: 2 });
    expect([await loginFrom(rt.app, '203.0.113.10'), await loginFrom(rt.app, '203.0.113.10'), await loginFrom(rt.app, '203.0.113.10')]).toEqual([200, 200, 429]);
    expect(await loginFrom(rt.app, '203.0.113.20')).toBe(200);

    asLocal();
    const small = await makeApp({ loginRateLimitMax: 2 });
    cleanups.push(async () => { await small.app.close(); small.db.close(); });
    expect([await loginFrom(small.app, '203.0.113.10'), await loginFrom(small.app, '203.0.113.11'), await loginFrom(small.app, '203.0.113.12')]).toEqual([200, 200, 429]);
  });

  it('settles an approved request on the next API request without any interval running', async () => {
    const rt = await demoRuntime();
    const pending = await toPending(rt.app, 'u-a-han');
    const oh = api(rt.app, await login(rt.app, 'u-a-oh'));
    const ap = await oh.post(`/api/requests/${pending.id}/approve`, { version: pending.version, intentHash: pending.intentHash });
    expect(ap.status).toBe(200);
    expect(ap.body.status).toBe('PROCESSING');
    await sleep(1100); // 정산은 /api 요청 때 1초에 한 번까지만 돈다
    // 요청이 없는 동안에는 아무것도 정산되지 않았다(백그라운드 타이머 없음).
    expect((rt.db.prepare('SELECT status FROM withdrawal_requests WHERE id = ?').get(pending.id) as { status: string }).status).toBe('PROCESSING');
    const got = await oh.get(`/api/requests/${pending.id}`);
    expect(got.body.status).toBe('COMPLETED');
  });

  it('reports mode, instance and seed time in healthz and /api/me, with an X-Demo-Instance header', async () => {
    const rt = await demoRuntime();
    const h = await rt.app.inject({ method: 'GET', url: '/api/healthz' });
    expect(h.json()).toMatchObject({ ok: true, mode: 'public-demo', instanceId: rt.instanceId, seededAt: rt.seededAt });
    expect(h.headers['x-demo-instance']).toBe(rt.instanceId);
    const anon = await rt.app.inject({ method: 'GET', url: '/api/me' });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers['x-demo-instance']).toBe(rt.instanceId);
    expect(anon.headers['cache-control']).toBe('no-store');
    const me = await api(rt.app, await login(rt.app, 'u-a-han')).get('/api/me');
    expect(me.body.environment).toMatchObject({ mode: 'public-demo', instanceId: rt.instanceId, seededAt: rt.seededAt });

    const local = await localApp();
    const lh = await local.app.inject({ method: 'GET', url: '/api/healthz' });
    expect(lh.json().mode).toBe('local');
    expect(lh.headers['x-demo-instance']).toBeUndefined();
  });

  it('caps user-created addresses, requests and insights per instance with DEMO_LIMIT (demo only)', async () => {
    const rt = await demoRuntime({ demoCreateLimit: 1 });
    const op = api(rt.app, await login(rt.app, 'u-k-op'));
    const ins = { providerId: 'prov-a', title: '모의 자료', summary: '요약', language: 'ko', publishedAt: '2026-10-19', url: 'https://example.com/demo-cap' };
    expect((await op.post('/api/insights', ins)).status).toBe(201);
    const capped = await op.post('/api/insights', ins);
    expect(capped.status).toBe(422);
    expect(capped.body.error.code).toBe('DEMO_LIMIT');
    expect(capped.body.error.action).toBeTruthy();

    const han = api(rt.app, await login(rt.app, 'u-a-han'));
    const body = { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '1', purpose: '데모 한도 테스트' };
    expect((await han.post('/api/requests', body, { 'idempotency-key': key() })).status).toBe(201);
    expect((await han.post('/api/requests', body, { 'idempotency-key': key() })).body.error.code).toBe('DEMO_LIMIT');

    const none = await demoRuntime({ demoCreateLimit: 0 });
    const hanNone = api(none.app, await login(none.app, 'u-a-han'));
    expect((await hanNone.post('/api/addresses', {})).body.error.code).toBe('DEMO_LIMIT');

    const local = await localApp({ demoCreateLimit: 1 });
    const lop = api(local.app, await login(local.app, 'u-k-op'));
    expect((await lop.post('/api/insights', ins)).status).toBe(201);
    expect((await lop.post('/api/insights', ins)).status).toBe(201);
  });

  it('counts evidence uploads toward DEMO_LIMIT (even after a delete) and caps the instance total bytes (demo only)', async () => {
    // 메모리에서 만든 PDF(앞부분 '%PDF-')
    const pdf = (size: number, fill = 0x20) => { const b = Buffer.alloc(size, fill); b.write('%PDF-1.4 ', 0, 'latin1'); return b; };
    const rt = await demoRuntime({ demoCreateLimit: 1 });
    const hs = await login(rt.app, 'u-a-han');
    const first = await upload(rt.app, hs, 'wr-6', pdf(300), 'a.pdf');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await upload(rt.app, hs, 'wr-6', pdf(300, 0x21), 'b.pdf');
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('DEMO_LIMIT');
    expect(second.body.error.message).toContain('지급 근거 파일 올리기');
    // 지워도 올린 횟수는 줄지 않는다
    const del = await api(rt.app, hs).del(`/api/requests/wr-6/attachments/${first.body.paymentEvidence.attachments[0].id}`);
    expect(del.status).toBe(200);
    expect((await upload(rt.app, hs, 'wr-6', pdf(300, 0x22), 'c.pdf')).body.error.code).toBe('DEMO_LIMIT');

    const bytes = await demoRuntime({ demoAttachmentTotalBytes: 1000 });
    const bs = await login(bytes.app, 'u-a-han');
    expect((await upload(bytes.app, bs, 'wr-6', pdf(600), 'a.pdf')).status).toBe(201);
    const over = await upload(bytes.app, bs, 'wr-6', pdf(600, 0x21), 'b.pdf');
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('DEMO_LIMIT');
    expect(over.body.error.message).toContain('용량');
    expect(over.body.error.action).toBeTruthy();

    // 로컬에는 두 한도가 없다
    const local = await localApp({ demoCreateLimit: 1, demoAttachmentTotalBytes: 1000 });
    const ls = await login(local.app, 'u-a-han');
    for (const [i, fill] of [0x20, 0x21, 0x22].entries()) expect((await upload(local.app, ls, 'wr-6', pdf(600, fill), `l${i}.pdf`)).status).toBe(201);
  });
});

describe('인사이트 원문 링크 도메인·다시 게시 검사(모든 모드)', () => {
  const base = { providerId: 'prov-a', title: '모의 자료', summary: '요약', language: 'ko', publishedAt: '2026-10-19' };

  it('rejects a link whose host differs from the provider homepage in local and demo mode', async () => {
    const local = await localApp();
    const rt = await demoRuntime();
    for (const app of [local.app, rt.app]) {
      const op = api(app, await login(app, 'u-k-op'));
      for (const url of ['https://example.net/x', 'https://sub.example.com/x', 'https://example.com.evil.test/x', 'https://example.com:8443/x']) {
        const r = await op.post('/api/insights', { ...base, url });
        expect(r.status, url).toBe(422);
        expect(r.body.error.code).toBe('PROVIDER_DOMAIN_MISMATCH');
        expect(r.body.error.fields[0].field).toBe('url');
      }
      expect((await op.post('/api/insights', { ...base, url: 'https://EXAMPLE.com/ok' })).status).toBe(201);
    }
  });

  it('re-checks the whitelist when an item is published again', async () => {
    const local = await localApp();
    const op = api(local.app, await login(local.app, 'u-k-op'));
    expect((await op.patch('/api/insights/ins-x1', { status: 'hidden' })).status).toBe(200);
    const again = await op.patch('/api/insights/ins-x1', { status: 'published' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('PROVIDER_NOT_WHITELISTED');
    const row = local.db.prepare("SELECT status FROM insights WHERE id = 'ins-x1'").get() as { status: string };
    expect(row.status).toBe('hidden');
    expect((await op.patch('/api/insights/ins-h1', { status: 'published' })).status).toBe(200);
  });
});

describe('Vercel 설정 파일', () => {
  const vercel = JSON.parse(readFileSync(path.join(APP_ROOT, 'vercel.json'), 'utf8'));
  const spa = vercel.headers.find((h: any) => h.source === '/((?!api/).*)');
  const header = (k: string) => spa.headers.find((x: any) => x.key.toLowerCase() === k)?.value as string | undefined;

  it('mirrors the app CSP on CDN responses and adds the static security headers', async () => {
    const local = await localApp();
    const helmetCsp = String((await local.app.inject({ method: 'GET', url: '/api/healthz' })).headers['content-security-policy']);
    const norm = (s: string) => s.split(';').map((x) => x.trim()).filter(Boolean).sort();
    expect(norm(header('content-security-policy') ?? '')).toEqual(norm(`${helmetCsp};upgrade-insecure-requests`));
    expect(header('x-content-type-options')).toBe('nosniff');
    expect(header('referrer-policy')).toBe('no-referrer');
    expect(header('x-frame-options')).toBe('DENY');
    expect(header('cross-origin-opener-policy')).toBe('same-origin');
    expect(header('permissions-policy')).toContain('camera=()');
    expect(header('strict-transport-security')).toMatch(/max-age=\d+/);
    expect(header('x-robots-tag')).toBe('noindex, nofollow');
    const assets = vercel.headers.find((h: any) => h.source === '/assets/(.*)');
    expect(assets.headers[0]).toEqual({ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' });
  });

  it('routes /api to one function, falls back to index.html only for extension-less paths, and never auto-deploys from git', () => {
    expect(vercel).toMatchObject({ framework: 'vite', installCommand: 'npm ci', buildCommand: 'npm run build:vercel', outputDirectory: 'dist', regions: ['icn1'], git: { deploymentEnabled: false } });
    expect(vercel.functions['api/index.mjs']).toEqual({ includeFiles: '{config/**,server/migrations/**}', maxDuration: 15 });
    expect(vercel.rewrites).toEqual([{ source: '/api/(.*)', destination: '/api' }, { source: '/((?!api/)[^.]*)', destination: '/index.html' }]);
    const spaRe = new RegExp(`^${vercel.rewrites[1].source}$`);
    expect(spaRe.test('/requests/wr-1')).toBe(true);
    expect(spaRe.test('/')).toBe(true);
    expect(spaRe.test('/missing.js')).toBe(false);
    expect(spaRe.test('/api/healthz')).toBe(false);
    expect(readFileSync(path.join(APP_ROOT, 'api', 'index.mjs'), 'utf8')).toMatch(/export \{ default \} from '\.\.\/\.vercel-server\/handler\.mjs';/);
    const pkg = JSON.parse(readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['build:api']).toContain('server/vercel.ts');
    expect(pkg.scripts['build:api']).toContain('--outfile=.vercel-server/handler.mjs');
  });
});
