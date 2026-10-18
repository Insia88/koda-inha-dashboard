import { loadConfig } from './config.ts';
import { migrate, openDb } from './db.ts';
import { buildApp } from './app.ts';
import { MockCustodyAdapter } from './adapters/custody.ts';
import { settleProcessing } from './domain/requests.ts';
import { seed } from './seed.ts';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
migrate(db);
const empty = (db.prepare('SELECT COUNT(*) c FROM organizations').get() as { c: number }).c === 0;
if (empty) seed(db);

const custody = new MockCustodyAdapter(cfg.policy.mockCustodyProcessingMs);
const app = await buildApp({ cfg, db, custody });

// 모의 시세 갱신: 개발 환경에서 기준 시각만 갱신한다(가격 불변). MOCK_PRICE_FEED=off 이면 멈춰 '지연' 상태를 확인할 수 있다.
const priceTimer = process.env.MOCK_PRICE_FEED === 'off' ? null : setInterval(() => {
  db.prepare('UPDATE prices SET as_of = ?').run(new Date().toISOString());
}, 60_000);
if (process.env.MOCK_PRICE_FEED !== 'off') db.prepare('UPDATE prices SET as_of = ?').run(new Date().toISOString());

const worker = setInterval(() => {
  try { settleProcessing(db, custody); } catch (e) { app.log.error({ err: (e as Error).message }, 'settle failed'); }
}, 1000);

const shutdown = async () => {
  clearInterval(worker);
  if (priceTimer) clearInterval(priceTimer);
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: cfg.host, port: cfg.port });
app.log.info(`KODA 대시보드(개발 환경) http://${cfg.host}:${cfg.port}${empty ? ' — 모의 데이터 생성됨' : ''}`);