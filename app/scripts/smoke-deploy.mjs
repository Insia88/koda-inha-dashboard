// 배포 확인(스모크) 검사. 모의 데이터 공개 데모가 안전 장치를 그대로 지키는지 실제 HTTP로 확인한다.
//
// 사용:
//   VERCEL_AUTOMATION_BYPASS_SECRET=<자동화 우회 값> node scripts/smoke-deploy.mjs https://<보호된 미리보기 주소>
//   node scripts/smoke-deploy.mjs https://<공개 운영 주소> --public   # 보호할 수 없는 운영 별칭을 공개로 두기로 한 경우
//   node scripts/smoke-deploy.mjs --local [포트]   # 먼저 `npm run build:vercel`. 빌드된 함수(api/index.mjs)를
//                                                  # VERCEL=1 DEMO_PUBLIC=1로 127.0.0.1:<포트>(기본 4418)에 띄워 검사한 뒤 닫는다.
//
// 원격 검사는 먼저 보호(Vercel Authentication)가 켜져 있는지 확인하고, 꺼져 있으면(200) 바로 중단한다.
// 마지막 검사는 개발용 로그인 한도(1분 30회)를 소진하므로 끝난 뒤 1분 동안 같은 IP에서 로그인이 막힌다.
// 검사 중 만든 출금 요청은 끝에서 취소한다. 우회 값은 출력하거나 저장하지 않는다.
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const LOCAL = args.includes('--local');
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';
let BASE = '';
let server = null;

if (LOCAL) {
  const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 4418);
  process.env.VERCEL = '1';
  process.env.DEMO_PUBLIC = '1';
  process.env.NODEJS_HELPERS = '0';
  process.env.LOG_LEVEL ??= 'warn';
  let handler;
  try {
    ({ default: handler } = await import('../api/index.mjs'));
  } catch (e) {
    console.error(`빌드된 함수를 불러오지 못했습니다: ${e.message}\n먼저 npm run build:vercel 을 실행하세요.`);
    process.exit(2);
  }
  server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  BASE = `http://127.0.0.1:${port}`;
} else {
  BASE = (args.find((a) => /^https?:\/\//.test(a)) ?? '').replace(/\/+$/, '');
  if (!BASE) {
    console.error('사용: node scripts/smoke-deploy.mjs <https://배포-주소> | --local [포트]');
    process.exit(2);
  }
  if (!BYPASS) console.warn('VERCEL_AUTOMATION_BYPASS_SECRET 이 없어 보호된 배포의 API 검사는 실패합니다.');
}

const results = [];
let loginAttempts = 0;
const created = [];

class Fail extends Error {}
const expect = (cond, msg) => { if (!cond) throw new Fail(msg); };

async function call(method, path, { body, cookie, csrf, headers = {}, bypass = true } = {}) {
  const h = { accept: 'application/json', ...headers };
  if (BYPASS && bypass) h['x-vercel-protection-bypass'] = BYPASS;
  if (cookie) h.cookie = cookie;
  if (csrf) h['x-csrf-token'] = csrf;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, headers: res.headers, text, json };
}

async function login(userId) {
  loginAttempts++;
  const r = await call('POST', '/api/auth/dev-login', { body: { userId } });
  expect(r.status === 200, `${userId} 로그인 실패 (${r.status} ${r.json?.error?.code ?? ''})`);
  const setCookie = r.headers.getSetCookie().find((c) => c.startsWith('koda_sid='));
  expect(setCookie, '세션 쿠키가 없습니다');
  const cookie = setCookie.split(';')[0];
  const me = await call('GET', '/api/me', { cookie });
  expect(me.status === 200, `${userId} /api/me ${me.status}`);
  return { userId, cookie, csrf: me.json.csrfToken, setCookie, me: me.json };
}

const idem = () => `smoke-${randomUUID()}`;

async function toPending(s, amount, purpose) {
  const c = await call('POST', '/api/requests', { ...s, headers: { 'idempotency-key': idem() }, body: { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount, purpose } });
  expect(c.status === 201, `출금 요청 작성 ${c.status} ${c.json?.error?.code ?? ''}`);
  created.push({ s, id: c.json.id });
  const rv = await call('POST', `/api/requests/${c.json.id}/review`, { ...s, body: { version: c.json.version } });
  expect(rv.status === 200, `검토 단계 이동 ${rv.status} ${rv.json?.error?.code ?? ''}`);
  const n = s.me.policy?.confirmTailLength ?? 6;
  const sub = await call('POST', `/api/requests/${c.json.id}/submit`, { ...s, body: { version: rv.json.version, confirmTail: String(c.json.address.address).slice(-n), ackIrreversible: true } });
  expect(sub.status === 200, `승인 요청 ${sub.status} ${sub.json?.error?.code ?? ''}`);
  return sub.json;
}

async function check(name, fn, skip) {
  if (skip) {
    results.push({ name, status: 'SKIP', detail: skip });
    console.log(`SKIP  ${name} — ${skip}`);
    return;
  }
  try {
    const detail = (await fn()) ?? '';
    results.push({ name, status: 'PASS', detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, status: 'FAIL', detail: e.message });
    console.log(`FAIL  ${name} — ${e.message}`);
  }
}

async function finish(code) {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  const fails = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${results.length}개 검사: 통과 ${results.filter((r) => r.status === 'PASS').length}, 실패 ${fails}, 건너뜀 ${results.filter((r) => r.status === 'SKIP').length} (${BASE})`);
  process.exit(code ?? (fails ? 1 : 0));
}

const CDN_ONLY = LOCAL ? 'CDN(vercel.json) 동작이라 로컬 함수 검사에서는 확인하지 않습니다' : null;
console.log(`배포 확인 대상: ${BASE}${LOCAL ? ' (로컬 함수)' : ''}\n`);

// 1. 보호가 켜져 있어야 한다. 꺼져 있으면 더 진행하지 않는다.
//    --public: 보호할 수 없는 운영 별칭(Hobby 요금제의 production 도메인)을 공개 상태로 둔다는 결정을 한 경우에만 쓴다.
//    이때 보호 여부는 실패 대신 경고로 기록하고 나머지 안전 검사를 계속한다.
const PUBLIC_OK = args.includes('--public');
await check('배포 보호 켜짐(우회 헤더 없이 401 또는 로그인 이동)', async () => {
  const r = await call('GET', '/', { bypass: false, headers: { accept: 'text/html' } });
  if (r.status === 200 && PUBLIC_OK) {
    console.log('WARN  배포 보호 없음 — --public으로 공개 배포임을 확인하고 검사를 계속합니다.');
    return '공개 배포(보호 없음, --public)';
  }
  if (r.status === 200) {
    results.push({ name: '중단', status: 'FAIL', detail: '보호 없이 200 응답' });
    console.log('FAIL  배포 보호 켜짐 — 우회 헤더 없이 200을 받았습니다. 보호(Deployment Protection)를 켠 뒤 다시 실행하세요. 검사를 중단합니다.');
    await finish(1);
  }
  expect(r.status === 401 || (r.status >= 300 && r.status < 400), `예상 401/3xx, 받은 값 ${r.status}`);
  return `${r.status}`;
}, LOCAL ? '로컬 함수에는 배포 보호가 없습니다' : null);

await check('/api/healthz 공개 데모 모드', async () => {
  const r = await call('GET', '/api/healthz');
  expect(r.status === 200, `상태 ${r.status}`);
  expect(r.json?.mode === 'public-demo', `mode=${r.json?.mode}`);
  expect(r.json?.instanceId && r.headers.get('x-demo-instance') === r.json.instanceId, 'X-Demo-Instance 헤더가 instanceId와 다릅니다');
  expect(/no-store/.test(r.headers.get('cache-control') ?? ''), 'Cache-Control no-store 없음');
  return `instance ${String(r.json.instanceId).slice(0, 8)}…, 생성 ${r.json.seededAt}`;
});

const SECURITY_HEADERS = [
  ['content-security-policy', (v) => v.includes("default-src 'self'") && v.includes("frame-ancestors 'none'") && v.includes('upgrade-insecure-requests')],
  ['x-content-type-options', (v) => v === 'nosniff'],
  ['referrer-policy', (v) => v === 'no-referrer'],
  ['x-frame-options', (v) => v.toUpperCase() === 'DENY'],
  ['cross-origin-opener-policy', (v) => v === 'same-origin'],
  ['permissions-policy', (v) => v.includes('camera=()')],
  ['strict-transport-security', (v) => /max-age=\d+/.test(v)],
  ['x-robots-tag', (v) => v.includes('noindex')],
];
for (const path of ['/', '/requests/wr-1']) {
  await check(`보안 헤더·화면 응답 ${path}`, async () => {
    const r = await call('GET', path, { headers: { accept: 'text/html' } });
    expect(r.status === 200, `상태 ${r.status}`);
    expect((r.headers.get('content-type') ?? '').includes('text/html'), `content-type ${r.headers.get('content-type')}`);
    const missing = SECURITY_HEADERS.filter(([k, ok]) => !ok(r.headers.get(k) ?? '')).map(([k]) => k);
    expect(missing.length === 0, `누락·불일치: ${missing.join(', ')}`);
  }, CDN_ONLY);
}

await check('없는 정적 파일은 404(화면 HTML로 대체하지 않음)', async () => {
  const r = await call('GET', '/missing.js', { headers: { accept: '*/*' } });
  expect(r.status === 404, `상태 ${r.status}`);
  expect(!(r.headers.get('content-type') ?? '').includes('text/html'), 'HTML이 돌아왔습니다');
}, CDN_ONLY);

await check('/api/me 쿠키 없이 401 + no-store', async () => {
  const r = await call('GET', '/api/me');
  expect(r.status === 401, `상태 ${r.status}`);
  expect(/no-store/.test(r.headers.get('cache-control') ?? ''), 'Cache-Control no-store 없음');
});

let han = null;
await check('개발용 로그인 쿠키 Secure·HttpOnly·SameSite=Strict', async () => {
  han = await login('u-a-han');
  const c = han.setCookie;
  expect(/;\s*Secure/i.test(c), 'Secure 없음');
  expect(/;\s*HttpOnly/i.test(c), 'HttpOnly 없음');
  expect(/;\s*SameSite=Strict/i.test(c), 'SameSite=Strict 없음');
});

await check('CSRF 값 없는 변경 요청 403', async () => {
  han ??= await login('u-a-han');
  const r = await call('POST', '/api/requests', { cookie: han.cookie, headers: { 'idempotency-key': idem() }, body: {} });
  expect(r.status === 403 && r.json?.error?.code === 'CSRF_REJECTED', `${r.status} ${r.json?.error?.code}`);
});

await check('본인 요청 승인 403', async () => {
  const kang = await login('u-a-kang');
  const p = await toPending(kang, '1', '배포 확인용 모의 요청(자동 취소)');
  const r = await call('POST', `/api/requests/${p.id}/approve`, { ...kang, body: { version: p.version } });
  expect(r.status === 403 && r.json?.error?.code === 'SELF_APPROVAL_FORBIDDEN', `${r.status} ${r.json?.error?.code}`);
});

await check('80,000 USDC는 승인 2명 필요', async () => {
  han ??= await login('u-a-han');
  const p = await toPending(han, '80000', '배포 확인용 고액 모의 요청(자동 취소)');
  expect(p.requiredApprovals === 2, `requiredApprovals=${p.requiredApprovals}`);
});

await check('MOCK- 형식이 아닌 주소 거부', async () => {
  han ??= await login('u-a-han');
  const address = `0x${'ab'.repeat(20)}`;
  const chk = await call('POST', '/api/addresses/check', { ...han, body: { assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '' } });
  expect(chk.status === 200 && chk.json?.findings?.some((f) => f.level === 'error'), `점검 결과 ${chk.status}`);
  const cr = await call('POST', '/api/addresses', { ...han, body: { label: '배포 확인', counterparty: '배포 확인', assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '', confirmTail: address.slice(-6), ackNotVerified: true, ackOutOfBandConfirmed: true } });
  expect(cr.status === 422, `등록 ${cr.status}`);
  return `점검 ${chk.json.findings.find((f) => f.level === 'error').code}, 등록 ${cr.json?.error?.code}`;
});

let op = null;
await check('화이트리스트 외 기관 게시 422', async () => {
  op = await login('u-k-op');
  const r = await call('POST', '/api/insights', { ...op, body: { providerId: 'prov-x', title: '배포 확인', summary: '배포 확인', language: 'ko', publishedAt: '2026-10-19', url: 'https://example.com/smoke' } });
  expect(r.status === 422 && r.json?.error?.code === 'PROVIDER_NOT_WHITELISTED', `${r.status} ${r.json?.error?.code}`);
});

await check('기관 도메인과 다른 원문 링크 422', async () => {
  op ??= await login('u-k-op');
  const r = await call('POST', '/api/insights', { ...op, body: { providerId: 'prov-a', title: '배포 확인', summary: '배포 확인', language: 'ko', publishedAt: '2026-10-19', url: 'https://example.net/smoke' } });
  expect(r.status === 422 && r.json?.error?.code === 'PROVIDER_DOMAIN_MISMATCH', `${r.status} ${r.json?.error?.code}`);
});

// 검사용 출금 요청 정리(실패해도 검사 결과에는 넣지 않는다).
for (const { s, id } of created) {
  const cur = await call('GET', `/api/requests/${id}`, s);
  if (cur.status === 200 && cur.json?.status === 'PENDING_APPROVAL') await call('POST', `/api/requests/${id}/cancel`, { ...s, body: { version: cur.json.version } });
}

await check('같은 IP의 31번째 로그인은 429(1분 30회)', async () => {
  let prev = null;
  for (let i = 0; i < 45; i++) {
    loginAttempts++;
    const r = await call('POST', '/api/auth/dev-login', { body: { userId: 'u-a-han' } });
    if (r.status === 429) {
      expect(r.json?.error?.code === 'RATE_LIMITED', `429 코드 ${r.json?.error?.code}`);
      expect(prev && prev.headers.get('x-ratelimit-limit') === '30' && prev.headers.get('x-ratelimit-remaining') === '0', `직전 응답 한도 ${prev?.headers.get('x-ratelimit-limit')}/${prev?.headers.get('x-ratelimit-remaining')}`);
      return `한도 30을 다 쓴 뒤 429 (이번 실행 로그인 ${loginAttempts}회)`;
    }
    expect(r.status === 200, `로그인 ${r.status}`);
    prev = r;
  }
  throw new Fail('45번 시도해도 429가 나오지 않았습니다(인스턴스가 바뀌었거나 한도가 다릅니다)');
});

await finish();
