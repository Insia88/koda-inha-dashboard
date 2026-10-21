import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers.ts';

// A5 공개 데모 고지 축소(DEC-004, 저장소 소유자 결정 2026-10-21): 공개 데모는 상단 띠와 로그인 화면의 '공개 데모입니다' 안내 상자 없이
// 모든 화면(로그인 포함) 맨 아래에 작은 한 줄 '모의 데이터 · KODA 공식 서비스 아님'만 보인다.
// 로컬 E2E 서버는 로컬 모드라, 화면이 실행 형태를 읽는 두 응답(/api/healthz의 mode, /api/me의 environment.mode)만 'public-demo'로 바꿔 그린다.
// 서버 동작(한도·세션·noindex·기동 조건)은 바꾸지 않는다. 배포 확인(E2E_BASE_URL)에서 서버가 이미 공개 데모이면 응답을 바꾸지 않고 그대로 검사한다.
// 로컬 실행의 상단 환경 띠·'개발용 로그인입니다' 안내가 그대로인지도 확인한다(DESIGN.md '고지·환경 표시': 운영 연동 전에는 없애지 않음).
// 이 파일은 데이터를 바꾸지 않는다(로그인과 조회만).

const LINE = '모의 데이터 · KODA 공식 서비스 아님';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
/** 예전 공개 데모 상단 띠·로그인 안내 상자의 문구. 공개 데모 화면에 더는 없어야 한다. */
const OLD_DEMO_NOTICE = /공개 데모입니다|공개 데모 ·|KODA 공식 서비스가 아니며|데이터가 초기화됩니다|데이터 생성 \d/;

const isPublicDemoServer = async (page: Page) => (await (await page.request.get('/api/healthz')).json()).mode === 'public-demo';

/**
 * 화면이 공개 데모로 그려지게 한다. 서버가 로컬 모드면 /api/healthz·/api/me 응답의 mode만 'public-demo'로 바꾼다(서버가 이미 공개 데모면 그대로).
 * instance를 주면 로그인 경로(/api/auth/…)를 뺀 GET 응답의 X-Demo-Instance를 그 값으로 바꾼다(다른 데모 서버로 연결된 상황 흉내).
 */
async function asPublicDemo(page: Page, instance?: () => string) {
  const real = await isPublicDemoServer(page);
  if (real && !instance) return;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const modeRoute = path === '/api/healthz' || path === '/api/me';
    const instanceRoute = !!instance && route.request().method() === 'GET' && !path.startsWith('/api/auth/');
    if (!modeRoute && !instanceRoute) return route.continue();
    const res = await route.fetch();
    const headers = Object.fromEntries(Object.entries(res.headers()).filter(([k]) => !/^(content-length|content-encoding|transfer-encoding)$/i.test(k)));
    if (instanceRoute) headers['x-demo-instance'] = instance!();
    let body = await res.body();
    if (!real && res.ok() && modeRoute) {
      const json = JSON.parse(body.toString('utf8'));
      if (path === '/api/healthz') json.mode = 'public-demo';
      else json.environment.mode = 'public-demo';
      body = Buffer.from(JSON.stringify(json));
    }
    await route.fulfill({ status: res.status(), headers, body });
  });
}

/** 'rgb(…)'·'rgba(…)' → [r, g, b, a] */
function rgba(css: string): [number, number, number, number] {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`색을 읽을 수 없습니다: ${css}`);
  const [r, g, b, a = '1'] = m[1]!.split(/[\s,/]+/).filter(Boolean);
  return [Number(r), Number(g), Number(b), Number(a)];
}
const luminance = ([r, g, b]: number[]) => {
  const c = [r!, g!, b!].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const contrast = (a: string, b: string) => {
  const x = luminance(rgba(a));
  const y = luminance(rgba(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/**
 * 공개 데모 화면의 고지: 상단 띠·예전 안내 문구가 없고, 맨 아래 한 줄이 하나뿐이며 문구가 정확하다.
 * 그 줄은 고정되지 않은 문서의 마지막 요소이고(다른 내용·포커스를 가리지 않음), 다른 요소와 겹치지 않으며, 끝까지 스크롤하면 보이고
 * 그 자리의 맨 위 요소다. 알림 영역이 아니고, 12px 이상·대비 4.5:1 이상이며, 잘리거나 가로로 넘치지 않는다.
 */
async function expectDemoLine(page: Page, label: string) {
  await expect(page.locator('.env-ribbon'), label).toHaveCount(0);
  await expect(page.getByText(OLD_DEMO_NOTICE), label).toHaveCount(0);
  const footer = page.getByRole('contentinfo');
  await expect(footer, label).toHaveCount(1);
  await expect(footer, label).toHaveText(LINE);
  await footer.scrollIntoViewIfNeeded();
  await expect(footer, label).toBeInViewport();
  const f = await footer.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const doc = document.documentElement;
    const overlaps = [...document.body.querySelectorAll('*')]
      .filter((o) => !el.contains(o) && !o.contains(el))
      .filter((o) => {
        const s = getComputedStyle(o);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        const b = o.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && b.bottom > r.top + 0.5 && b.top < r.bottom - 0.5 && b.right > r.left + 0.5 && b.left < r.right - 0.5;
      })
      .map((o) => `${o.tagName.toLowerCase()}.${o.getAttribute('class') ?? ''}`);
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      text: el.textContent,
      position: cs.position,
      docGap: doc.scrollHeight - (r.bottom + window.scrollY),
      overlaps,
      onTop: !!top && el.contains(top),
      live: !!el.closest('[aria-live], [role="status"], [role="alert"], [role="log"], [role="marquee"], [role="timer"]') || !!el.querySelector('[aria-live], [role]') || el.hasAttribute('role'),
      fontSize: parseFloat(cs.fontSize),
      color: cs.color,
      background: cs.backgroundColor,
      clipped: el.scrollWidth > el.clientWidth + 1 || r.left < -0.5 || r.right > window.innerWidth + 0.5,
      pageOverflowX: doc.scrollWidth > doc.clientWidth,
    };
  });
  expect(f.text, label).toBe(LINE);
  expect(f.position, label).toBe('static');
  expect(Math.abs(f.docGap), `${label}: 문서 끝과의 거리`).toBeLessThanOrEqual(1);
  expect(f.overlaps, `${label}: 겹치는 요소`).toEqual([]);
  expect(f.onTop, `${label}: 다른 요소에 가려짐`).toBe(true);
  expect(f.live, `${label}: 알림 영역`).toBe(false);
  expect(f.fontSize, label).toBeGreaterThanOrEqual(12);
  expect(rgba(f.background)[3], `${label}: 바탕이 불투명해야 대비가 정해진다`).toBe(1);
  expect(contrast(f.color, f.background), label).toBeGreaterThanOrEqual(4.5);
  expect(f.clipped, `${label}: 잘림`).toBe(false);
  expect(f.pageOverflowX, `${label}: 가로 넘침`).toBe(false);
}

/** 전체 화면 axe 검사(WCAG 2.1 A/AA)와, 맨 아래 한 줄이 대비 검사를 '통과'로 받았는지(판정 보류가 아님). */
async function expectAxeClean(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`), label).toEqual([]);
  const footerIn = (id: string, list: typeof r.passes) => !!list.find((x) => x.id === id)?.nodes.some((n) => n.html.includes('demo-footer'));
  expect(footerIn('color-contrast', r.passes), `${label}: 맨 아래 한 줄 대비 통과`).toBe(true);
  expect(footerIn('color-contrast', r.incomplete), `${label}: 맨 아래 한 줄 대비 판정 보류`).toBe(false);
}

for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`공개 데모 맨 아래 한 줄 ${vp.width}px`, () => {
    test.use({ viewport: vp });

    test('로그인 화면과 앱 화면: 상단 띠·안내 상자 없이 맨 아래 한 줄만 있고, 화면을 옮겨도 같은 줄이 그대로다', async ({ page }) => {
      await asPublicDemo(page);
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: '법인 대시보드 로그인' })).toBeVisible();
      await expect(page.getByRole('contentinfo')).toHaveText(LINE);
      // 공개 데모 로그인 화면에는 안내 상자가 없다(예전 '공개 데모입니다', 로컬용 '개발용 로그인입니다' 모두).
      await expect(page.locator('.login-card .notice')).toHaveCount(0);
      await expect(page.getByText('개발용 로그인입니다')).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expectDemoLine(page, `로그인 ${vp.width}`);
      await expectAxeClean(page, `로그인 ${vp.width}`);

      await page.getByRole('button', { name: /^한지수/ }).click();
      await page.waitForURL((u) => !u.pathname.startsWith('/login'));
      await page.locator('#page-title').waitFor();
      await page.waitForLoadState('networkidle');
      // 머리글이 화면 맨 위에 붙는다(위에 띠가 없다).
      expect(await page.locator('.topbar').evaluate((t) => Math.round(t.getBoundingClientRect().top + window.scrollY))).toBe(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expectDemoLine(page, `홈 ${vp.width}`);
      await expectAxeClean(page, `홈 ${vp.width}`);

      // 앱 안에서 화면을 옮겨도 같은 요소가 그대로 남는다(다시 그려 화면 낭독기에 새로 알리지 않음).
      await page.getByRole('contentinfo').evaluate((el) => { (el as HTMLElement & { a5?: boolean }).a5 = true; });
      const toggle = page.locator('.topbar .nav-toggle');
      if (await toggle.isVisible()) await toggle.click();
      await page.locator('#sidenav').getByRole('link', { name: '잔고' }).click();
      await expect(page.getByRole('heading', { name: '잔고', level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await page.getByRole('contentinfo').evaluate((el) => (el as HTMLElement & { a5?: boolean }).a5)).toBe(true);
      await expectDemoLine(page, `잔고 ${vp.width}`);
    });
  });
}

test('짧은 화면에서도 맨 아래 한 줄은 화면 아래 끝에 보인다(1440×2400)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 2400 });
  await asPublicDemo(page);
  await page.goto('/login');
  await expect(page.getByRole('contentinfo')).toHaveText(LINE);
  await page.waitForLoadState('networkidle');
  await expectAtViewportBottom(page, '로그인');
  await loginAs(page, '한지수');
  await page.goto('/tokens');
  await page.locator('#page-title').waitFor();
  await page.waitForLoadState('networkidle');
  await expectAtViewportBottom(page, '지원 자산·네트워크');
});

/** 문서가 화면보다 짧을 때: 스크롤 없이 맨 아래 한 줄의 아래 끝이 화면 아래 끝과 같다. */
async function expectAtViewportBottom(page: Page, label: string) {
  const g = await page.getByRole('contentinfo').evaluate((el) => ({
    bottom: el.getBoundingClientRect().bottom,
    vh: window.innerHeight,
    scrolls: document.documentElement.scrollHeight > window.innerHeight,
  }));
  expect(g.scrolls, `${label}: 이 검사는 화면보다 짧은 문서여야 한다`).toBe(false);
  expect(Math.abs(g.bottom - g.vh), label).toBeLessThanOrEqual(1);
  await expectDemoLine(page, `${label} 짧은 화면`);
}

test('좁은 화면·확대: 320px과 200% 확대(1440×900 → 720×450 CSS px)에서도 한 줄이 잘리지 않고 가로로 넘치지 않는다', async ({ page }) => {
  await asPublicDemo(page);
  for (const vp of [{ width: 320, height: 640 }, { width: 720, height: 450 }]) {
    await page.setViewportSize(vp);
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: '법인 대시보드 로그인' })).toBeVisible();
    await expectDemoLine(page, `로그인 ${vp.width}`);
  }
  await loginAs(page, '한지수');
  for (const vp of [{ width: 320, height: 640 }, { width: 720, height: 450 }]) {
    await page.setViewportSize(vp);
    await page.goto('/');
    await page.locator('#page-title').waitFor();
    await page.waitForLoadState('networkidle');
    await expectDemoLine(page, `홈 ${vp.width}`);
  }
});

test.describe('공개 데모 메뉴 서랍(390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('서랍이 열려 있는 동안 맨 아래 한 줄은 inert이고, Tab은 서랍과 토글 안에서만 돌며, 닫으면 다시 읽힌다', async ({ page }) => {
    await asPublicDemo(page);
    await loginAs(page, '한지수');
    await page.locator('#page-title').waitFor();
    const footer = page.getByRole('contentinfo');
    await expect(footer).toHaveText(LINE);
    const toggle = page.locator('.topbar .nav-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sidenav').getByRole('link', { name: '홈', exact: true })).toBeFocused();
    expect(await page.locator('.demo-footer').evaluate((el) => !!el.closest('[inert]'))).toBe(true);
    expect(await page.evaluate(() => ['#main', '.skip-link', '.topbar-user'].map((s) => !!document.querySelector(s)?.closest('[inert]')))).toEqual([true, true, true]);
    const links = await page.locator('#sidenav a').count();
    for (let i = 0; i < links + 3; i++) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => {
        const a = document.activeElement;
        return !!a && (!!a.closest('#sidenav') || a.classList.contains('nav-toggle'));
      });
      expect(where, `Tab ${i + 1}번째`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    expect(await page.locator('.demo-footer').evaluate((el) => !!el.closest('[inert]'))).toBe(false);
    await expect(page.getByRole('contentinfo')).toHaveText(LINE);
  });
});

test('공개 데모: 다른 데모 서버 안내는 그대로 본문 위 알림 영역에 뜨고, 맨 아래 한 줄과 따로다(대화상자 없음)', async ({ page }) => {
  let instance = 'a5-instance-a';
  await asPublicDemo(page, () => instance);
  await loginAs(page, '한지수');
  await page.locator('#page-title').waitFor();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('status').filter({ hasText: '다른 데모 서버로 연결되었습니다' })).toHaveCount(0);
  instance = 'a5-instance-b';
  // 처음 여는 화면은 새로 조회한다(그 응답이 새 인스턴스).
  await page.locator('#sidenav').getByRole('link', { name: '잔고' }).click();
  await expect(page.getByRole('heading', { name: '잔고', level: 1 })).toBeVisible();
  const notice = page.locator('#main [role="status"]').filter({ hasText: '다른 데모 서버로 연결되었습니다.' });
  await expect(notice).toContainText('로그인은 유지되지만, 방금 만든 요청·주소가 이 서버에는 없을 수 있습니다. 모든 데이터는 모의 데이터입니다.');
  await expect(notice.getByRole('button', { name: '닫기' })).toBeVisible();
  await expect(notice.getByRole('button', { name: '처음 화면으로' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expectDemoLine(page, '인스턴스 안내와 함께');
});

test('로컬 실행은 그대로: 상단 개발 환경 띠와 로그인 화면 \'개발용 로그인입니다\' 안내가 있고 맨 아래 한 줄은 없다', async ({ page }) => {
  test.skip(await isPublicDemoServer(page), '배포 확인(공개 데모)에서는 로컬 화면이 없다');
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '법인 대시보드 로그인' })).toBeVisible();
  await expect(page.locator('.notice').filter({ hasText: '개발용 로그인입니다' })).toBeVisible();
  await expect(page.getByRole('contentinfo')).toHaveCount(0);
  await loginAs(page, '한지수');
  await page.locator('#page-title').waitFor();
  const ribbon = page.getByRole('note').filter({ hasText: '개발 환경' });
  await expect(ribbon).toHaveText(/^개발 환경 · 개발용 로그인 · 모의 데이터 · .+ — 실제 자산 전송이나 운영 인증이 일어나지 않습니다\.$/);
  expect(await ribbon.evaluate((r) => Math.round(r.getBoundingClientRect().top + window.scrollY))).toBe(0);
  await expect(page.getByRole('contentinfo')).toHaveCount(0);
  await expect(page.locator('.demo-footer')).toHaveCount(0);
});
