import { defineConfig, devices } from '@playwright/test';

const PORT = 4400;
// E2E 전용 DB를 매번 초기화하고 빌드된 화면을 서빙하는 서버를 띄운다. 먼저 `npm run build`가 필요하다.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, locale: 'ko-KR', timezoneId: 'Asia/Seoul', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /responsive.spec.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: {
    command: 'npx tsx server/reset-db.ts && npx tsx server/index.ts',
    url: `http://127.0.0.1:${PORT}/api/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(PORT), DB_PATH: './data/e2e.sqlite', MOCK_CUSTODY_PROCESSING_MS: '1500', LOG_LEVEL: 'warn', RATE_LIMIT_MAX: '5000', LOGIN_RATE_LIMIT_MAX: '300' },
  },
});