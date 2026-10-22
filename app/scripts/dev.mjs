// 개발 실행: API 서버(4300)와 Vite 개발 서버(5173)를 함께 띄운다.
import { spawn } from 'node:child_process';
const opts = { stdio: 'inherit', shell: true };
const procs = [spawn('npx tsx watch server/index.ts', opts), spawn('npx vite', opts)];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);