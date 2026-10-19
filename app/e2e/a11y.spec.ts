import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers.ts';

// 자동 검사(axe, WCAG 2.1 A/AA 규칙)로 찾을 수 있는 문제만 확인한다. 스크린리더 실사용 검증을 대신하지 않는다.
const pages: [string, string][] = [
  ['한지수', '/'], ['한지수', '/addresses'], ['한지수', '/addresses/new'], ['한지수', '/requests'], ['한지수', '/requests/wr-5'],
  ['오민재', '/requests/wr-4'], ['한지수', '/activity'], ['한지수', '/balances'], ['한지수', '/wallets'], ['한지수', '/staking'],
  ['한지수', '/tokens'], ['한지수', '/insights'], ['문태호', '/audit'], ['윤가람', '/org'],
  // 확인 카드(가운데 구간 테두리 표시)와 승인 대기 요청 상세
  ['오민재', '/addresses/ab-08'], ['오민재', '/requests/wr-3'],
];

test('로그인 화면 접근성 자동 검사', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '법인 대시보드 로그인' })).toBeVisible();
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});

// 좁은 화면(390px)에서만 보이는 구성(잔고 자산별 덩어리·용어 설명, 쌓인 표)도 같은 자동 검사를 받는다.
test.describe('390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const [user, path] of [['한지수', '/balances'], ['한지수', '/activity'], ['한지수', '/requests']] as const) {
    test(`접근성 자동 검사 390px ${path} (${user})`, async ({ page }) => {
      await loginAs(page, user);
      await page.goto(path);
      await page.locator('h1').first().waitFor();
      await page.waitForLoadState('networkidle');
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    });
  }
});

for (const [user, path] of pages) {
  test(`접근성 자동 검사 ${path} (${user})`, async ({ page }) => {
    await loginAs(page, user);
    // 로그인 뒤 대상 화면에서 난 콘솔 오류·페이지 오류도 함께 0건이어야 한다(배포 확인에서도 같은 검사).
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    await page.goto(path);
    await page.locator('h1').first().waitFor();
    await page.waitForLoadState('networkidle');
    const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const summary = r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
    expect(summary).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}
