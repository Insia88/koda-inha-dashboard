import { expect, test } from '@playwright/test';
import { loginAs } from './helpers.ts';

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