import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// KODA 공개 사이트(/site): 서비스 소개서·대시보드 이용가이드·보도자료를 반영한 공식 정보 페이지.
// 구성: 상단 내비 → 히어로(주요 지표 캐러셀) → 회사 소개/연혁 → 서비스 캐러셀 → 신뢰·보안 → 보도자료 캐러셀 → 대시보드 데모 → 문의·바닥글.
// 데모 대시보드(/login)는 별도 모의 환경이며, 이 테스트는 사이트를 읽기만 한다.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('KODA 공개 사이트', () => {
  test('구성·최신 정보: 내비 → 히어로 지표 → 회사/연혁 → 서비스 → 신뢰·보안 → 보도자료 → 대시보드 데모 → 문의', async ({ page }) => {
    await page.goto('/site');
    await expect(page).toHaveTitle(/한국디지털에셋\(KODA\)/);
    await expect(page.getByRole('heading', { level: 1, name: /디지털 자산의.*가장 신뢰할 수 있는.*파트너/ })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('link', { name: /본문으로 건너뛰기/ })).toHaveCount(1);

    const nav = page.getByRole('navigation', { name: '사이트 바로가기' });
    for (const [id, label] of [['about', '회사 소개'], ['services', '서비스'], ['trust', '신뢰·보안'], ['news', '보도자료'], ['dashboard', '대시보드 데모']]) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toHaveAttribute('href', `#${id}`);
      await expect(page.locator(`#${id}`)).toBeAttached();
    }
    await expect(nav.getByRole('link', { name: /서비스 문의/ })).toHaveAttribute('href', 'mailto:hello@kodax.com');

    // 최신 공식 정보(자료·보도자료에서 확인한 값)
    await expect(page.getByText('86.6%', { exact: true }).first()).toBeVisible();
    await expect(page.locator('.koda-trust-meta').filter({ hasText: '$40M' }).first()).toBeVisible();
    await expect(page.getByText(/2024년 하반기 수탁고 기준/)).toBeVisible();
    await expect(page.getByText(/금융위원회 2024년 하반기 가상자산사업자 실태조사/)).toBeVisible();
    await expect(page.getByText('SOC1 Type 2', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('ISMS', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('VASP 2025-04', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/피그먼트와 기관용 이더리움 스테이킹/)).toBeVisible();
    await expect(page.getByText(/시리즈A 100억/).first()).toBeVisible();

    // 히어로 주요 지표 캐러셀: 4장, 일시정지
    await expect(page.locator('.koda-stat-slide')).toHaveCount(4);
    await expect(page.getByRole('button', { name: '지표 자동 넘김 일시정지' })).toBeVisible();
    await page.getByRole('button', { name: '지표 자동 넘김 일시정지' }).click();
    await expect(page.getByRole('button', { name: '지표 자동 넘김 다시 시작' })).toHaveAttribute('aria-pressed', 'true');

    // 서비스·보도자료·데모 화면 캐러셀
    await expect(page.locator('.koda-service')).toHaveCount(6);
    await expect(page.locator('.koda-press')).toHaveCount(6);
    await expect(page.locator('.koda-trust-card')).toHaveCount(6);
    await expect(page.locator('.koda-dash-slide')).toHaveCount(3);
    await expect(page.locator('.koda-count').first()).toContainText('01');
    await page.getByRole('button', { name: '다음 서비스' }).click();
    await expect(page.locator('.koda-count').first()).toContainText('02');
    await page.getByRole('button', { name: '이전 서비스' }).click();
    await expect(page.locator('.koda-count').first()).toContainText('01');

    // 보도자료 링크와 대시보드 데모 CTA
    await expect(page.getByRole('link', { name: /KODA, 피그먼트와 기관용 이더리움 스테이킹 서비스 확대/ })).toHaveAttribute('href', 'https://biz.heraldcorp.com/article/10896521');
    await expect(page.getByRole('link', { name: /데모 대시보드 열기/ })).toHaveAttribute('href', '/login');

    // 바닥글은 마지막 contentinfo이고 공식 회사 정보·데모 고지를 담는다.
    const footer = page.getByRole('contentinfo');
    await expect(footer).toHaveCount(1);
    await expect(footer).toContainText('주식회사 한국디지털에셋');
    await expect(footer).toContainText('618-81-36254');
    await expect(footer).toContainText('2025-04');
    await expect(footer).toContainText('모의 환경');
    await expect(footer.getByRole('link', { name: '데모 대시보드' })).toHaveAttribute('href', '/login');
  });

  test('모바일 390: 메뉴·오버플로 없음·캐러셀 터치', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/site');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await page.getByRole('button', { name: '메뉴 열기' }).click();
    await expect(page.getByRole('navigation', { name: '사이트 바로가기' })).toBeVisible();
    await page.getByRole('navigation', { name: '사이트 바로가기' }).getByRole('link', { name: '서비스', exact: true }).click();
    await expect(page.getByRole('heading', { name: /보관부터 운영까지/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '메뉴 열기' })).toBeVisible();

    await page.locator('#services').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '다음 서비스' }).click();
    await expect(page.locator('.koda-count').first()).toContainText('02');

    const footer = page.getByRole('contentinfo');
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeVisible();
  });

  test('줄인 움직임: 자동 넘김·등장 애니메이션 없이 정적', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/site');
    const reveals = page.locator('.koda [data-rv]');
    expect(await reveals.count()).toBeGreaterThan(3);
    expect(await reveals.evaluateAll((els) => els.every((el) => getComputedStyle(el).opacity === '1'))).toBe(true);
    const heroAnimation = await page.locator('.koda-hero-copy > *').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(heroAnimation).toBe('none');
  });

  test('접근성: axe WCAG 2.1 AA 위반 0 (첫 화면 + 전체 스크롤 + 모바일 390·320)', async ({ page }) => {
    await page.goto('/site');
    await page.waitForTimeout(900);
    const first = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(first.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(800);
    const scrolled = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(scrolled.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/site');
      await page.waitForTimeout(900);
      const mobileFirst = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(mobileFirst.violations.map((v) => `${width} ${v.id}: ${v.nodes.length}`)).toEqual([]);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(700);
      const mobileScrolled = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(mobileScrolled.violations.map((v) => `${width} ${v.id}: ${v.nodes.length}`)).toEqual([]);
    }
  });

  test('없는 사이트 주소: 로그인 만료 화면이 아니라 사이트 첫 화면으로 돌아온다', async ({ page }) => {
    await page.goto('/site/nonexistent-xyz');
    await expect(page).toHaveURL(/\/site$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
