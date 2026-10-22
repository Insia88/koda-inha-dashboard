import { expect, test, type Page } from '@playwright/test';
import { loginAs } from './helpers.ts';

// 검수 review-20261019-0230 대응: 인사이트 게시 폼의 메타데이터(제공 기관·발행일·언어)만 바꾼 경우에도 작성 중 보호.

const OPERATOR = 'KODA 운영 담당';
const guardDialog = (page: Page) => page.getByRole('alertdialog', { name: '작성 중인 내용이 있습니다' });
const activeDialog = (page: Page) => page.locator('dialog[open]');
const provider = (page: Page) => page.getByRole('combobox', { name: /^제공 기관/ });
const published = (page: Page) => page.getByLabel(/^발행일/);
const language = (page: Page) => page.getByRole('combobox', { name: /^언어/ });
const leaveLink = (page: Page) => page.getByRole('link', { name: '마켓 인사이트' });

async function openManage(page: Page) {
  await page.goto('/insights/manage');
  await expect(page.getByRole('heading', { name: '자료 게시' })).toBeVisible();
}

test('메타데이터만 변경: 기관·발행일·언어 각각 이탈 확인, 계속 작성 시 값 유지, 버리기 시 이동', async ({ page }) => {
  await loginAs(page, OPERATOR);
  // 최초 렌더(기본 발행일·언어)는 작성 중이 아니다
  await openManage(page);
  await leaveLink(page).click();
  await expect(page).toHaveURL(/\/insights$/);
  await expect(activeDialog(page)).toHaveCount(0);

  const cases: { name: string; change: () => Promise<void>; check: () => Promise<void> }[] = [
    { name: '기관', change: () => provider(page).selectOption('prov-b').then(() => {}), check: () => expect(provider(page)).toHaveValue('prov-b') },
    { name: '발행일', change: () => published(page).fill('2026-10-01'), check: () => expect(published(page)).toHaveValue('2026-10-01') },
    { name: '언어', change: () => language(page).selectOption('en').then(() => {}), check: () => expect(language(page)).toHaveValue('en') },
  ];
  for (const c of cases) {
    await openManage(page);
    await c.change();
    await leaveLink(page).click();
    const dlg = guardDialog(page);
    await expect(dlg, c.name).toBeVisible();
    await expect(dlg.getByRole('button', { name: '계속 작성' })).toBeFocused();
    await dlg.getByRole('button', { name: '계속 작성' }).click();
    await expect(page).toHaveURL(/\/insights\/manage$/);
    await c.check();
    // 본문은 여전히 비어 있다(메타데이터만 변경한 상태 유지)
    await expect(page.getByRole('textbox', { name: /^제목/ })).toHaveValue('');
    await leaveLink(page).click();
    await guardDialog(page).getByRole('button', { name: '작성 내용 버리기' }).click();
    await expect(page).toHaveURL(/\/insights$/);
  }

  // 바꿨다가 기준값으로 되돌리면 다시 깨끗하다(가짜 경고 없음)
  await openManage(page);
  await language(page).selectOption('en');
  await language(page).selectOption('ko');
  await leaveLink(page).click();
  await expect(page).toHaveURL(/\/insights$/);
  await expect(activeDialog(page)).toHaveCount(0);
});

for (const [name, change] of [
  ['기관', (p: Page) => provider(p).selectOption('prov-c')],
  ['발행일', (p: Page) => published(p).fill('2026-09-30')],
  ['언어', (p: Page) => language(p).selectOption('en')],
] as const) {
  test(`메타데이터(${name})만 변경해도 창 닫기 beforeunload`, async ({ page }) => {
    await loginAs(page, OPERATOR);
    await openManage(page);
    await change(page);
    const seen: string[] = [];
    page.on('dialog', async (d) => { seen.push(d.type()); await d.accept(); });
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => seen).toContain('beforeunload');
  });
}

test('인사이트 관리 화면은 깨끗할 때 beforeunload가 뜨지 않는다', async ({ page }) => {
  await loginAs(page, OPERATOR);
  await openManage(page);
  await provider(page).click();
  const seen: string[] = [];
  page.on('dialog', async (d) => { seen.push(d.type()); await d.accept(); });
  await page.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 500));
  expect(seen).toEqual([]);
});

test('게시 실패 뒤 입력·보호 유지, 게시 중 입력 잠금, 성공 뒤 유지한 메타데이터가 새 기준(경고 없음)', async ({ page }) => {
  await loginAs(page, OPERATOR);
  await openManage(page);
  const stamp = Date.now();
  const title = page.getByRole('textbox', { name: /^제목/ });
  await provider(page).selectOption('prov-a');
  await published(page).fill('2026-10-02');
  await language(page).selectOption('en');
  await title.fill(`E2E 보호 확인 ${stamp}`);
  await page.getByRole('textbox', { name: /^요약/ }).fill('E2E 모의 요약');
  await page.getByRole('textbox', { name: /^원문 주소/ }).fill(`https://example.com/mock-research/e2e-${stamp}`);

  // 서버 오류 → 입력과 보호 유지
  await page.route('**/api/insights', (r) => (r.request().method() === 'POST'
    ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '처리 중 오류가 발생했습니다.', action: '잠시 후 다시 시도하세요.' }, requestId: 'ffff0000aaaa' }) })
    : r.continue()));
  await page.getByRole('button', { name: '게시', exact: true }).click();
  await expect(page.getByText('요청 번호 ffff0000')).toBeVisible();
  await page.unroute('**/api/insights');
  await expect(title).toHaveValue(`E2E 보호 확인 ${stamp}`);
  await expect(provider(page)).toHaveValue('prov-a');
  await expect(published(page)).toHaveValue('2026-10-02');
  await expect(language(page)).toHaveValue('en');
  await leaveLink(page).click();
  await expect(guardDialog(page)).toBeVisible();
  await guardDialog(page).getByRole('button', { name: '계속 작성' }).click();
  await expect(page).toHaveURL(/\/insights\/manage$/);

  // 게시 중에는 입력이 잠겨 성공 뒤 초기화가 새 입력을 지우지 않는다
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/insights', async (r) => { if (r.request().method() === 'POST') await gate; await r.continue(); });
  await page.getByRole('button', { name: '게시', exact: true }).click();
  await expect(page.getByRole('button', { name: '게시 중…' })).toBeDisabled();
  await expect(title).toBeDisabled();
  await expect(provider(page)).toBeDisabled();
  await expect(published(page)).toBeDisabled();
  release();
  await expect(page.getByText('자료를 게시했습니다')).toBeVisible();
  await page.unroute('**/api/insights');
  await expect(title).toBeEnabled();
  await expect(title).toHaveValue('');
  // 연속 게시를 위해 유지한 메타데이터는 새 깨끗한 기준
  await expect(provider(page)).toHaveValue('prov-a');
  await expect(published(page)).toHaveValue('2026-10-02');
  await expect(language(page)).toHaveValue('en');
  await expect(page.getByRole('cell', { name: `E2E 보호 확인 ${stamp}` })).toBeVisible();

  // 새 기준에서 다시 바꾸면 보호, 성공 안내는 새 작성 중에는 숨김
  await language(page).selectOption('ko');
  await expect(page.getByText('자료를 게시했습니다')).toHaveCount(0);
  await leaveLink(page).click();
  await expect(guardDialog(page)).toBeVisible();
  await guardDialog(page).getByRole('button', { name: '계속 작성' }).click();
  await language(page).selectOption('en');
  // 기준으로 되돌리면 경고 없이 이동
  await leaveLink(page).click();
  await expect(page).toHaveURL(/\/insights$/);
  await expect(activeDialog(page)).toHaveCount(0);
});
