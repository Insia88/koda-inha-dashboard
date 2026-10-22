import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.ts';
import { migrate, openDb, type DB } from './db.ts';
import { buildApp } from './app.ts';
import { MockCustodyAdapter, type CustodyAdapter } from './adapters/custody.ts';
import { settleProcessing } from './domain/requests.ts';
import { activateDueAddresses } from './domain/addresses.ts';
import { seed } from './seed.ts';

/** 모의 시세 기준 시각을 이보다 오래되면 갱신한다(가격 값은 바꾸지 않는다). */
const PRICE_REFRESH_MS = 60_000;

export interface Runtime {
  cfg: AppConfig;
  db: DB;
  custody: CustodyAdapter;
  app: FastifyInstance;
  /** 이 서버 인스턴스(프로세스)를 구분하는 값. 공개 데모에서는 X-Demo-Instance 응답 헤더로도 보낸다. */
  instanceId: string;
  /** 이번 기동에서 모의 데이터를 새로 만든 시각. 기존 DB를 이어 쓰면 null. */
  seededAt: string | null;
  seeded: boolean;
  /** PROCESSING 요청을 모의 커스터디 결과로 정산한다. */
  settle(): void;
  /** 사용 대기 시간이 끝난 주소를 사용 가능으로 바꾼다(주소마다 감사 기록). */
  activateAddresses(): void;
  /** 모의 시세 기준 시각 갱신. maxAgeMs를 주면 그보다 오래된 값만 갱신한다. MOCK_PRICE_FEED=off면 아무것도 하지 않는다. */
  refreshPrices(maxAgeMs?: number): void;
  /** 요청 시점 백그라운드 작업: 정산 + 사용 대기 종료 + 60초보다 오래된 시세 기준 시각 갱신. */
  tick(): void;
  close(): Promise<void>;
}

function refuse(message: string): never {
  throw new Error(`공개 데모를 시작하지 않았습니다: ${message}`);
}

/**
 * DB 열기 → 마이그레이션 → 비어 있으면 모의 데이터 생성 → 커스터디 어댑터 → Fastify 앱.
 * 로컬 서버(index.ts)와 Vercel 함수(vercel.ts)가 같은 순서로 기동하도록 한곳에 모았다.
 */
export async function createRuntime(cfg: AppConfig, custodyOverride?: CustodyAdapter): Promise<Runtime> {
  const custody = custodyOverride ?? new MockCustodyAdapter(cfg.policy.mockCustodyProcessingMs);
  const demo = cfg.deployment === 'public-demo';
  if (demo && !custody.isMock) refuse('공개 데모는 모의 커스터디로만 실행합니다. 실제 커스터디 어댑터가 연결되어 있습니다.');

  const db = openDb(cfg.dbPath);
  let app: FastifyInstance | null = null;
  try {
    migrate(db);
    const seeded = (db.prepare('SELECT COUNT(*) c FROM organizations').get() as { c: number }).c === 0;
    if (seeded) seed(db);
    if (demo) {
      const real = (db.prepare('SELECT COUNT(*) c FROM organizations WHERE is_mock = 0').get() as { c: number }).c;
      if (real > 0) refuse(`모의 데이터가 아닌 조직 ${real}곳이 저장소에 있습니다.`);
    }
    const instanceId = randomUUID();
    const seededAt = seeded ? new Date().toISOString() : null;

    const settle = () => {
      try { settleProcessing(db, custody); } catch (e) { app?.log.error({ err: (e as Error).message }, 'settle failed'); }
    };
    const activateAddresses = () => {
      try { activateDueAddresses(db, new Date().toISOString()); } catch (e) { app?.log.error({ err: (e as Error).message }, 'address activation failed'); }
    };
    const refreshPrices = (maxAgeMs = 0) => {
      if (!cfg.mockPriceFeed) return;
      const t = Date.now();
      if (maxAgeMs > 0) db.prepare('UPDATE prices SET as_of = ? WHERE as_of < ?').run(new Date(t).toISOString(), new Date(t - maxAgeMs).toISOString());
      else db.prepare('UPDATE prices SET as_of = ?').run(new Date(t).toISOString());
    };
    const tick = () => {
      settle();
      activateAddresses();
      try { refreshPrices(PRICE_REFRESH_MS); } catch (e) { app?.log.error({ err: (e as Error).message }, 'price refresh failed'); }
    };

    app = await buildApp({ cfg, db, custody, runtime: { instanceId, seededAt, tick } });
    const built = app;
    return {
      cfg, db, custody, app: built, instanceId, seededAt, seeded, settle, activateAddresses, refreshPrices, tick,
      close: async () => { await built.close(); db.close(); },
    };
  } catch (e) {
    if (app) await app.close().catch(() => undefined);
    db.close();
    throw e;
  }
}
