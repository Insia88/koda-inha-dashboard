import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.ts';
import { now } from './db.ts';
import { Errors } from './errors.ts';
import { permissionsFor, type Permission } from './authz.ts';
import type { Role } from '../shared/terms.ts';

export const SESSION_COOKIE = 'koda_sid';

export interface AuthContext {
  sessionHash: string;
  csrf: string;
  user: { id: string; name: string; email: string; title: string };
  org: { id: string; name: string; kind: 'customer' | 'operator'; isMock: boolean };
  roles: Role[];
  perms: Set<Permission>;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function createSession(db: DB, userId: string, ttlMinutes: number) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare('INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha(token), userId, csrf, now(), expires);
  return { token, csrf, expires };
}

export function revokeSession(db: DB, sessionHash: string) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL').run(now(), sessionHash);
}

export function loadAuth(db: DB, token: string | undefined): AuthContext | null {
  if (!token || token.length > 200) return null;
  const h = sha(token);
  const row = db
    .prepare(
      `SELECT s.id_hash, s.csrf_token, s.expires_at, s.revoked_at, u.id uid, u.name uname, u.email, u.title, u.is_active,
              o.id oid, o.name oname, o.kind, o.is_mock
         FROM sessions s JOIN users u ON u.id = s.user_id JOIN organizations o ON o.id = u.org_id
        WHERE s.id_hash = ?`,
    )
    .get(h) as any;
  if (!row || row.revoked_at || row.expires_at < now() || !row.is_active) return null;
  // 역할은 매 요청마다 저장소에서 다시 읽어 권한 변경이 즉시 반영되도록 한다.
  const roles = (db.prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role').all(row.uid) as { role: Role }[]).map((r) => r.role);
  return {
    sessionHash: h,
    csrf: row.csrf_token,
    user: { id: row.uid, name: row.uname, email: row.email, title: row.title },
    org: { id: row.oid, name: row.oname, kind: row.kind, isMock: !!row.is_mock },
    roles,
    perms: permissionsFor(roles),
  };
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw Errors.unauthenticated();
  return req.auth;
}

export function requirePerm(req: FastifyRequest, perm: Permission, what?: string): AuthContext {
  const a = requireAuth(req);
  if (!a.perms.has(perm)) throw Errors.forbidden(what);
  return a;
}

export function checkCsrf(req: FastifyRequest) {
  const a = req.auth;
  if (!a) return;
  const sent = req.headers['x-csrf-token'];
  if (typeof sent !== 'string') throw Errors.csrf();
  const x = Buffer.from(sent);
  const y = Buffer.from(a.csrf);
  if (x.length !== y.length || !timingSafeEqual(x, y)) throw Errors.csrf();
}

export function setSessionCookie(reply: FastifyReply, token: string, expires: string, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure, path: '/', expires: new Date(expires) });
}
