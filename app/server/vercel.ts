// Vercel 함수 진입점. `npm run build:api`가 이 파일을 .vercel-server/handler.mjs로 묶고,
// 커밋된 api/index.mjs가 그 기본 내보내기를 다시 내보낸다(docs/deploy-vercel.md).
// loadConfig는 VERCEL=1에서 DEMO_PUBLIC=1이 없으면 기동을 거부한다.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from './config.ts';
import { createRuntime } from './runtime.ts';

const rt = await createRuntime(loadConfig());
await rt.app.ready();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  rt.app.server.emit('request', req, res);
}
