import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import { now } from '../db.ts';
import { AppError } from '../errors.ts';

export function readIdemKey(header: unknown, required: boolean): string | null {
  if (header === undefined || header === '') {
    if (required) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', '중복 제출 방지 값이 없어 처리하지 않았습니다.', '페이지를 새로 고친 뒤 다시 시도하세요.');
    return null;
  }
  if (typeof header !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(header)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', '중복 제출 방지 값의 형식이 올바르지 않습니다.', '페이지를 새로 고친 뒤 다시 시도하세요.');
  }
  return header;
}

/**
 * 같은 사용자·경로·키로 다시 들어온 요청은 처음 결과를 그대로 돌려준다.
 * 같은 키에 다른 내용이 오면 거부한다. 호출 측 트랜잭션 안에서 사용한다.
 */
export function withIdempotency<T>(
  db: DB,
  userId: string,
  route: string,
  key: string | null,
  body: unknown,
  fn: () => { status: number; body: T },
): { status: number; body: T; replayed: boolean } {
  if (!key) return { ...fn(), replayed: false };
  const hash = createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
  const prev = db.prepare('SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE user_id = ? AND route = ? AND key = ?').get(userId, route, key) as any;
  if (prev) {
    if (prev.request_hash !== hash) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', '같은 제출 번호로 다른 내용이 전송되었습니다.', '새로 작성한 내용이라면 화면을 새로 고친 뒤 다시 제출하세요.');
    }
    return { status: prev.status_code, body: JSON.parse(prev.response_body), replayed: true };
  }
  const out = fn();
  db.prepare('INSERT INTO idempotency_keys (user_id, route, key, request_hash, status_code, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(userId, route, key, hash, out.status, JSON.stringify(out.body), now());
  return { ...out, replayed: false };
}
