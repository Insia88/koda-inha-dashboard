import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(APP_ROOT, rel), 'utf8')) as T;
}

export interface Policy {
  approval: { defaultRequiredApprovals: number; highValueThresholdKrw: string; highValueRequiredApprovals: number };
  /** cooldownHours: 두 번째 사람이 확인한 주소를 출금에 쓰기까지 기다리는 시간(설계 가정, 0이면 바로 사용) */
  addressBook: { requireSecondPersonReview: boolean; confirmTailLength: number; cooldownHours: number };
  priceStaleAfterMinutes: number;
  mockCustodyProcessingMs: number;
}
export interface InsightPolicy {
  disclosure: string;
  listBatchSize: number;
  newBadgeDays: number;
  requireWhitelistedProvider: boolean;
  experiments: { holdingRelatedFilter: boolean };
}

/**
 * local: 개발자 PC에서 실행(기본). public-demo: DEMO_PUBLIC=1을 명시한 보호된 공개 데모(Vercel 등).
 * 공개 데모도 개발용 로그인·모의 데이터·모의 커스터디로만 동작한다(docs/deploy-vercel.md).
 */
export type Deployment = 'local' | 'public-demo';

export interface AppConfig {
  nodeEnv: string;
  host: string;
  port: number;
  dbPath: string;
  authMode: 'dev';
  sessionTtlMinutes: number;
  policy: Policy;
  insightPolicy: InsightPolicy;
  serveClient: boolean;
  logLevel: string;
  rateLimitMax: number;
  /** 개발용 로그인 1분당 허용 횟수(IP 기준) */
  loginRateLimitMax: number;
  deployment: Deployment;
  /** 프록시가 덮어쓴 X-Forwarded-For를 접속 IP로 쓴다. 공개 데모에서만 켠다(로컬에서 켜면 IP를 위조할 수 있다). */
  trustProxy: boolean;
  /** 세션 쿠키 Secure 속성(HTTPS 전용). */
  cookieSecure: boolean;
  /** 상주 타이머 대신 /api 요청 때 모의 커스터디 정산·시세 기준 시각 갱신을 1초에 한 번까지 실행한다. */
  lazyTicks: boolean;
  /** 모의 시세 기준 시각 갱신 여부(MOCK_PRICE_FEED=off 이면 멈춰 '시세 지연' 상태를 확인할 수 있다). */
  mockPriceFeed: boolean;
  /** 공개 데모에서 인스턴스당 사용자가 새로 만들 수 있는 주소·출금 요청·인사이트 건수(종류별). 로컬에서는 적용하지 않는다. */
  demoCreateLimit: number;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(?:\.\d{1,3}){3})$/i;
export const isLoopbackHost = (host: string) => LOOPBACK.test(host.trim());

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env;
  const nodeEnv = env.NODE_ENV ?? 'development';
  const authMode = env.AUTH_MODE ?? 'dev';
  if (authMode !== 'dev') {
    throw new Error(`AUTH_MODE=${authMode} 은(는) 아직 구현되지 않았습니다. 운영 SSO 어댑터가 필요합니다 (docs/operations.md).`);
  }
  // 안전 잠금: 호스팅 런타임(VERCEL=1 또는 NODE_ENV=production)에서는 개발용 로그인으로 기동하지 않는다.
  // 보호된 공개 데모로만 예외를 두며, 그 예외는 DEMO_PUBLIC=1을 명시해야 열린다.
  const hosted = env.VERCEL === '1' || nodeEnv === 'production';
  const demo = env.DEMO_PUBLIC === '1';
  if (hosted && !demo) {
    throw new Error(
      `호스팅 환경(${env.VERCEL === '1' ? 'VERCEL=1' : 'NODE_ENV=production'})에서는 개발용 로그인(AUTH_MODE=dev)으로 기동하지 않습니다. ` +
        '모의 데이터 공개 데모로만 실행하려면 프로젝트 환경변수에 DEMO_PUBLIC=1을 명시하세요 (docs/deploy-vercel.md).',
    );
  }
  const deployment: Deployment = demo ? 'public-demo' : 'local';
  const host = env.HOST ?? '127.0.0.1';
  // 로컬 실행에서 127.0.0.1 이외 주소로 열면 같은 네트워크의 누구나 비밀번호 없이 로그인할 수 있다.
  if (!hosted && !isLoopbackHost(host) && env.DEV_ALLOW_LAN !== '1') {
    throw new Error(
      `HOST=${host} 은(는) 이 컴퓨터 밖에서 접속할 수 있는 주소라 개발용 로그인으로 열지 않습니다. ` +
        '127.0.0.1로 실행하세요. 같은 네트워크에서 꼭 확인해야 한다면 DEV_ALLOW_LAN=1을 함께 지정하세요.',
    );
  }
  const rawDbPath = env.DB_PATH ?? './data/koda-dev.sqlite';
  const policy = readJson<Policy>('config/policy.json');
  if (env.MOCK_CUSTODY_PROCESSING_MS) policy.mockCustodyProcessingMs = Number(env.MOCK_CUSTODY_PROCESSING_MS);
  if (env.ADDRESS_COOLDOWN_HOURS !== undefined && env.ADDRESS_COOLDOWN_HOURS !== '') policy.addressBook.cooldownHours = Number(env.ADDRESS_COOLDOWN_HOURS);
  return {
    nodeEnv,
    host,
    port: Number(env.PORT ?? 4300),
    // 공개 데모는 읽기 전용 파일 시스템에서 돌기 때문에 항상 인스턴스 메모리 DB를 쓴다.
    dbPath: demo || rawDbPath === ':memory:' ? ':memory:' : path.resolve(APP_ROOT, rawDbPath),
    authMode: 'dev',
    sessionTtlMinutes: Number(env.SESSION_TTL_MINUTES ?? (demo ? 120 : 480)),
    policy,
    insightPolicy: readJson<InsightPolicy>('config/insight-policy.json'),
    serveClient: !demo,
    logLevel: env.LOG_LEVEL ?? 'info',
    rateLimitMax: Number(env.RATE_LIMIT_MAX ?? 600),
    loginRateLimitMax: Number(env.LOGIN_RATE_LIMIT_MAX ?? 30),
    deployment,
    trustProxy: demo,
    cookieSecure: demo,
    lazyTicks: demo,
    mockPriceFeed: env.MOCK_PRICE_FEED !== 'off',
    demoCreateLimit: 200,
    ...overrides,
  };
}
