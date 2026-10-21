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

/**
 * 서버가 알려 주는 실행 형태(/api/healthz, /api/me environment). 화면은 mode로 공개 데모의 맨 아래 한 줄·인스턴스 안내를 정한다.
 * instanceId·seededAt는 화면에 보이지 않는다(A5부터. 그 전에는 공개 데모 상단 띠가 데이터 생성 시각을 보였다). 인스턴스 비교는 X-Demo-Instance 헤더로 한다.
 */
export interface DeploymentInfo { mode?: 'local' | 'public-demo'; instanceId?: string; seededAt?: string | null }
export interface HealthInfo extends DeploymentInfo { ok: boolean; env: string; authMode: string; custody: string }

/**
 * 공개 데모에서 이 탭이 처음 보는 서버 인스턴스가 응답하면(다른 함수 인스턴스·재시작) 발생한다. detail: { previous, current }
 * 로그인은 서명된 쿠키라 그대로 유지되므로 로그아웃하지 않는다. 데이터(요청·주소 등)는 인스턴스마다 따로라 안내만 한다.
 * 이미 본 인스턴스로 돌아가는 것은 다시 알리지 않는다(여러 인스턴스가 번갈아 응답해도 안내가 계속 뜨지 않게).
 */
export const DEMO_INSTANCE_CHANGED = 'koda:demo-instance-changed';
let demoInstance: string | null = null;
const seenDemoInstances = new Set<string>();
// 공개 데모: 이 탭에서 쓰기(비 GET)를 하기 전에는 인스턴스 전환 안내를 띄우지 않는다.
// 둘러보기만 할 때는 데이터가 달라도 화면이 같아서 안내가 오히려 시연을 방해한다(데이터 일관성 위험은 쓰기 뒤에만 알린다).
let hasWrittenInTab = false;
let demoSwitchPending = false;
function trackDemoInstance(res: Response) {
  // A8: 공유 상태(Blob)가 켜진 공개 데모는 인스턴스가 바뀌어도 데이터가 같으므로 전환 안내를 띄우지 않는다.
  if (res.headers.get('X-Demo-Shared') === '1') return;
  const id = res.headers.get('X-Demo-Instance');
  if (!id) return;
  const previous = demoInstance;
  const isNew = !seenDemoInstances.has(id);
  demoInstance = id;
  seenDemoInstances.add(id);
  if (previous && previous !== id && isNew && hasWrittenInTab) {
    demoSwitchPending = true;
    window.dispatchEvent(new CustomEvent(DEMO_INSTANCE_CHANGED, { detail: { previous, current: id } }));
  }
}
/**
 * 이 탭이 공개 데모 서버의 응답을 한 번이라도 받았는지(X-Demo-Instance 헤더는 공개 데모에서만 붙는다, server/app.ts).
 * 셸·로그인 화면 밖의 단독 화면(로그인 상태 확인 중·오류 대체 화면)이 실행 형태를 따로 묻지 않고 맨 아래 한 줄을 그릴지 정할 때 쓴다(A5).
 */
export function hasSeenDemoServer() { return demoInstance !== null; }
/** 아직 닫지 않은 '다른 데모 서버로 연결됨' 안내가 있는지. */
export function isDemoSwitchPending() { return demoSwitchPending; }
export function acknowledgeDemoSwitch() { demoSwitchPending = false; }

export function newIdemKey() {
  return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * raw: JSON 대신 그대로 보낼 본문(지급 근거 파일, application/octet-stream). headers: 추가 머리글(예: X-Attachment-Name).
 * 변경 요청에는 늘 X-CSRF-Token을 붙인다.
 */
type Opts = { method?: string; body?: unknown; raw?: Blob; headers?: Record<string, string>; idempotencyKey?: string; signal?: AbortSignal };

const NETWORK_ERROR: ApiErrorBody = { code: 'NETWORK', message: '서버에 연결하지 못했습니다.', action: '네트워크 연결을 확인한 뒤 다시 시도하세요. 입력한 내용은 화면에 남아 있습니다.' };

/** 응답 본문(JSON 오류 형식)을 ApiError로 바꾼다. 로그인이 끊겼으면(401) 화면에 알린다. */
function toApiError(url: string, status: number, data: any): ApiError {
  const body: ApiErrorBody = data?.error ?? { code: 'HTTP_' + status, message: '요청을 처리하지 못했습니다.', action: '잠시 후 다시 시도하세요.' };
  if (status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('koda:unauthenticated'));
  return new ApiError(status, body, data?.requestId);
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, credentials: 'same-origin' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, NETWORK_ERROR);
  }
}

export async function api<T = any>(url: string, opts: Opts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (opts.raw !== undefined) headers['Content-Type'] = 'application/octet-stream';
  else if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.method && opts.method !== 'GET') { headers['X-CSRF-Token'] = csrfToken; hasWrittenInTab = true; }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await send(url, { method: opts.method ?? 'GET', headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined), signal: opts.signal });
  trackDemoInstance(res);
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw toApiError(url, res.status, data);
  return data as T;
}

/**
 * 지급 근거 파일 하나 올리기(A2b). 파일 바이트를 그대로 보내고 이름은 X-Attachment-Name(encodeURIComponent) 머리글로 보낸다.
 * 형식은 서버가 내용으로 다시 판정한다. 응답은 요청 상세와 같은 모양이다.
 */
export function uploadAttachment<T = any>(requestId: string, file: File): Promise<T> {
  return api<T>(`/api/requests/${encodeURIComponent(requestId)}/attachments`, { method: 'POST', raw: file, headers: { 'X-Attachment-Name': encodeURIComponent(file.name) } });
}

/**
 * 로그인한 같은 조직 사용자만 받을 수 있는 파일을 내려받는다. 실패하면 서버의 오류 문구를 ApiError로 던져 화면에 그대로 보이게 한다
 * (오류 JSON을 새 탭에 띄우지 않는다). 받은 내용은 임시 blob 주소로 저장하고 바로 놓는다. 파일 이름은 서버가 정리한 이름이다.
 */
export async function downloadFile(url: string, fileName: string): Promise<void> {
  const res = await send(url, { method: 'GET' });
  trackDemoInstance(res);
  if (!res.ok) {
    let data: any = null;
    try { data = await res.json(); } catch { data = null; }
    throw toApiError(url, res.status, data);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}