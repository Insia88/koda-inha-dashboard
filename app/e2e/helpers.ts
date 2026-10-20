import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Page } from '@playwright/test';

export async function loginAs(page: Page, name: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

export async function logout(page: Page) {
  await page.getByRole('button', { name: '로그아웃' }).click();
  await page.waitForURL('**/login');
}

/**
 * E2E 서버가 쓰는 DB 파일(playwright.config.ts webServer의 DB_PATH와 같은 규칙, app/ 기준).
 * 앱 경로 밖의 변경(저장 계층에서 요청 내용을 바꿈·주소를 사용 대기로 되돌림·소액 입금 기록을 넣음)을 흉내 낼 때만 쓴다.
 */
const E2E_DB_FILE = path.resolve(fileURLToPath(new URL('..', import.meta.url)), process.env.E2E_DB ?? './data/e2e.sqlite');
export function onDb(fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(E2E_DB_FILE);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    fn(db);
  } finally {
    db.close();
  }
}
