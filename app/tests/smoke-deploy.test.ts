// 배포 확인 스크립트(scripts/smoke-deploy.mjs)의 판정 규칙. 실제 배포 대신 127.0.0.1의 대역 서버에 돌려 출력만 본다.
// - 보호 없는 주소를 --public으로 검사하면 보호 검사는 통과(PASS)가 아니라 경고(WARN)로 남고, 요약의 통과 수에 들지 않는다.
// - 'MOCK- 형식이 아닌 주소 거부'는 등록이 주소 규칙 오류로 거부될 때만 통과한다(본문 형식 오류 VALIDATION으로는 통과하지 않음).
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/smoke-deploy.mjs');

type Mode = {
  /** POST /api/addresses 응답(본문을 받아 상태·오류 코드를 정한다) */
  register?: (body: any) => { status: number; code?: string };
};

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

/** 보호 없이 200을 주는 화면과, 로그인·주소 점검·주소 등록만 흉내 내는 최소 API. 나머지는 404. */
function standIn(mode: Mode) {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = raw ? JSON.parse(raw) : undefined;
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><title>demo</title>');
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/dev-login') {
        return json(res, 200, { ok: true }, { 'set-cookie': 'koda_sid=e30.c2ln; Path=/; HttpOnly; Secure; SameSite=Strict' });
      }
      if (req.method === 'GET' && url.pathname === '/api/me') {
        if (!String(req.headers.cookie ?? '').includes('koda_sid=e30.c2ln')) return json(res, 401, { error: { code: 'UNAUTHENTICATED' } });
        return json(res, 200, { user: { id: 'u-a-han' }, csrfToken: 'csrf', policy: { confirmTailLength: 6 } });
      }
      if (req.method === 'POST' && url.pathname === '/api/addresses/check') {
        const ok = /^MOCK-EVM-[0-9A-Fa-f]{40}$/.test(body?.address ?? '');
        return json(res, 200, { findings: ok ? [] : [{ code: 'ADDRESS_NETWORK_MISMATCH', level: 'error', message: '형식 아님' }] });
      }
      if (req.method === 'POST' && url.pathname === '/api/addresses' && mode.register) {
        const r = mode.register(body);
        return json(res, r.status, r.code ? { error: { code: r.code, message: r.code } } : { address: { id: 'x' } });
      }
      return json(res, 404, { error: { code: 'NOT_FOUND' } });
    });
  });
}

/** 실제 서버(shared/schemas.ts·createAddress)와 같은 순서: 본문 형식 → 주소 규칙 → 끝자리 */
const realisticRegister = (body: any) => {
  const complete = ['label', 'counterparty', 'confirmTail', 'confirmMiddle', 'receivedVia', 'verifiedVia', 'verifiedWith'].every((k) => typeof body?.[k] === 'string' && body[k].trim())
    && body.ackNotVerified === true && body.ackOutOfBandConfirmed === true;
  if (!complete) return { status: 422, code: 'VALIDATION' };
  if (!/^MOCK-EVM-[0-9A-Fa-f]{40}$/.test(body.address)) return { status: 422, code: 'ADDRESS_NETWORK_MISMATCH' };
  if (body.confirmTail.toUpperCase() !== body.address.slice(-6).toUpperCase()) return { status: 422, code: 'CONFIRM_TAIL_MISMATCH' };
  return { status: 201 };
};

let server: http.Server | null = null;
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

async function runSmoke(mode: Mode, extraArgs: string[] = []): Promise<{ code: number | null; out: string }> {
  server = standIn(mode);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const env = { ...process.env };
  delete env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, `http://127.0.0.1:${port}`, ...extraArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const line = (out: string, prefix: string) => out.split('\n').find((l) => l.startsWith(prefix));

describe('smoke-deploy --public: 보호 없음은 통과가 아니다', () => {
  it('보호 없이 200이면 WARN으로 남기고 통과로 세지 않으며, 요약에 경고 수를 따로 적는다', async () => {
    const { out } = await runSmoke({}, ['--public']);
    expect(out).toMatch(/^WARN {2}배포 보호 없음\(--public\)/m);
    expect(out).not.toMatch(/^PASS {2}배포 보호/m);
    const summary = out.split('\n').find((l) => /개 검사: /.test(l));
    expect(summary).toMatch(/경고 1,/);
    // 통과 수에 보호 검사가 들지 않는다: PASS 줄 수와 요약의 통과 수가 같다
    const passLines = out.split('\n').filter((l) => l.startsWith('PASS  ')).length;
    expect(summary).toContain(`통과 ${passLines},`);
    expect(out).toMatch(/^경고 항목: 배포 보호 없음\(--public\)/m);
  });

  it('--public 없이 보호 없는 주소면 실패로 즉시 멈춘다(종료 코드 1)', async () => {
    const { code, out } = await runSmoke({});
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL {2}배포 보호 켜짐 — 우회 헤더 없이 200/m);
    expect(out).not.toMatch(/^PASS {2}배포 보호/m);
  });
});

describe("smoke-deploy 'MOCK- 형식이 아닌 주소 거부'는 주소 규칙으로 거부될 때만 통과한다", () => {
  const MOCK_CHECK = /^(PASS|FAIL) {2}MOCK- 형식이 아닌 주소 거부/m;

  it('서버가 주소 규칙대로 거부하면 통과(대조: 올바른 MOCK 주소는 끝자리 불일치에서 거부)', async () => {
    const { out } = await runSmoke({ register: realisticRegister }, ['--public']);
    expect(out.match(MOCK_CHECK)?.[1], out).toBe('PASS');
    expect(line(out, 'PASS  MOCK-')).toContain('등록 ADDRESS_NETWORK_MISMATCH, 대조 CONFIRM_TAIL_MISMATCH');
  });

  it('등록이 본문 형식 오류(VALIDATION)로만 거부되면 실패', async () => {
    const { out } = await runSmoke({ register: () => ({ status: 422, code: 'VALIDATION' }) }, ['--public']);
    expect(out.match(MOCK_CHECK)?.[1], out).toBe('FAIL');
  });

  it('등록에서 주소 규칙이 빠져 0x 주소가 끝자리 단계까지 가면 실패', async () => {
    const noRule = (body: any) => {
      const r = realisticRegister(body);
      return r.code === 'ADDRESS_NETWORK_MISMATCH' ? (body.confirmTail === body.address.slice(-6) ? { status: 201 } : { status: 422, code: 'CONFIRM_TAIL_MISMATCH' }) : r;
    };
    const { out } = await runSmoke({ register: noRule }, ['--public']);
    expect(out.match(MOCK_CHECK)?.[1], out).toBe('FAIL');
  });
});
