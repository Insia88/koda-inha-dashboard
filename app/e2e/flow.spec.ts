import { expect, test } from '@playwright/test';
import { loginAs, logout } from './helpers.ts';

const ADDR = 'MOCK-EVM-' + 'ABCDEF0123456789ABCDEF0123456789ABCD9876';

test('수직 흐름: 자산 확인 → 주소 등록 → 다른 승인자 확인 → 요청 작성·검토·제출 → 승인 → 처리 완료 → 감사 기록', async ({ page }) => {
  // 1) 자산 담당자: 홈에서 자산·할 일·진행 요청 확인
  await loginAs(page, '한지수');
  await expect(page.getByRole('heading', { name: '보유 자산' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '지금 처리할 일' })).toBeVisible();
  await expect(page.getByText('모의 데이터').first()).toBeVisible();

  // 2) 주소 등록: 네트워크 불일치 안내 → 올바른 주소 → 대조 확인
  await page.getByRole('link', { name: '주소록 관리' }).click();
  await page.getByRole('link', { name: '주소 등록' }).click();
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await expect(page.getByText('네트워크를 잘못 고르면')).toBeVisible();
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await page.locator('#address').fill('MOCK-BTC-ABCDEFGHJKLMNPQRSTUV');
  await expect(page.getByText(/Ethereum 형식이 아닙니다.*Bitcoin/)).toBeVisible();
  await page.locator('#address').fill(ADDR);
  await expect(page.getByText(/같은 주소 형식을 씁니다/)).toBeVisible();
  await expect(page.getByText('형식 점검은 주소의 주인이나 안전성을 확인하지 않습니다.')).toBeVisible();
  await page.getByRole('textbox', { name: /^주소 이름/ }).fill('E2E 거래처 입금 주소');
  await page.getByRole('textbox', { name: /^받는 곳/ }).fill('모의 E2E 거래처');
  await page.getByLabel(/주소 끝 6자리/).fill('000000');
  // 앞·뒤만 같게 만든 가짜 주소를 가려내기 위한 가운데 8자리 재입력(고유부 17~24번째)
  await expect(page.getByLabel('원본 주소의 가운데 8자리 (고유부 17~24번째)')).toBeVisible();
  await page.getByLabel(/가운데 8자리/).fill('ABCDEF01');
  await page.getByRole('combobox', { name: /^받은 경로/ }).selectOption('email');
  await page.getByRole('combobox', { name: /^다시 확인한 경로/ }).selectOption('registered_phone');
  await page.getByRole('textbox', { name: /^확인한 상대·연락처/ }).fill('모의 거래처 재무팀 대표번호');
  await page.getByLabel(/별도 연락 수단/).check();
  await page.getByLabel(/보증하지 않는다는/).check();
  await page.getByRole('button', { name: '확인 요청 보내기' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '끝 6자리가 주소와 다릅니다' }).first()).toBeVisible();
  await page.getByLabel(/주소 끝 6자리/).fill('CD9876');
  await page.getByRole('button', { name: '확인 요청 보내기' }).click();
  await expect(page.getByText('확인 요청을 보냈습니다')).toBeVisible();
  await expect(page.getByText('본인이 등록한 주소는 직접 확인할 수 없습니다')).toBeVisible();
  await expect(page.getByRole('button', { name: /사용 가능으로 확인/ })).toHaveCount(0);
  await logout(page);

  // 3) 다른 승인자가 주소 확인
  await loginAs(page, '오민재');
  await page.goto('/addresses?status=PENDING_REVIEW');
  await page.getByRole('link', { name: 'E2E 거래처 입금 주소' }).click();
  await page.getByLabel('원본 주소의 끝 6자리').fill('CD9876');
  await page.getByLabel(/원본 주소의 가운데 8자리/).fill('ABCDEF01');
  await page.getByRole('button', { name: /사용 가능으로 확인/ }).click();
  await expect(page.getByText('사용 가능', { exact: true }).first()).toBeVisible();
  await logout(page);

  // 4) 요청 작성 → 검토 → 승인 요청
  await loginAs(page, '한지수');
  await page.getByRole('link', { name: '출금 요청 작성' }).first().click();
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await page.getByLabel(/받는 주소/).selectOption({ label: 'E2E 거래처 입금 주소 — 모의 E2E 거래처' });
  await page.getByLabel(/수량/).fill('1.1234567');
  await page.getByRole('textbox', { name: /^요청 목적/ }).fill('E2E 정산 테스트');
  await page.getByRole('button', { name: '초안 저장 후 검토하기' }).click();
  await expect(page.getByText('소수점 아래 6자리까지만').first()).toBeVisible();
  await page.getByLabel(/수량/).fill('2500.25');
  await page.getByRole('button', { name: '초안 저장 후 검토하기' }).click();
  await expect(page.getByText('초안을 저장했습니다')).toBeVisible();
  const url = page.url();
  await page.getByRole('button', { name: '검토로 이동' }).click();
  await expect(page.getByRole('heading', { name: '최종 검토 후 승인 요청' })).toBeVisible();
  await page.reload(); // 새로고침 후에도 상태 유지
  await expect(page.getByText('검토 중').first()).toBeVisible();
  await page.getByLabel(/원본 주소의 끝 6자리/).fill('CD9876');
  await page.getByLabel(/되돌릴 수 없다는 점/).check();
  // 방금 등록한 주소라 '처음 보내는 주소입니다' 주의 항목의 진행 사유가 필요하다(WP-11).
  await page.getByRole('textbox', { name: /^진행 사유: 처음 보내는 주소입니다/ }).fill('E2E 거래처 재무팀과 전화로 주소를 대조했습니다');
  await page.getByRole('button', { name: '승인 요청 보내기' }).click();
  await expect(page.getByText('승인 대기').first()).toBeVisible();
  await expect(page.getByText('본인이 작성한 요청은 승인할 수 없습니다')).toBeVisible();
  await expect(page.getByRole('button', { name: '승인', exact: true })).toHaveCount(0);
  await logout(page);

  // 5) 승인자: 체크리스트 후 승인 → 모의 처리 완료
  await loginAs(page, '오민재');
  await page.goto(url);
  const approve = page.getByRole('button', { name: '승인', exact: true });
  await expect(approve).toBeDisabled();
  await page.getByLabel(/받는 곳과 목적이/).check();
  await page.getByLabel(/근거 문서와 같습니다/).check();
  await page.getByLabel(/앞·뒤 묶음과 네트워크/).check();
  await approve.click();
  await expect(page.getByText('처리 중').first()).toBeVisible();
  await expect(page.getByText('처리 완료').first()).toBeVisible({ timeout: 15_000 });
  await logout(page);

  // 6) 감사 담당자: 기록 확인, 무결성 표시
  await loginAs(page, '문태호');
  await page.goto('/audit?q=' + encodeURIComponent('E2E'));
  await expect(page.getByText('무결성 확인됨')).toBeVisible();
  await expect(page.getByText(/주소 등록 요청: E2E 거래처 입금 주소/)).toBeVisible();
  await page.goto('/audit');
  await expect(page.getByRole('cell', { name: /처리 완료 \(모의\)/ }).first()).toBeVisible();
});

test('반려 사유 필수와 반려 결과 표시', async ({ page }) => {
  await loginAs(page, '서예린');
  await page.goto('/requests?view=to_approve');
  await page.getByRole('link', { name: /WR-000004/ }).click();
  await page.getByRole('button', { name: '반려' }).click();
  await expect(page.getByText('반려 사유를 5자 이상').first()).toBeVisible();
  await page.getByLabel('반려 사유').fill('그룹사 이전 승인 문서가 첨부되지 않았습니다');
  await page.getByRole('button', { name: '반려' }).click();
  await expect(page.getByText('반려', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('그룹사 이전 승인 문서가 첨부되지 않았습니다').first()).toBeVisible();
});

test('목록: 필터·빈 결과·마지막 페이지·상세 복귀 시 상태 유지', async ({ page }) => {
  await loginAs(page, '한지수');
  // 시드는 137건이며, 앞선 테스트에서 처리 완료된 출금이 추가될 수 있어 서버 값으로 기대치를 계산한다.
  const total: number = (await (await page.request.get('/api/activity?pageSize=25')).json()).total;
  expect(total).toBeGreaterThanOrEqual(137);
  const lastFrom = Math.floor((total - 1) / 25) * 25 + 1;
  await page.goto('/activity');
  await expect(page.getByText(`전체 ${total}건 중 1–25`)).toBeVisible();
  await page.getByRole('button', { name: '마지막 페이지' }).click();
  await expect(page.getByText(`전체 ${total}건 중 ${lastFrom}–${total}`)).toBeVisible();
  await expect(page.getByRole('button', { name: '다음 페이지' })).toBeDisabled();
  await page.getByRole('button', { name: '첫 페이지' }).click();
  await expect(page.getByRole('button', { name: '이전 페이지' })).toBeDisabled();
  await page.getByLabel('종류').selectOption('withdrawal');
  await expect(page).toHaveURL(/type=withdrawal/);
  await expect(page).not.toHaveURL(/page=/);
  await page.getByPlaceholder('상대방·거래 참조로 검색').fill('존재하지않는상대방');
  await expect(page.getByText('조건에 맞는 기록이 없습니다')).toBeVisible();
  await page.getByRole('button', { name: '필터 초기화' }).first().click();
  await expect(page.getByText(`전체 ${total}건 중 1–25`)).toBeVisible();

  await page.goto('/addresses');
  await page.getByLabel('상태').selectOption('ACTIVE');
  await page.getByPlaceholder('이름·받는 곳·주소 일부로 검색').fill('거래소');
  await expect(page).toHaveURL(/q=%EA%B1%B0%EB%9E%98%EC%86%8C/); // 검색어는 300ms 뒤 확정되어 URL에 저장된다
  await expect(page.getByText(/조건에 맞는 주소 \d+개/)).toBeVisible();
  await page.getByRole('link', { name: /모의 거래소 A 입금 \(USDC\)/ }).click();
  await page.getByRole('link', { name: '← 주소록' }).click();
  await expect(page).toHaveURL(/status=ACTIVE/);
  await expect(page.getByPlaceholder('이름·받는 곳·주소 일부로 검색')).toHaveValue('거래소');
});

test('권한: 메뉴에 없는 화면은 서버·화면 모두 거부, 다른 조직 데이터 격리', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/audit');
  await expect(page.getByText('이 화면을 볼 권한이 없습니다.')).toBeVisible();
  await expect(page.getByRole('link', { name: '감사 기록' })).toHaveCount(0);
  const res = await page.request.get('/api/audit');
  expect(res.status()).toBe(403);
  await logout(page);
  await loginAs(page, '배서준');
  await page.goto('/requests/wr-3');
  await expect(page.getByText('요청을(를) 찾을 수 없습니다.')).toBeVisible();
  await page.goto('/staking');
  await expect(page.getByText('스테이킹 중인 자산이 없습니다')).toBeVisible();
});

test('키보드: 건너뛰기 링크와 포커스 표시, 세션 만료 후 복귀', async ({ page, context }) => {
  await loginAs(page, '한지수');
  await page.goto('/requests');
  await expect(page.getByRole('heading', { name: '결재 및 요청' })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: '본문으로 건너뛰기' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await context.clearCookies();
  await page.goto('/addresses?status=ACTIVE');
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByRole('button', { name: /^한지수/ }).click();
  await expect(page).toHaveURL(/\/addresses\?status=ACTIVE/);
});

test('Market Insight: 출처·발행일·원문·고지, 더 보기', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/insights');
  await expect(page.getByText('투자 권유가 아닙니다')).toBeVisible();
  await expect(page.getByText(/24건 중 12건/)).toBeVisible();
  const first = page.locator('.insight').first();
  await expect(first.locator('.insight-provider')).toHaveText(/모의 리서치/);
  await expect(first.getByText(/^발행 \d{4}-\d{2}-\d{2}$/)).toBeVisible();
  await expect(first.getByRole('link')).toHaveAttribute('target', '_blank');
  await expect(page.getByText('화이트리스트 외 기관 자료')).toHaveCount(0);
  await page.getByRole('button', { name: '자료 더 보기' }).click();
  await expect(page.getByText(/24건 중 24건/)).toBeVisible();
  await expect(page.getByText('마지막 자료입니다.')).toBeVisible();
  await page.getByRole('button', { name: '모의 리서치 B' }).click();
  await expect(page.getByText(/8건 중 8건/)).toBeVisible();
});