// 실행 중인 서버(기본 http://127.0.0.1:4300)의 주요 화면을 데스크톱·태블릿·모바일로 캡처한다.
// 사용: node scripts/screens.mjs [baseUrl] — 결과는 artifacts/screenshots/ (git 제외)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4300';
const OUT = 'artifacts/screenshots';
mkdirSync(OUT, { recursive: true });
const sizes = { desktop: { width: 1440, height: 900 }, tablet: { width: 820, height: 1180 }, mobile: { width: 390, height: 844 } };
const shots = [
  ['u-a-han', '/', 'home-requester'],
  ['u-a-oh', '/', 'home-approver'],
  ['u-a-han', '/addresses', 'addresses'],
  ['u-a-han', '/addresses/new', 'address-new'],
  ['u-a-han', '/requests', 'requests'],
  ['u-a-oh', '/requests/wr-4', 'request-approve'],
  ['u-a-han', '/requests/wr-5', 'request-review'],
  ['u-a-han', '/activity', 'activity'],
  ['u-a-han', '/balances', 'balances'],
  ['u-a-han', '/wallets', 'wallets'],
  ['u-a-han', '/insights', 'insights'],
  ['u-a-moon', '/audit', 'audit'],
  ['u-a-yoon', '/org', 'org'],
  ['u-b-bae', '/', 'home-org-b'],
  ['u-a-han', '/audit', 'forbidden'],
];
const browser = await chromium.launch();
const states = {};
async function stateFor(user) {
  if (states[user]) return states[user];
  const ctx = await browser.newContext();
  await ctx.request.post(`${BASE}/api/auth/dev-login`, { data: { userId: user } });
  states[user] = await ctx.storageState();
  await ctx.close();
  return states[user];
}
const errors = [];
for (const [sizeName, viewport] of Object.entries(sizes)) {
  const only = process.env.SIZES ? process.env.SIZES.split(',') : null;
  if (only && !only.includes(sizeName)) continue;
  for (const [user, path, name] of shots) {
    const ctx = await browser.newContext({ viewport, locale: 'ko-KR', timezoneId: 'Asia/Seoul', storageState: await stateFor(user) });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}/${sizeName}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`${name}/${sizeName}: ${e.message}`));
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${name}-${sizeName}.png`, fullPage: true });
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? `콘솔 오류 ${errors.length}건\n${errors.join('\n')}` : '콘솔 오류 없음');