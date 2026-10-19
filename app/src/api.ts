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

/** 서버가 알려 주는 실행 형태(/api/healthz, /api/me environment). 공개 데모에서만 seededAt·instanceId가 화면에 쓰인다. */
export interface DeploymentInfo { mode?: 'local' | 'public-demo'; instanceId?: string; seededAt?: string | null }
export interface HealthInfo extends DeploymentInfo { ok: boolean; env: string; authMode: string; custody: string }

/** 공개 데모 서버 인스턴스가 바뀌면(재시작·다른 인스턴스) 발생한다. detail: { previous, current } */
export const DEMO_INSTANCE_CHANGED = 'koda:demo-instance-changed';
let demoInstance: string | null = null;
let demoResetPending = false;
function trackDemoInstance(res: Response) {
  const id = res.headers.get('X-Demo-Instance');
  if (!id) return;
  const previous = demoInstance;
  demoInstance = id;
  if (previous && previous !== id) {
    demoResetPending = true;
    window.dispatchEvent(new CustomEvent(DEMO_INSTANCE_CHANGED, { detail: { previous, current: id } }));
  }
}
/** 마지막으로 확인하지 않은 데모 데이터 초기화가 있는지(로그인 화면 안내용). */
export function isDemoResetPending() { return demoResetPending; }
export function acknowledgeDemoReset() { demoResetPending = false; }

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
  trackDemoInstance(res);
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