import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../server/config.ts';
import { migrate, openDb, type DB } from '../server/db.ts';
import { buildApp } from '../server/app.ts';
import { MockCustodyAdapter } from '../server/adapters/custody.ts';
import { seed } from '../server/seed.ts';

export interface TestCtx { app: FastifyInstance; db: DB; custody: MockCustodyAdapter }

export async function makeApp(opts: { processingMs?: number; rateLimitMax?: number } = {}): Promise<TestCtx> {
  const cfg = loadConfig({ dbPath: ':memory:', logLevel: 'silent', serveClient: false, rateLimitMax: opts.rateLimitMax ?? 10000 });
  cfg.policy.mockCustodyProcessingMs = opts.processingMs ?? 0;
  const db = openDb(':memory:');
  migrate(db);
  seed(db);
  const custody = new MockCustodyAdapter(cfg.policy.mockCustodyProcessingMs);
  const app = await buildApp({ cfg, db, custody });
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
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) => {
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
  };
}

export const key = () => `test-${Math.random().toString(36).slice(2)}${Date.now()}`;