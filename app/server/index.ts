import { loadConfig } from './config.ts';
import { createRuntime } from './runtime.ts';

const cfg = loadConfig();
const rt = await createRuntime(cfg);
const { app } = rt;

// 모의 시세 갱신: 개발 환경에서 기준 시각만 갱신한다(가격 불변). MOCK_PRICE_FEED=off 이면 멈춰 '지연' 상태를 확인할 수 있다.
const priceTimer = cfg.mockPriceFeed ? setInterval(() => rt.refreshPrices(), 60_000) : null;
rt.refreshPrices();

const worker = setInterval(() => rt.settle(), 1000);

const shutdown = async () => {
  clearInterval(worker);
  if (priceTimer) clearInterval(priceTimer);
  await rt.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: cfg.host, port: cfg.port });
app.log.info(`KODA 대시보드(${cfg.deployment === 'public-demo' ? '공개 데모 모드' : '개발 환경'}) http://${cfg.host}:${cfg.port}${rt.seeded ? ' — 모의 데이터 생성됨' : ''}`);
