export interface ApiErrorBody { code: string; message: string; action?: string; fields?: { field: string; message: string }[]; findings?: any[]; [k: string]: unknown }

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody, public requestId?: string) {
    super(body.message);
  }
  get code() { return this.body.code; }
  fieldError(name: string) { return this.body.fields?.find((f) => f.field === name)?.message; }
}

let csrfToken = '';
export function setCsrf(t: string) { csrfToken = t; }

export function newIdemKey() {
  return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
}

type Opts = { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal };

export async function api<T = any>(url: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.method && opts.method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin', signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, { code: 'NETWORK', message: '서버에 연결하지 못했습니다.', action: '네트워크 연결을 확인한 뒤 다시 시도하세요. 입력한 내용은 화면에 남아 있습니다.' });
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const body: ApiErrorBody = data?.error ?? { code: 'HTTP_' + res.status, message: '요청을 처리하지 못했습니다.', action: '잠시 후 다시 시도하세요.' };
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('koda:unauthenticated'));
    throw new ApiError(res.status, body, data?.requestId);
  }
  return data as T;
}