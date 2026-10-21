import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { loginAs, logout } from './helpers.ts';
import { middleSegment } from '../shared/address-rules.ts';

test('수직 흐름: 자산 확인 → 주소 등록 → 다른 승인자 확인 → 요청 작성·검토·제출 → 승인 → 처리 완료 → 감사 기록', async ({ page }) => {
  // 같은 DB에서 다시 돌려도(--repeat-each, A2b 간헐 실패 확인) 앞 실행의 주소·이름과 겹치지 않게 실행마다 새 주소와 이름을 쓴다.
  // 다시 입력할 끝 6자리와 가운데 8자리(MOCK-EVM- 뒤 17~24번째 글자)는 그 주소에서 계산한다.
  const ADDR = `MOCK-EVM-${randomBytes(20).toString('hex').toUpperCase()}`;
  const TAIL = ADDR.slice(-6);
  const MIDDLE = middleSegment(ADDR).text;
  const LABEL = `E2E 거래처 입금 주소 ${ADDR.slice(9, 13)}`;
  // 1) 자산 담당자: 홈에서 자산·할 일·진행 요청 확인
  await loginAs(page, '한지수');
  await expect(page.getByRole('heading', { name: '보유 자산' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '지금 처리할 일' })).toBeVisible();
  await expect(page.getByText('모의 데이터').first()).toBeVisible();

  // 2) 주소 등록: 네트워크 불일치 안내 → 올바른 주소 → 대조 확인
  await page.getByRole('link', { name: '보낼 곳 주소록' }).click();
  await page.getByRole('link', { name: '주소 등록' }).click();
  // 다음 화면 제목이 보인 뒤에 고른다. 그 전에는 떠나는 주소록의 '자산' 필터도 같은 이름으로 잡힐 수 있다(A2b, docs/traceability.md).
  await expect(page.getByRole('heading', { name: '주소 등록', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await expect(page.getByText('네트워크를 잘못 고르면')).toBeVisible();
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await expect(page.getByText('거래처 안내문의 네트워크 이름이 이 목록과 다르면, 거래처에 어느 블록체인 네트워크로 받는지 물어 확인하세요.', { exact: false })).toBeVisible();
  await page.locator('#address').fill('MOCK-BTC-ABCDEFGHJKLMNPQRSTUV');
  await expect(page.getByText(/Ethereum 형식이 아닙니다.*Bitcoin/)).toBeVisible();
  await page.locator('#address').fill(ADDR);
  await expect(page.getByText(/같은 주소 형식을 씁니다/)).toBeVisible();
  await expect(page.getByText('형식 점검은 주소의 주인이나 안전성을 확인하지 않습니다.')).toBeVisible();
  await page.getByRole('textbox', { name: /^주소 이름/ }).fill(LABEL);
  await page.getByRole('textbox', { name: /^받는 곳/ }).fill('모의 E2E 거래처');
  await page.getByLabel(/주소 끝 6자리/).fill('000000');
  // 앞·뒤만 같게 만든 가짜 주소를 가려내기 위한 가운데 8자리 재입력(접두 MOCK-EVM- 뒤 17~24번째 글자)
  await expect(page.getByLabel('원본 주소의 가운데 8자리 (MOCK-EVM- 뒤 17~24번째 글자)')).toBeVisible();
  await page.getByLabel(/가운데 8자리/).fill(MIDDLE);
  await page.getByRole('combobox', { name: /^받은 경로/ }).selectOption('email');
  await page.getByRole('combobox', { name: /^다시 확인한 경로/ }).selectOption('registered_phone');
  await page.getByRole('textbox', { name: /^확인한 상대·연락처/ }).fill('모의 거래처 재무팀 대표번호');
  await page.getByLabel(/별도 연락 수단/).check();
  await page.getByLabel(/보증하지 않는다는/).check();
  await page.getByRole('button', { name: '주소 등록', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '끝 6자리가 주소와 다릅니다' }).first()).toBeVisible();
  await page.getByLabel(/주소 끝 6자리/).fill(TAIL);
  await page.getByRole('button', { name: '주소 등록', exact: true }).click();
  // 등록 직후에는 다음 단계 안내 하나만 보인다: 알림이 가지 않는다는 점과, 등록자가 아닌 승인자가 확인해야 한다는 점(A1).
  const created = page.getByRole('status').filter({ hasText: '주소를 등록했습니다 — 다른 승인자의 확인이 필요합니다' });
  await expect(created).toBeVisible();
  await expect(created).toContainText('이 대시보드는 알림을 보내지 않습니다. 확인할 승인자에게 직접 알려 주세요.');
  await expect(created).toContainText('등록자가 아닌 승인자가 원본과 대조해 확인하면');
  await expect(page.getByText('본인이 등록한 주소는 직접 확인할 수 없습니다')).toHaveCount(0);
  await expect(page.getByText('확인 요청을 보냈습니다')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /보내기/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /사용 가능으로 확인/ })).toHaveCount(0);
  // 나중에 다시 열면 등록자에게 직접 확인할 수 없다는 안내가 보이고, 확인 버튼은 여전히 없다.
  await page.goto('/addresses?status=PENDING_REVIEW');
  await page.getByRole('link', { name: LABEL }).click();
  await expect(page.getByText('본인이 등록한 주소는 직접 확인할 수 없습니다. 등록자가 아닌 승인자가 확인해야 합니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: /사용 가능으로 확인/ })).toHaveCount(0);
  await logout(page);

  // 3) 다른 승인자가 주소 확인
  await loginAs(page, '오민재');
  await page.goto('/addresses?status=PENDING_REVIEW');
  await page.getByRole('link', { name: LABEL }).click();
  await page.getByLabel('원본 주소의 끝 6자리').fill(TAIL);
  await page.getByLabel(/원본 주소의 가운데 8자리/).fill(MIDDLE);
  await page.getByRole('button', { name: /사용 가능으로 확인/ }).click();
  await expect(page.getByText('사용 가능', { exact: true }).first()).toBeVisible();
  await logout(page);

  // 4) 요청 작성 → 검토 → 승인 요청
  await loginAs(page, '한지수');
  await page.getByRole('link', { name: '출금 요청 작성' }).first().click();
  await expect(page.getByRole('heading', { name: '출금 요청 작성', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await expect(page.getByText('거래처 안내문의 네트워크 이름이 이 목록과 다르면, 거래처에 어느 블록체인 네트워크로 받는지 물어 확인하세요.', { exact: false })).toBeVisible();
  await page.getByLabel(/받는 주소/).selectOption({ label: `${LABEL} — 모의 E2E 거래처` });
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
  await page.getByLabel(/원본 주소의 끝 6자리/).fill(TAIL);
  await page.getByLabel(/되돌릴 수 없다는 점/).check();
  // 방금 등록한 주소라 '이 대시보드로 처음 보내는 주소입니다' 주의 항목의 진행 사유가 필요하다(WP-11).
  await page.getByRole('textbox', { name: /^진행 사유: 이 대시보드로 처음 보내는 주소입니다/ }).fill('E2E 거래처 재무팀과 전화로 주소를 대조했습니다');
  await page.getByRole('button', { name: '승인 요청 보내기' }).click();
  await expect(page.getByText('승인 대기').first()).toBeVisible();
  await expect(page.getByText('본인이 작성한 요청은 승인할 수 없습니다')).toBeVisible();
  await expect(page.getByRole('button', { name: /^승인(하고 처리 시작)?$/ })).toHaveCount(0); // 승인 버튼은 어느 이름(승인·승인하고 처리 시작)으로도 없다
  await logout(page);

  // 5) 승인자: 체크리스트 후 승인 → 모의 처리 완료
  await loginAs(page, '오민재');
  await page.goto(url);
  // 필요 승인 1명인 요청이라 이번 승인이 마지막이다: 버튼 이름이 처리 시작을 말한다(A1).
  const approve = page.getByRole('button', { name: '승인하고 처리 시작', exact: true });
  await expect(approve).toBeDisabled();
  await expect(page.getByRole('button', { name: '승인', exact: true })).toHaveCount(0);
  await page.getByLabel(/받는 곳과 목적이/).check();
  await page.getByLabel(/근거 문서와 같습니다/).check();
  await page.getByLabel(/앞·뒤 묶음과 네트워크/).check();
  await approve.click();
  await expect(page.getByText('처리 중').first()).toBeVisible();
  // 레일 설명(A1)에도 '처리 완료'라는 낱말이 있으므로 상태 배지로 완료를 기다린다.
  await expect(page.locator('.page-header .badge')).toHaveText('처리 완료', { timeout: 15_000 });
  // 결정 카드가 말한 대로 자산 활동 내역에 출금으로 기록된다(A1-06의 안내 문장과 같은 기존 동작).
  await page.goto('/activity?type=withdrawal');
  await expect(page.getByRole('row').filter({ hasText: LABEL }).first()).toBeVisible();
  await logout(page);

  // 6) 감사 담당자: 기록 확인, 무결성 표시
  await loginAs(page, '문태호');
  await page.goto('/audit?q=' + encodeURIComponent('E2E'));
  await expect(page.getByText('무결성 확인됨')).toBeVisible();
  await expect(page.getByText(`주소 등록 요청: ${LABEL}`)).toBeVisible();
  await page.goto('/audit');
  await expect(page.getByRole('cell', { name: /처리 완료 \(모의\)/ }).first()).toBeVisible();
});

test('반려 사유 필수와 반려 결과 표시', async ({ page }) => {
  const serverStatus = async () => (await (await page.request.get('/api/requests/wr-4')).json()).status as string;
  await loginAs(page, '서예린');
  await page.goto('/requests?view=to_approve');
  await page.getByRole('link', { name: /WR-000004/ }).click();
  await expect(page).toHaveURL(/\/requests\/wr-4$/);
  const rejectButton = page.getByRole('button', { name: '반려', exact: true });
  await rejectButton.click();
  await expect(page.getByText('반려 사유를 5자 이상').first()).toBeVisible();
  expect(await serverStatus()).toBe('PENDING_APPROVAL');

  const reason = '그룹사 이전 승인 문서가 첨부되지 않았습니다';
  await page.getByLabel('반려 사유').fill(reason);
  await rejectButton.click();
  // 반려가 실제로 처리된 뒤에만 생기는 표시를 본다. '반려' 글자와 사유 문구는 결정 전에도
  // 반려 버튼과 방금 채운 입력란에 있으므로 그것만으로는 반려가 실패해도 통과한다.
  const rejectedNotice = page.locator('.notice-danger').filter({ has: page.locator('.notice-title', { hasText: /^반려 사유$/ }) });
  await expect(rejectedNotice).toContainText(reason);
  // 결정 카드(누른 반려 버튼)가 사라지므로 화면 위쪽의 결과 안내로 포커스가 옮겨지고, 그 안내가 화면 안에 보인다.
  const rejectedResult = page.getByRole('status').filter({ hasText: '반려했습니다' });
  await expect(rejectedResult).toBeVisible();
  await expect(rejectedResult).toContainText('승인 요청 때 예약한 수량이 풀렸습니다');
  await expect(page.locator('.rc-focus-target').filter({ has: rejectedResult })).toBeFocused();
  await expect(rejectedResult).toBeInViewport();
  await expect(page.locator('.page-header .badge')).toHaveText('반려');
  await expect(page.getByRole('button', { name: '반려', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('반려 사유')).toHaveCount(0);
  await expect.poll(serverStatus).toBe('REJECTED');
});

test('목록: 필터·빈 결과·마지막 페이지·상세 복귀 시 상태 유지', async ({ page }) => {
  await loginAs(page, '한지수');
  // 시드는 138건(0원 입금 예시 1건 포함)이며, 앞선 테스트에서 처리 완료된 출금이 추가될 수 있어 서버 값으로 기대치를 계산한다.
  const total: number = (await (await page.request.get('/api/activity?pageSize=25')).json()).total;
  expect(total).toBeGreaterThanOrEqual(138);
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