// 상호작용 상태(확인 대화상자, 작성 중 이탈 확인, 검색 지우기, 폼 오류)를 실제 브라우저로 캡처한다.
// 사용: node scripts/screens-states.mjs [baseUrl] — 실행 중인 서버(초기화된 개발 DB) 필요. 결과는 artifacts/screenshots/state-*.png
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4300';
const OUT = 'artifacts/screenshots';
mkdirSync(OUT, { recursive: true });
const sizes = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const browser = await chromium.launch();
const errors = [];
async function open(user, viewport) {
  const ctx = await browser.newContext({ viewport, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  await ctx.request.post(`${BASE}/api/auth/dev-login`, { data: { userId: user } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
}
for (const [size, viewport] of Object.entries(sizes)) {
  // 1) 요청 취소 대화상자 (초안 wr-6)
  let { ctx, page } = await open('u-a-han', viewport);
  await page.goto(`${BASE}/requests/wr-6`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '요청 취소' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/state-cancel-dialog-${size}.png` });
  await page.keyboard.press('Escape');
  // 2) 작성 중 이탈 확인
  await page.goto(`${BASE}/requests/new`, { waitUntil: 'networkidle' });
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('link', { name: '취소' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/state-unsaved-dialog-${size}.png` });
  await page.getByRole('button', { name: '계속 작성' }).click();
  // 3) 폼 오류(첫 오류 포커스)
  await page.goto(`${BASE}/requests/new`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '초안 저장 후 검토하기' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/state-form-error-${size}.png`, fullPage: true });
  // 4) 검색어와 지우기 버튼
  await page.goto(`${BASE}/addresses?q=${encodeURIComponent('거래소')}`, { waitUntil: 'networkidle' });
  await page.getByRole('searchbox', { name: '주소 검색' }).focus();
  await page.screenshot({ path: `${OUT}/state-search-${size}.png` });
  await ctx.close();
}
await browser.close();
console.log(errors.length ? `콘솔 오류 ${errors.length}건\n${errors.join('\n')}` : '콘솔 오류 없음');
