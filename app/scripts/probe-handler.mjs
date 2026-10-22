// Vercel 함수 런타임과 같은 조건으로 빌드된 핸들러를 띄워 본다.
// Vercel의 모듈 로더는 CommonJS에서 ES 모듈을 require()하지 못하므로, 이 스크립트는
// `node --no-experimental-require-module`로 실행해야 의미가 있다(npm run check:vercel).
// 사용: npm run build:vercel 뒤 node --no-experimental-require-module scripts/probe-handler.mjs
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.VERCEL = '1';
process.env.DEMO_PUBLIC = '1';
process.env.LOG_LEVEL ??= 'warn';
// 공개 데모는 세션 서명 값이 없으면 기동을 거부한다. 점검에는 이번 실행에만 쓰는 무작위 값을 쓴다(출력·저장하지 않음).
process.env.DEMO_SESSION_SECRET ||= randomBytes(32).toString('base64url');

const entry = pathToFileURL(path.resolve('api/index.mjs')).href;
const { default: handler } = await import(entry);
if (typeof handler !== 'function') throw new Error('api/index.mjs의 기본 내보내기가 함수가 아닙니다.');

const server = http.createServer((req, res) => handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/healthz`);
  const body = await res.json();
  if (res.status !== 200 || body.mode !== 'public-demo') {
    throw new Error(`healthz 응답이 예상과 다릅니다: ${res.status} ${JSON.stringify(body)}`);
  }
  console.log(`핸들러 점검 통과: /api/healthz ${res.status}, mode=${body.mode}`);
  await probeAttachments(port);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
/**
 * 지급 근거 파일(A2b): 묶은 핸들러와 http → 핸들러 경로가 바이너리 본문을 그대로 넘기는지 본다.
 * 개발용 로그인(한지수) → 67바이트 PNG를 wr-6에 올림 → 내려받아 바이트·머리글 비교 → 삭제 → 2MiB+1바이트는 413.
 * Vercel 플랫폼 자체(본문 한도 4.5MB 등)는 미리보기 배포에서만 확인할 수 있다.
 */
async function probeAttachments(port) {
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'u-a-han' }) });
  if (login.status !== 200) throw new Error(`개발용 로그인 실패: ${login.status}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
  const h = { cookie, 'x-csrf-token': me.csrfToken };
  const png = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082', 'hex');
  const up = await fetch(`${base}/api/requests/wr-6/attachments`, { method: 'POST', headers: { ...h, 'content-type': 'application/octet-stream', 'x-attachment-name': encodeURIComponent('점검.png') }, body: png });
  const upBody = await up.json();
  if (up.status !== 201) throw new Error(`지급 근거 올리기 실패: ${up.status} ${JSON.stringify(upBody)}`);
  const x = upBody.paymentEvidence.attachments.at(-1);
  const dl = await fetch(`${base}${x.contentUrl}`, { headers: { cookie } });
  const got = Buffer.from(await dl.arrayBuffer());
  const expected = { 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cache-control': 'no-store' };
  for (const [k, v] of Object.entries(expected)) if (dl.headers.get(k) !== v) throw new Error(`내려받기 머리글 ${k}가 다릅니다: ${dl.headers.get(k)}`);
  if (!String(dl.headers.get('content-disposition')).startsWith('attachment; ')) throw new Error('내려받기가 첨부(attachment)가 아닙니다.');
  if (dl.status !== 200 || !got.equals(png)) throw new Error(`내려받은 바이트가 올린 파일과 다릅니다(${dl.status}, ${got.length}바이트).`);
  const del = await fetch(`${base}/api/requests/wr-6/attachments/${x.id}`, { method: 'DELETE', headers: h });
  if (del.status !== 200) throw new Error(`지급 근거 삭제 실패: ${del.status}`);
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20);
  big.write('%PDF-1.4', 0, 'latin1');
  const tooBig = await fetch(`${base}/api/requests/wr-6/attachments`, { method: 'POST', headers: { ...h, 'content-type': 'application/octet-stream' }, body: big });
  const tooBigBody = await tooBig.json();
  if (tooBig.status !== 413 || tooBigBody.error?.code !== 'ATTACHMENT_TOO_LARGE') throw new Error(`2MiB 초과 파일이 413으로 거부되지 않았습니다: ${tooBig.status}`);
  console.log(`핸들러 점검 통과: 지급 근거 올리기 201(${png.length}바이트) · 내려받기 바이트·머리글 일치 · 삭제 200 · 2MiB 초과 413`);
}

// 런타임이 남긴 타이머가 있어도 기다리지 않고 끝낸다(Windows에서 process.exit 직후 libuv 경고 방지).
setTimeout(() => process.exit(0), 50).unref();
