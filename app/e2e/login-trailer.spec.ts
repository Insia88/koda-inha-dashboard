import { expect, test } from '@playwright/test';

// 로그인 무대의 KODA 브랜드 필름(15초, 무음) — DEC-006. 영상은 장식이고, 로그인 카드는 지금처럼 본문이다.
test.describe('로그인 브랜드 트레일러(DEC-006)', () => {
  test('데스크톱: 무음·루프·자동재생, 로그인 카드와 세션 만료 안내를 가리지 않는다', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    await page.goto('/login?next=%2F&reason=expired');
    await expect(page.getByRole('heading', { name: '법인 대시보드 로그인' })).toBeVisible();

    const video = page.locator('.login-stage video');
    await expect(video).toHaveCount(1);
    const state = await video.evaluate((node) => {
      const v = node as HTMLVideoElement;
      return { muted: v.muted, loop: v.loop, autoplay: v.autoplay, playsInline: v.playsInline, paused: v.paused, readyState: v.readyState, src: v.currentSrc };
    });
    expect(state.muted).toBe(true);
    expect(state.loop).toBe(true);
    expect(state.autoplay).toBe(true);
    expect(state.playsInline).toBe(true);
    expect(state.src).toContain('/brand/koda-trailer-15s.mp4');

    // 재생이 시작될 때까지(포스터만 떠 있다가 영상이 준비되면 재생)
    await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).readyState >= 2), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => video.evaluate((node) => !(node as HTMLVideoElement).paused), { timeout: 20_000 }).toBe(true);

    // 장식: 포커스를 받지 않고 보조기기에서 숨는다.
    await expect(video).toHaveAttribute('aria-hidden', 'true');
    await expect(video).toHaveAttribute('tabindex', '-1');

    // 영상 뒤에서도 본문(세션 만료 안내·로그인 사용자)이 그대로 동작한다.
    await expect(page.getByText('세션이 만료되어 로그아웃되었습니다. 다시 로그인하면 보던 화면으로 돌아갑니다.')).toBeVisible();
    await expect(page.locator('.login-user').first()).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test('줄인 움직임: 영상을 재생하지 않고 포스터만 보여 준다', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/login');
    await expect(page.locator('.login-stage video')).toBeHidden();
    await expect(page.locator('.login-stage-poster')).toBeVisible();
    await expect(page.getByRole('heading', { name: '법인 대시보드 로그인' })).toBeVisible();
  });
});

test.describe('로그인 브랜드 트레일러 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('좁은 화면: 무대는 위쪽 띠, 로그인 카드는 그 아래에서 시작한다', async ({ page }) => {
    await page.goto('/login');
    const stage = page.locator('.login-stage');
    const card = page.locator('.login-card');
    await expect(stage).toBeVisible();
    await expect(card).toBeVisible();
    const stageBox = await stage.boundingBox();
    const cardBox = await card.boundingBox();
    expect(stageBox!.height).toBeLessThanOrEqual(320);
    expect(cardBox!.y).toBeGreaterThanOrEqual(stageBox!.height - 1);
    await expect(page.getByRole('heading', { name: '법인 대시보드 로그인' })).toBeVisible();
  });
});
