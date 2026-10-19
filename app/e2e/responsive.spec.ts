import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './helpers.ts';

/** 390px 폭에서 표 화면이 읽히는지: 가로 넘침, 보이는 표 셀의 최소 폭, 화면 밖으로 나간 배지를 잰다. */
async function measureTables(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => el.getClientRects().length > 0 && (el as HTMLElement).checkVisibility({ visibilityProperty: true });
    const cells = [...document.querySelectorAll('table tbody td, table tbody th')].filter(visible);
    const narrow = cells
      .map((c) => ({ w: Math.round(c.getBoundingClientRect().width), text: (c.textContent ?? '').trim().slice(0, 20) }))
      .filter((c) => c.w < 56);
    const badgeRights = [...document.querySelectorAll('table .badge')].filter(visible).map((b) => b.getBoundingClientRect().right);
    // 표 영역 안의 가로 스크롤로 열이 화면 밖에 숨어 있으면 문서 넘침은 없어도 읽을 수 없다.
    const scrolledWraps = [...document.querySelectorAll('.table-wrap')].filter(visible).filter((w) => w.scrollWidth - w.clientWidth > 1).length;
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      cellCount: cells.length,
      narrow,
      badgeRights,
      scrolledWraps,
      height: document.documentElement.scrollHeight,
    };
  });
}

test.describe('390px 표 화면', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const tour: [string, string, string][] = [
    ['한지수', '/activity', '자산 활동 내역'],
    ['문태호', '/audit?pageSize=25', '감사 기록'],
    ['윤가람', '/org', '조직 관리'],
    ['한지수', '/addresses', '주소록 관리'],
    ['한지수', '/balances', '잔고'],
  ];
  for (const [user, path, title] of tour) {
    test(`${path} (${user}): 가로 넘침 없음, 셀 폭 56px 이상, 배지가 화면 안`, async ({ page }) => {
      await loginAs(page, user);
      await page.goto(path);
      await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
      await page.locator('table tbody tr:visible').first().waitFor(); // 잔고는 넓은 화면용 표를 숨기고 자산별 덩어리를 보인다
      await page.waitForLoadState('networkidle');
      const m = await measureTables(page);
      expect(m.overflow).toBeLessThanOrEqual(1);
      expect(m.cellCount).toBeGreaterThan(0);
      expect(m.narrow).toEqual([]);
      expect(m.scrolledWraps).toBe(0);
      for (const right of m.badgeRights) expect(right).toBeLessThanOrEqual(390);
      if (path.startsWith('/addresses')) {
        // 주소 상태 배지는 모든 행에서 보이고 화면 안에 있다
        const rows = await page.locator('table tbody tr:visible').count();
        expect(m.badgeRights.length).toBe(rows);
      }
      if (path.startsWith('/audit')) {
        await expect(page.locator('table tbody tr:visible')).toHaveCount(25);
        expect(m.height).toBeLessThan(6000);
      }
    });
  }

  test('상단 막대: 조직명 옆 모의 표시가 잘리지 않고, 로그아웃 버튼 이름이 남는다', async ({ page }) => {
    await loginAs(page, '한지수');
    await expect(page.getByRole('heading', { name: '지금 처리할 일' })).toBeVisible();
    const tag = page.locator('.topbar .mock-tag');
    await expect(tag).toBeVisible();
    await expect(tag).toHaveText('모의');
    const box = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect().toJSON() as DOMRect;
      return { tag: r('.topbar .mock-tag'), org: r('.topbar .org-name'), name: r('.topbar .org-name-text'), user: r('.topbar-user') };
    });
    // 예전에는 조직명 칸이 overflow:hidden이라 '모의' 표시가 칸 밖으로 밀려 잘렸다.
    expect(box.tag.width).toBeGreaterThan(20);
    expect(box.tag.right).toBeLessThanOrEqual(box.org.right + 0.5);
    expect(box.tag.right).toBeLessThanOrEqual(box.user.left);
    expect(box.name.width).toBeGreaterThan(40);
    await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible();
  });
});

test('모바일: 메뉴 열기/닫기, 가로 넘침 없음', async ({ page }) => {
  await loginAs(page, '한지수');
  await expect(page.getByRole('heading', { name: '지금 처리할 일' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole('link', { name: '주소록 관리' })).toBeHidden();
  await page.getByRole('button', { name: '메뉴 열기' }).click();
  await page.getByRole('link', { name: '주소록 관리' }).click();
  await expect(page.getByRole('heading', { name: '주소록 관리' })).toBeVisible();
  await expect(page.getByRole('link', { name: '잔고' })).toBeHidden();
});