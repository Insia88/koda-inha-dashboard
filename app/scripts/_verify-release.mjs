import { chromium } from 'playwright';
import fs from 'node:fs';

const base = 'https://koda-inha-dashboard.vercel.app';
const out = 'C:/Users/User/Documents/deepseek-harness/default-workspace/_handoff';
const browser = await chromium.launch();
const result = {};

async function login(page, name) {
  await page.goto(`${base}/login`);
  await page.getByRole('button', { name: new RegExp('^' + name) }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.locator('#page-title').waitFor();
  await page.waitForLoadState('networkidle');
}

// 1) login: expired notice absent fresh, sound, no banner after login, recommended order
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/login?next=%2F&reason=expired`, { waitUntil: 'load' });
  await page.getByRole('heading', { name: '법인 대시보드 로그인' }).waitFor();
  const expiredFresh = await page.getByText('세션이 만료되어').count();
  const soundBtn = page.getByRole('button', { name: /배경음/ });
  const soundVisible = await soundBtn.count();
  const users = await page.locator('.login-user-name').allTextContents();
  await page.screenshot({ path: `${out}/release-login.png` });
  await login(page, '한지수');
  const banner = await page.locator('#main [role="status"]').filter({ hasText: '다른 데모 서버로 연결되었습니다' }).count();
  result.login = { expiredNoticeOnFreshVisit: expiredFresh, soundButton: soundVisible, firstUsers: users.slice(0, 4), bannerAfterLogin: banner, consoleErrors: errors };
  await page.close();
}

// 2) mobile drawer switcher + audit business filter + hash focus
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
  await login(page, '한지수');
  await page.locator('.nav-toggle').click();
  const navUser = await page.locator('.nav-user').innerText().catch(() => '');
  const drawerSwitcher = page.locator('.nav-user .demo-switcher');
  const drawerSwitcherVisible = await drawerSwitcher.isVisible();
  const box = await drawerSwitcher.boundingBox();
  await page.screenshot({ path: `${out}/release-mobile-drawer.png` });
  result.mobile = { navUser: navUser.replace(/\s+/g, ' ').slice(0, 80), drawerSwitcherVisible, drawerSwitcherBox: box ? { w: Math.round(box.width), h: Math.round(box.height) } : null };
  await page.close();
}

{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  await login(page, '문태호');
  await page.goto(`${base}/audit`, { waitUntil: 'networkidle' });
  await page.locator('#page-title').waitFor();
  const audit = await page.evaluate(() => {
    const cb = document.querySelector('.check-inline input');
    const rows = [...document.querySelectorAll('.aud-summary')].slice(0, 6).map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim() ?? '');
    const hint = [...document.querySelectorAll('p')].map((p) => p.textContent ?? '').find((t) => t.includes('무결성 확인은'));
    const verify = document.body.textContent?.match(/전체\s*(\d+)\s*건/)?.[1] ?? null;
    return { businessChecked: cb?.checked ?? null, rows, hint: !!hint, verifyTotal: verify };
  });
  await page.screenshot({ path: `${out}/release-audit.png` });
  result.audit = audit;
  await page.goto(`${base}/requests/wr-3#decision-card`, { waitUntil: 'networkidle' });
  await page.locator('#page-title').waitFor();
  await page.waitForTimeout(700);
  const hash = await page.evaluate(() => {
    const active = document.activeElement;
    const card = document.getElementById('decision-card');
    const r = card ? card.getBoundingClientRect() : null;
    return { activeId: active?.id ?? active?.tagName, cardTop: r ? Math.round(r.top) : null, inView: r ? r.top >= 0 && r.top < window.innerHeight : null };
  });
  result.hashEntry = hash;
  await page.close();
}

await browser.close();
fs.writeFileSync(`${out}/release-verify.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
