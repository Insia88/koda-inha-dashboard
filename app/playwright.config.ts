import { defineConfig, devices } from '@playwright/test';

// 여러 작업을 동시에 검증할 때는 E2E_PORT로 포트를 나눈다(기본 4400).
const PORT = Number(process.env.E2E_PORT ?? 4400);
// 배포 확인 모드: E2E_BASE_URL을 주면 로컬 서버를 띄우지 않고 그 주소에서 읽기 전용 검사(a11y·responsive)만 돈다.
// 보호된 배포는 VERCEL_AUTOMATION_BYPASS_SECRET(자동화용 우회 값)을 헤더로 보낸다. 이 값은 저장소에 넣지 않는다.
const REMOTE = process.env.E2E_BASE_URL?.replace(/\/+$/, '') || undefined;
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
if (REMOTE && !BYPASS) console.warn('[e2e] E2E_BASE_URL만 지정되었습니다. 보호된 배포라면 VERCEL_AUTOMATION_BYPASS_SECRET도 지정하세요.');

// E2E 전용 DB를 매번 초기화하고 빌드된 화면을 서빙하는 서버를 띄운다. 먼저 `npm run build`가 필요하다.
export default defineConfig({
  testDir: 'e2e',
  // 원격 데이터는 다른 검토자와 공유되고 인스턴스마다 다르므로, 데이터를 바꾸는 흐름 검사는 로컬·CI에서만 돈다.
  ...(REMOTE ? { testMatch: /(a11y|responsive)\.spec\.ts$/ } : {}),
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: REMOTE ?? `http://127.0.0.1:${PORT}`,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    // 원격 모드는 우회 헤더가 trace에 평문으로 남지 않도록 trace를 끈다.
    trace: REMOTE ? 'off' : 'retain-on-failure',
    ...(REMOTE && BYPASS ? { extraHTTPHeaders: { 'x-vercel-protection-bypass': BYPASS } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /responsive.spec.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /responsive\.spec\.ts/ },
  ],
  ...(REMOTE ? {} : {
    webServer: {
      command: 'npx tsx server/reset-db.ts && npx tsx server/index.ts',
      url: `http://127.0.0.1:${PORT}/api/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { PORT: String(PORT), DB_PATH: process.env.E2E_DB ?? './data/e2e.sqlite', MOCK_CUSTODY_PROCESSING_MS: '1500', LOG_LEVEL: 'warn', RATE_LIMIT_MAX: '5000', LOGIN_RATE_LIMIT_MAX: '300' },
    },
  }),
});
