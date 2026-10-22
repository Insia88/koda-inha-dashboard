import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.ts';
import { now } from './db.ts';
import { Errors } from './errors.ts';
import { permissionsFor, type Permission } from './authz.ts';
import type { SessionSecret } from './config.ts';
import type { Role } from '../shared/terms.ts';

export const SESSION_COOKIE = 'koda_sid';

/** db: 저장소 세션(로컬, 서버에서 폐기 가능). stateless: 서명된 쿠키(공개 데모, 만료 시각까지 유효). */
export type SessionKind = 'db' | 'stateless';

export interface AuthContext {
  sessionKind: SessionKind;
  /** 저장소 세션 행의 키(sha256). 무상태 세션은 저장소 행이 없으므로 폐기에 쓰이지 않는다. */
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
    sessionKind: 'db',
    sessionHash: h,
    csrf: row.csrf_token,
    user: { id: row.uid, name: row.uname, email: row.email, title: row.title },
    org: { id: row.oid, name: row.oname, kind: row.kind, isMock: !!row.is_mock },
    roles,
    perms: permissionsFor(roles),
  };
}

// ---------- 공개 데모 무상태 세션 ----------
// Vercel은 다음 요청을 다른 함수 인스턴스로 보낼 수 있고, 인스턴스마다 메모리 DB가 따로라 저장소 세션은 그 인스턴스에서만 보인다.
// 그래서 공개 데모는 세션 내용을 쿠키에 담고 DEMO_SESSION_SECRET으로 서명한다. 어느 인스턴스든 같은 키로 서명과 만료를 확인하고,
// 사용자·역할은 매 요청 그 인스턴스 DB에서 다시 읽는다(모의 사용자는 모든 인스턴스에 같은 값으로 만들어진다).
// 쿠키 값: base64url(payload JSON) + '.' + base64url(HMAC-SHA256(secret, payload 부분))
// 한계: 서버에 상태가 없어 만료 전에 서버에서 폐기할 수 없다. 로그아웃은 브라우저 쿠키만 지운다. 만료(기본 120분)를 짧게 두고,
// 모든 세션을 끊어야 하면 DEMO_SESSION_SECRET을 새 값으로 바꿔 다시 배포한다(docs/deploy-vercel.md).

export const DEMO_SESSION_VERSION = 1;
export interface DemoSessionPayload { v: 1; sid: string; uid: string; org: string; iat: number; exp: number }

const B64URL = /^[A-Za-z0-9_-]+$/;
const SID = /^[0-9a-f]{32}$/;
/** 쿠키 값 상한. 정상 값은 200자 안팎이다. */
const MAX_STATELESS_TOKEN = 512;
/** 인스턴스 사이 시계 차이로 발급 시각이 조금 앞서 보이는 것만 허용한다(초). */
const CLOCK_SKEW_SEC = 60;
const MAX_ID = 64;

/** 같은 바이트를 같은 문자열로만 받는다(느슨한 base64 해석으로 여러 표기가 같은 값이 되는 것을 막는다). */
function decodeB64url(part: string): Buffer | null {
  if (!B64URL.test(part)) return null;
  const buf = Buffer.from(part, 'base64url');
  return buf.toString('base64url') === part ? buf : null;
}

/** CSRF 값도 sid에서 계산하므로 어느 인스턴스든 같은 값을 확인할 수 있다. */
export function demoCsrfToken(secret: SessionSecret, sid: string) {
  return secret.hmac(`csrf:${sid}`).toString('base64url');
}

export function signDemoSession(secret: SessionSecret, payload: DemoSessionPayload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${secret.hmac(body).toString('base64url')}`;
}

/** 서명·형식·버전·만료를 확인한다. 하나라도 맞지 않으면 null(이유를 구분해 알리지 않는다). */
export function verifyDemoSession(secret: SessionSecret, token: string | undefined, ttlMinutes: number, nowMs = Date.now()): DemoSessionPayload | null {
  if (!token || token.length > MAX_STATELESS_TOKEN) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const bodyBytes = decodeB64url(body);
  const sig = decodeB64url(token.slice(dot + 1));
  if (!bodyBytes || !sig) return null;
  const expected = secret.hmac(body);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  let p: any;
  try { p = JSON.parse(bodyBytes.toString('utf8')); } catch { return null; }
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.v !== DEMO_SESSION_VERSION) return null;
  if (typeof p.sid !== 'string' || !SID.test(p.sid)) return null;
  for (const k of ['uid', 'org'] as const) if (typeof p[k] !== 'string' || !p[k] || p[k].length > MAX_ID) return null;
  if (!Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)) return null;
  const nowSec = Math.floor(nowMs / 1000);
  if (p.exp <= nowSec || p.iat > nowSec + CLOCK_SKEW_SEC) return null;
  // 지금 설정된 만료보다 긴 세션은 받지 않는다(만료를 줄여 다시 배포하면 바로 적용된다).
  if (p.exp - p.iat > Math.round(ttlMinutes * 60)) return null;
  return { v: DEMO_SESSION_VERSION, sid: p.sid, uid: p.uid, org: p.org, iat: p.iat, exp: p.exp };
}

/** 무상태 세션: 사용자는 매 요청 이 인스턴스 DB에서 다시 읽는다. 없거나 비활성이거나 조직이 다르면 null. */
function loadStatelessAuth(db: DB, secret: SessionSecret, payload: DemoSessionPayload): AuthContext | null {
  const row = db
    .prepare(
      `SELECT u.id uid, u.name uname, u.email, u.title, u.is_active, o.id oid, o.name oname, o.kind, o.is_mock
         FROM users u JOIN organizations o ON o.id = u.org_id
        WHERE u.id = ?`,
    )
    .get(payload.uid) as any;
  if (!row || !row.is_active || row.oid !== payload.org) return null;
  const roles = (db.prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role').all(row.uid) as { role: Role }[]).map((r) => r.role);
  return {
    sessionKind: 'stateless',
    sessionHash: sha(`stateless:${payload.sid}`),
    csrf: demoCsrfToken(secret, payload.sid),
    user: { id: row.uid, name: row.uname, email: row.email, title: row.title },
    org: { id: row.oid, name: row.oname, kind: row.kind, isMock: !!row.is_mock },
    roles,
    perms: permissionsFor(roles),
  };
}

/** 세션 발급·확인·종료. 로컬은 저장소 세션, 공개 데모는 서명된 쿠키를 쓴다. */
export interface SessionStore {
  readonly kind: SessionKind;
  issue(user: { id: string; orgId: string }): { token: string; expires: string };
  load(token: string | undefined): AuthContext | null;
  /** 로그아웃·재로그인 때 이전 세션을 끝낸다. 무상태 세션은 서버에서 폐기할 수 없어 아무것도 하지 않는다(쿠키 삭제만 가능). */
  end(auth: AuthContext): void;
}

export function dbSessionStore(db: DB, ttlMinutes: number): SessionStore {
  return {
    kind: 'db',
    issue: (u) => { const s = createSession(db, u.id, ttlMinutes); return { token: s.token, expires: s.expires }; },
    load: (token) => loadAuth(db, token),
    end: (a) => revokeSession(db, a.sessionHash),
  };
}

export function statelessSessionStore(db: DB, secret: SessionSecret, ttlMinutes: number, clock: () => number = Date.now): SessionStore {
  const ttlSec = Math.round(ttlMinutes * 60);
  return {
    kind: 'stateless',
    issue: (u) => {
      const iat = Math.floor(clock() / 1000);
      const payload: DemoSessionPayload = { v: DEMO_SESSION_VERSION, sid: randomBytes(16).toString('hex'), uid: u.id, org: u.orgId, iat, exp: iat + ttlSec };
      return { token: signDemoSession(secret, payload), expires: new Date(payload.exp * 1000).toISOString() };
    },
    load: (token) => {
      const p = verifyDemoSession(secret, token, ttlMinutes, clock());
      return p ? loadStatelessAuth(db, secret, p) : null;
    },
    end: () => undefined,
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

/** 세션 쿠키를 지운다. 발급 때와 같은 속성(Path=/, HttpOnly, SameSite=Strict, Secure)으로 보낸다. */
export function clearSessionCookie(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure, path: '/' });
}
