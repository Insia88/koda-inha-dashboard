import { chromium } from 'playwright';
const base = 'https://koda-inha-dashboard.vercel.app';
const out = 'C:/Users/User/Documents/deepseek-harness/default-workspace/_handoff';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
const p = await ctx.newPage();
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', (e) => errors.push(e.message));
await p.goto(base + '/site', { waitUntil: 'networkidle' });
await p.waitForTimeout(2200);
const hero = await p.evaluate(() => ({
  slides: document.querySelectorAll('.site-hero-slides img').length,
  active: [...document.querySelectorAll('.site-hero-slides img')].findIndex((i) => i.classList.contains('is-active')),
  dots: document.querySelectorAll('.site-hero-dots button').length,
  pause: !!document.querySelector('.site-hero-pause'),
  previewOpacity: getComputedStyle(document.querySelector('.site-hero-preview')).opacity,
  heroWeight: getComputedStyle(document.querySelector('.site-hero-h')).fontWeight,
  serif: document.querySelector('.site-hero-serif')?.textContent,
}));
await p.screenshot({ path: `${out}/final-site-hero.png` });
await p.locator('#screens').scrollIntoViewIfNeeded();
await p.waitForTimeout(900);
await p.screenshot({ path: `${out}/final-site-screens.png` });
const s1 = await p.locator('.site-carousel-count').innerText();
await p.getByRole('button', { name: '다음 화면' }).click();
await p.waitForTimeout(700);
const s2 = await p.locator('.site-carousel-count').innerText();
const screens = await p.evaluate(() => ({
  cards: document.querySelectorAll('.site-screen').length,
  current: [...document.querySelectorAll('.site-screen')].findIndex((el) => el.classList.contains('is-current')),
  overflow: document.documentElement.scrollWidth - innerWidth,
  activeDot: document.querySelectorAll('.site-carousel-dots .is-active').length,
}));
await p.getByRole('button', { name: '일시정지' }).count().catch(() => 0);
await p.close();
// mobile
const m = await ctx.newPage();
await m.setViewportSize({ width: 390, height: 844 });
await m.goto(base + '/site', { waitUntil: 'networkidle' });
await m.waitForTimeout(1800);
const mob = await m.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - innerWidth,
  cardWidth: Math.round(document.querySelector('.site-screen')?.getBoundingClientRect().width ?? 0),
  trackWidth: document.querySelector('.site-screen-track')?.clientWidth,
  heroH: getComputedStyle(document.querySelector('.site-hero-h')).fontSize,
  video: getComputedStyle(document.querySelector('.site-hero-media video')).display,
}));
await m.screenshot({ path: `${out}/final-site-mobile.png` });
await m.locator('#screens').scrollIntoViewIfNeeded();
await m.waitForTimeout(700);
await m.screenshot({ path: `${out}/final-site-mobile-screens.png` });
await m.close();
console.log(JSON.stringify({ hero, screens, carousel: { before: s1, after: s2 }, mobile: mob, errors }, null, 1));
await b.close();
