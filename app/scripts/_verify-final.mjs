import { chromium } from 'playwright';
import fs from 'node:fs';

const base = 'https://koda-inha-dashboard.vercel.app';
const out = 'C:/Users/User/Documents/deepseek-harness/default-workspace/_handoff';
const browser = await chromium.launch();
const result = {};

async function login(page, name) {
  await page.goto(`${base}/login`, { waitUntil: 'load' });
  await page.getByRole('button', { name: new RegExp('^' + name) }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.locator('#page-title').waitFor();
  await page.waitForLoadState('networkidle');
}

// 1) login: sound toggle, clean title, no instance banner, recommended order
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/login`, { waitUntil: 'load' });
  await page.getByRole('heading', { name: '법인 대시보드 로그인' }).waitFor();
  const title = await page.title();
  const video = page.locator('.login-stage video');
  await video.waitFor({ state: 'attached' });
  const media = await video.evaluate((v) => ({ duration: Math.round(v.duration * 10) / 10, audio: v.mozHasAudio ?? undefined, muted: v.muted, paused: v.paused, ready: v.readyState }));
  const soundBtn = page.getByRole('button', { name: /배경음/ });
  const hasSoundBtn = await soundBtn.count();
  if (hasSoundBtn) {
    await soundBtn.click();
    await page.waitForTimeout(600);
  }
  const after = await video.evaluate((v) => ({ muted: v.muted, paused: v.paused, volume: v.volume, ready: v.readyState }));
  const firstUsers = await page.locator('.login-user-name').allTextContents();
  await page.screenshot({ path: `${out}/final-login-desktop.png` });
  await login(page, '한지수');
  const bannerCount = await page.locator('#main [role="status"]').filter({ hasText: '다른 데모 서버로 연결되었습니다' }).count();
  const titleHome = await page.title();
  const switcher = await page.locator('.topbar .demo-switcher').count();
  result.login = { title, media, soundButton: hasSoundBtn, afterSoundClick: after, firstUsers: firstUsers.slice(0, 4), bannerAfterLogin: bannerCount, titleHome, demoSwitcherInTopbar: switcher, consoleErrors: errors };
  await page.close();
}

// 2) request detail: decision jump focus
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  await login(page, '오민재');
  await page.goto(`${base}/requests/wr-3`, { waitUntil: 'networkidle' });
  await page.locator('#page-title').waitFor();
  const jump = page.getByRole('link', { name: /결정 카드로 바로 가기/ });
  const hasJump = await jump.count();
  if (hasJump) {
    await jump.click();
    await page.waitForTimeout(400);
  }
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    const card = document.getElementById('decision-card');
    const r = card ? card.getBoundingClientRect() : null;
    return { activeId: active?.id ?? active?.tagName, cardTop: r ? Math.round(r.top) : null, cardInView: r ? r.top >= 0 && r.top < window.innerHeight : null, hasTabIndex: card?.getAttribute('tabindex') };
  });
  await page.screenshot({ path: `${out}/final-request-detail.png` });
  result.jump = { hasJump, focus };
  await page.close();
}

// 3) mobile: drawer user block + demo switcher + home
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
  await page.goto(`${base}/login`);
  await page.getByRole('button', { name: /^한지수/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.locator('#page-title').waitFor();
  await page.locator('.nav-toggle').click();
  const drawerUser = await page.locator('.nav-user').isVisible();
  const drawerSwitcher = await page.locator('.nav-demo-switcher').count();
  const navUserText = await page.locator('.nav-user').innerText().catch(() => '');
  await page.screenshot({ path: `${out}/final-home-mobile.png` });
  result.mobile = { drawerUser, drawerSwitcher, navUserText: navUserText.replace(/\s+/g, ' ').slice(0, 80) };
  await page.close();
}

await browser.close();
fs.writeFileSync(`${out}/final-verify.json`, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
