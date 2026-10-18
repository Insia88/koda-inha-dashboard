import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(APP_ROOT, rel), 'utf8')) as T;
}

export interface Policy {
  approval: { defaultRequiredApprovals: number; highValueThresholdKrw: string; highValueRequiredApprovals: number };
  addressBook: { requireSecondPersonReview: boolean; confirmTailLength: number };
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
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env;
  const nodeEnv = env.NODE_ENV ?? 'development';
  const authMode = env.AUTH_MODE ?? 'dev';
  if (authMode !== 'dev') {
    throw new Error(`AUTH_MODE=${authMode} 은(는) 아직 구현되지 않았습니다. 운영 SSO 어댑터가 필요합니다 (docs/operations.md).`);
  }
  if (nodeEnv === 'production') {
    throw new Error('NODE_ENV=production 에서는 개발용 로그인(AUTH_MODE=dev)을 사용할 수 없습니다.');
  }
  const policy = readJson<Policy>('config/policy.json');
  if (env.MOCK_CUSTODY_PROCESSING_MS) policy.mockCustodyProcessingMs = Number(env.MOCK_CUSTODY_PROCESSING_MS);
  return {
    nodeEnv,
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 4300),
    dbPath: path.resolve(APP_ROOT, env.DB_PATH ?? './data/koda-dev.sqlite'),
    authMode: 'dev',
    sessionTtlMinutes: Number(env.SESSION_TTL_MINUTES ?? 480),
    policy,
    insightPolicy: readJson<InsightPolicy>('config/insight-policy.json'),
    serveClient: true,
    logLevel: env.LOG_LEVEL ?? 'info',
    rateLimitMax: Number(env.RATE_LIMIT_MAX ?? 600),
    loginRateLimitMax: Number(env.LOGIN_RATE_LIMIT_MAX ?? 30),
    ...overrides,
  };
}
