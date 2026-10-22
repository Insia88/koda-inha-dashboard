import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// A8 공개 사이트(/site): 참조 사이트(RWA making-of)처럼 상단 내비 → 히어로 → 바뀌는 점 3 → 필름·장면 6 → 화면 6 → 자료 3 → 도입 CTA·바닥글로 이어지고,
// 대시보드는 별도 탭(/login)으로 분리되어 있다. 데이터를 바꾸지 않는다.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('KODA 공개 사이트', () => {
  test('구성: 히어로 → 바뀌는 점 3 → 장면 6 → 화면 6 → 자료 3 → 도입·바닥글, 대시보드 탭 분리', async ({ page }) => {
    await page.goto('/site');
    await expect(page).toHaveTitle(/KODA \| 법인 디지털 자산 대시보드/);
    await expect(page.getByRole('heading', { level: 1, name: /확인이 쌓여/ })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('link', { name: /본문으로 건너뛰기/ })).toHaveCount(1);

    // 상단 내비게이션은 참조 사이트처럼 섹션 앵커 + 대시보드 탭을 둔다.
    const nav = page.getByRole('navigation', { name: '사이트 바로가기' });
    for (const [id, label] of [['change', '바뀌는 것'], ['film', '브랜드 필름'], ['screens', '화면'], ['resources', '자료'], ['contact', '도입 안내']]) {
      await expect(nav.getByRole('link', { name: label })).toHaveAttribute('href', `#${id}`);
      await expect(page.locator(`#${id}`)).toBeAttached();
    }
    await expect(nav.getByRole('link', { name: '대시보드' })).toHaveAttribute('href', '/login');

    // 바뀌는 점 3가지: 기본은 첫 항목이 열려 있고, 다른 항목을 누르면 본문이 바뀐다.
    await expect(page.getByRole('button', { name: /한 화면에서 확인한다/ })).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('button', { name: /한 번 더 확인하고 승인한다/ }).click();
    await expect(page.getByRole('button', { name: /한 번 더 확인하고 승인한다/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText(/승인자는 요청의 받는 주소·금액·승인 지문/)).toBeVisible();
    await expect(page.locator('.site-change-media img.is-active')).toHaveAttribute('src', '/site/screens/request-detail.jpg');

    // 히어로 미리보기 캐러셀과 화면 캐러셀
    await expect(page.locator('.site-hero-dots button')).toHaveCount(3);
    await expect(page.getByRole('region', { name: '대시보드 화면 미리보기' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '자동 넘김 일시정지' })).toBeVisible();
    await expect(page.locator('.site-hero-slides img.is-active')).toHaveCount(1);
    await expect(page.getByRole('button', { name: '다음 화면' })).toBeVisible();
    await expect(page.locator('.site-carousel-count b')).toHaveText('01');
    await page.getByRole('button', { name: '다음 화면' }).click();
    await expect(page.locator('.site-carousel-count b')).toHaveText('02');
    await expect(page.locator('.site-carousel-dots button.is-active')).toHaveCount(1);
    await page.getByRole('button', { name: '이전 화면' }).click();
    await expect(page.locator('.site-carousel-count b')).toHaveText('01');

    // 필름·장면 6·화면 6·자료 3
    await expect(page.locator('#film video')).toHaveCount(1);
    await expect(page.locator('.site-chapter')).toHaveCount(6);
    await expect(page.locator('.site-screen')).toHaveCount(6);
    await expect(page.locator('.site-res')).toHaveCount(3);

    // 화면 확대 보기(대화상자)와 닫기
    await page.locator('.site-screen').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('img')).toHaveAttribute('src', '/site/screens/home.jpg');
    await page.getByRole('button', { name: '확대 화면 닫기' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.site-screen') !== null)).toBe(true);

    // 바닥글은 문서 마지막 contentinfo이고, 모의 환경 고지를 담는다.
    const footer = page.getByRole('contentinfo');
    await expect(footer).toHaveCount(1);
    await expect(footer).toContainText('모의 데이터 · KODA 공식 서비스 아님');
    await expect(footer).toContainText('실제 자산·고객 정보가 없으며 KODA 공식 서비스가 아닙니다');

    // 자료 3종은 실제로 내려받을 수 있다.
    for (const href of ['/site/koda-dashboard-brief.pdf', '/site/koda-3min-demo-guide.pdf', '/brand/koda-brand-film-16x9.mp4']) {
      const res = await page.request.get(href);
      expect(res.ok(), href).toBe(true);
      expect(Number(res.headers()['content-length'] ?? 0), href).toBeGreaterThan(50_000);
    }

    // 히어로는 자막 겹침·무거운 초기 전송을 피하려고 정지 플레이트를 쓰고, 필름은 아래 섹션에서 재생한다.
    await expect(page.locator('.site-hero-poster')).toBeVisible();
    await expect(page.locator('.site-hero-media video')).toHaveCount(0);
    await expect(page.locator('#film video')).toBeVisible();
    // 바뀌는 것 3가지의 링크는 라벨에 맞는 착지(로그인 후 next)를 가진다.
    for (const [button, href] of [
      [/한 화면에서 확인한다/, '/login?next=%2F'],
      [/한 번 더 확인하고 승인한다/, '/login?next=%2Frequests%2Fwr-3'],
      [/모든 결정을 기록으로 남긴다/, '/login?next=%2Faudit'],
    ] as const) {
      await page.getByRole('button', { name: button }).click();
      const link = page.locator('.site-change-body:not([hidden]) a.site-text-link');
      await expect(link).toHaveAttribute('href', href);
    }
    // 모션 끄기 토글은 자동 캐러셀·패럴랙스를 멈춘다.
    const motion = page.getByRole('button', { name: '모션 끄기' });
    await expect(motion).toBeVisible();
    await motion.click();
    await expect(page.getByRole('button', { name: '모션 켜기' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('모바일 390: 메뉴·오버플로 없음·주요 섹션이 한 열로 쌓인다', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/site');
    await expect(page.getByRole('heading', { level: 1, name: /확인이 쌓여/ })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    const menu = page.getByRole('button', { name: '메뉴 열기' });
    await menu.click();
    await expect(page.getByRole('navigation', { name: '사이트 바로가기' })).toBeVisible();
    await page.getByRole('navigation', { name: '사이트 바로가기' }).getByRole('link', { name: '자료' }).click();
    await expect(page.getByRole('heading', { name: '데모 전에 챙겨 볼 세 가지.' })).toBeVisible();
    await expect(page.getByRole('button', { name: '메뉴 열기' })).toBeVisible();

    // 모바일에서도 자막 없는 정지 플레이트와 제품 화면 1장을 첫 화면에 보여 준다.
    await expect(page.locator('.site-hero-poster')).toBeVisible();
    await expect(page.locator('.site-hero-mobile-shot')).toBeVisible();
    await expect(page.locator('.site-hero-media video')).toHaveCount(0);
    const footer = page.getByRole('contentinfo');
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeVisible();
  });

  test('줄인 움직임: 영상 재생·등장 애니메이션 없이 포스터와 정적 내용', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/site');
    await expect(page.locator('.site-hero-media video')).toHaveCount(0);
    await expect(page.locator('.site-hero-poster')).toBeVisible();
    const posterAnimation = await page.locator('.site-hero-poster').evaluate((el) => getComputedStyle(el).animationName);
    expect(posterAnimation).toBe('none');
    const reveals = page.locator('.site [data-rv]');
    expect(await reveals.count()).toBeGreaterThan(3);
    const allVisible = await reveals.evaluateAll((els) => els.every((el) => getComputedStyle(el).opacity === '1'));
    expect(allVisible).toBe(true);
  });

  test('없는 사이트 주소: 로그인 만료 화면이 아니라 사이트 첫 화면으로 돌아온다', async ({ page }) => {
    await page.goto('/site/nonexistent-xyz');
    await expect(page).toHaveURL(/\/site$/);
    await expect(page.getByRole('heading', { level: 1, name: /확인이 쌓여/ })).toBeVisible();
  });

  test('접근성: axe WCAG 2.1 AA 위반 0 (첫 화면 + 끝까지 스크롤한 상태)', async ({ page }) => {
    await page.goto('/site');
    await page.waitForLoadState('networkidle');
    const first = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(first.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(700);
    const scrolled = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(scrolled.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});
