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
} finally {
  await new Promise((resolve) => server.close(resolve));
}
// 런타임이 남긴 타이머가 있어도 기다리지 않고 끝낸다(Windows에서 process.exit 직후 libuv 경고 방지).
setTimeout(() => process.exit(0), 50).unref();
