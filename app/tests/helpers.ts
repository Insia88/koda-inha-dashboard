import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../server/config.ts';
import { migrate, openDb, type DB } from '../server/db.ts';
import { buildApp } from '../server/app.ts';
import { MockCustodyAdapter } from '../server/adapters/custody.ts';
import { seed } from '../server/seed.ts';

export interface TestCtx { app: FastifyInstance; db: DB; custody: MockCustodyAdapter }

/**
 * cooldownHours: 주소 확인 뒤 사용 대기 시간. 기존 흐름(확인 즉시 사용 가능)을 그대로 검사하도록 기본 0으로 둔다.
 * 사용 대기를 검사할 때만 값을 준다(tests/address-lifecycle.test.ts).
 * config: 그 밖의 설정 덮어쓰기(예: 지급 근거 올리기 끄기·업로드 한도, tests/attachments.test.ts).
 * logStream: 로그를 받아 볼 곳(config.logLevel을 'silent' 밖으로 줄 때만 쓰인다, tests/attachments.test.ts '로그').
 */
export async function makeApp(opts: { processingMs?: number; rateLimitMax?: number; loginRateLimitMax?: number; holdingRelated?: boolean; cooldownHours?: number; config?: Partial<AppConfig>; logStream?: { write(msg: string): void } } = {}): Promise<TestCtx> {
  const cfg = loadConfig({ dbPath: ':memory:', logLevel: 'silent', serveClient: false, rateLimitMax: opts.rateLimitMax ?? 10000, attachmentUploadRateLimitMax: 10000, ...(opts.loginRateLimitMax ? { loginRateLimitMax: opts.loginRateLimitMax } : {}), ...opts.config });
  cfg.policy.mockCustodyProcessingMs = opts.processingMs ?? 0;
  cfg.policy.addressBook.cooldownHours = opts.cooldownHours ?? 0;
  cfg.insightPolicy.experiments.holdingRelatedFilter = opts.holdingRelated ?? false;
  const db = openDb(':memory:');
  migrate(db);
  seed(db);
  const custody = new MockCustodyAdapter(cfg.policy.mockCustodyProcessingMs);
  const app = await buildApp({ cfg, db, custody, logStream: opts.logStream });
  return { app, db, custody };
}

export interface Session { cookie: string; csrf: string; userId: string }

export async function login(app: FastifyInstance, userId: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { userId } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  const raw = res.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { cookie, csrf: me.json().csrfToken, userId };
}

export function api(app: FastifyInstance, s: Session | null) {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...headers };
    if (s) { h.cookie = s.cookie; h['x-csrf-token'] = s.csrf; }
    const res = await app.inject({ method, url, payload: payload as any, headers: h });
    let body: any = null;
    try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body, headers: res.headers };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown, headers?: Record<string, string>) => call('POST', url, payload ?? {}, headers),
    put: (url: string, payload?: unknown) => call('PUT', url, payload ?? {}),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload ?? {}),
    del: (url: string, headers?: Record<string, string>) => call('DELETE', url, undefined, headers),
  };
}

/**
 * 지급 근거 파일 올리기(A2b): 원본 바이트 본문(application/octet-stream) + X-Attachment-Name(encodeURIComponent).
 * name이 null이면 이름 머리글을 보내지 않는다. headers의 값이 null이면 그 머리글을 빼고(예: CSRF 없이), 문자열이면 덮어쓴다.
 */
export async function upload(app: FastifyInstance, s: Session | null, id: string, bytes: Buffer, name: string | null = 'evidence.pdf', headers: Record<string, string | null> = {}) {
  const h: Record<string, string> = { 'content-type': 'application/octet-stream' };
  if (name !== null) h['x-attachment-name'] = encodeURIComponent(name);
  if (s) { h.cookie = s.cookie; h['x-csrf-token'] = s.csrf; }
  for (const [k, v] of Object.entries(headers)) { if (v === null) delete h[k]; else h[k] = v; }
  const res = await app.inject({ method: 'POST', url: `/api/requests/${id}/attachments`, payload: bytes, headers: h });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body, headers: res.headers };
}

export const key = () => `test-${Math.random().toString(36).slice(2)}${Date.now()}`;
/** 큰따옴표로 감싼 셀과 셀 안의 쉼표·줄바꿈을 처리하는 작은 CSV 읽기(테스트용). 줄바꿈은 CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * 감사 기록 CSV(A2-4)를 표지·머리글·행으로 나눈다. 프로그램으로 읽는 규칙(docs/api.md)과 같다:
 * BOM 다음 표지 행들, 빈 줄 하나, 그다음 '순번'으로 시작하는 첫 줄이 머리글이다.
 */
export function splitAuditCsv(body: string): { cover: string[][]; header: string[]; rows: string[][] } {
  if (!body.startsWith('﻿')) throw new Error('CSV에 BOM이 없습니다');
  const all = parseCsv(body.slice(1));
  const blank = all.findIndex((r) => r.length === 1 && r[0] === '');
  if (blank < 0 || all[blank + 1]?.[0] !== '순번') throw new Error('표지 다음 빈 줄과 순번 머리글을 찾지 못했습니다');
  return { cover: all.slice(0, blank), header: all[blank + 1]!, rows: all.slice(blank + 2) };
}
