import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, logout } from './helpers.ts';

// A1(화면 문구·배치만 바꾸고 서버·정책·안전 장치는 그대로): 머리글 출금 요청 버튼, 메뉴 묶음·이름, 종류별 배지와 탭 건수,
// 홈 할 일 문장, 결정 카드 요약·마지막 승인 표시, 점검 목록 순서와 접힌 '기준 이내', 관리자 안내, 역할 변경 영향 안내, 자주 묻는 질문.
// 이 파일은 파일 이름 순서상 가장 먼저 돈다. 바꾸는 데이터는 이 파일에서 만든 ETH 요청(끝에 취소)과
// 모의법인 B 임하은의 역할(승인자를 뺐다가 다시 준다)뿐이다. 시드 요청·주소는 읽기만 한다.

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const BOTH_APPROVE = /^승인(하고 처리 시작)?$/;
const headerSend = (page: Page) => page.getByRole('banner').getByRole('link', { name: '출금 요청 작성' });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function apiPost(page: Page, url: string, body: unknown) {
  const me = await (await page.request.get('/api/me')).json();
  const res = await page.request.post(url, { data: body, headers: { 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  const json = await res.json();
  expect(res.ok(), `${url} ${JSON.stringify(json)}`).toBeTruthy();
  return json;
}

/** 메뉴 묶음 제목과 항목 이름(보이는 글자)을 화면 순서대로 */
const menu = (page: Page) => page.locator('#sidenav .nav-group').evaluateAll((groups) => groups.map((g) => ({
  title: g.querySelector('.nav-title')?.textContent?.trim() ?? '',
  items: [...g.querySelectorAll('.nav-label')].map((e) => e.textContent?.trim() ?? ''),
})));

const dashboardTasks = async (page: Page) => ((await (await page.request.get('/api/dashboard')).json()).tasks as { kind: string; count: number }[]);

test.describe('머리글 출금 요청 작성(A1-01)', () => {
  const PATHS = ['/', '/balances', '/activity', '/addresses', '/requests', '/requests/wr-4'];
  for (const user of ['한지수', '강도윤', '배서준']) {
    test(`${user}: 어느 화면에서나 머리글에 하나, 1440px·390px`, async ({ page }) => {
      await loginAs(page, user);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
        for (const path of PATHS) {
          await page.goto(path);
          await page.locator('#page-title, main [role="alert"]').first().waitFor();
          await expect(headerSend(page), `${width}px ${path}`).toHaveCount(1);
          await expect(headerSend(page), `${width}px ${path}`).toBeVisible();
          // 화면 안에 같은 이름의 링크가 또 있지 않다(홈·결재 및 요청의 머리 버튼은 머리글로 옮겼다).
          await expect(page.getByRole('link', { name: '출금 요청 작성', exact: true }), `${width}px ${path}`).toHaveCount(1);
          expect(await overflow(page), `${width}px ${path}`).toBeLessThanOrEqual(0);
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/balances');
      await headerSend(page).click();
      await expect(page).toHaveURL(/\/requests\/new$/);
      await expect(page.getByRole('heading', { name: '출금 요청 작성', level: 1 })).toBeVisible();
      await expect(headerSend(page)).toHaveCount(0); // 작성 화면 자체에는 두지 않는다
    });
  }

  test('요청 권한이 없는 사람(승인자·감사 담당자·조직 관리자·KODA 운영)에게는 없다', async ({ page }) => {
    for (const user of ['오민재', '서예린', '문태호', '윤가람', '조은비', 'KODA 운영 담당']) {
      await loginAs(page, user);
      await page.locator('#page-title').waitFor();
      await expect(page.getByRole('banner')).toBeVisible();
      await expect(headerSend(page), user).toHaveCount(0);
      await expect(page.getByRole('link', { name: /출금 요청 작성/ }), user).toHaveCount(0);
      await logout(page);
    }
  });

  test('작성 중인 반려 사유가 있으면 머리글 버튼도 이탈 확인을 거치고, 계속 작성은 입력을 지킨다(강도윤: 승인자이자 자산 담당자)', async ({ page }) => {
    await loginAs(page, '강도윤');
    await page.goto('/requests/wr-3');
    const reason = page.getByLabel('반려 사유');
    await reason.fill('정산서 금액을 다시 확인해 주세요');
    await headerSend(page).click();
    const dlg = page.getByRole('alertdialog', { name: '작성 중인 내용이 있습니다' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('button', { name: '계속 작성' })).toBeFocused();
    await dlg.getByRole('button', { name: '계속 작성' }).click();
    await expect(page).toHaveURL(/\/requests\/wr-3$/);
    await expect(reason).toHaveValue('정산서 금액을 다시 확인해 주세요');
    await headerSend(page).click();
    await dlg.getByRole('button', { name: '작성 내용 버리기' }).click();
    await expect(page).toHaveURL(/\/requests\/new$/);
  });

  test('휴대폰 폭(380·390·393px)에서 조직명이 잘리지 않는다: 머리글 버튼은 + 아이콘 없이 \'출금 요청\'만', async ({ page }) => {
    // 모의법인 A(한지수)와 모의법인 B(배서준): 두 조직 이름이 '모의법…'으로 같아 보이면 어느 회사로 보내는지 헷갈린다.
    for (const user of ['한지수', '배서준']) {
      await loginAs(page, user);
      await page.locator('#page-title').waitFor();
      for (const width of [380, 390, 393]) {
        await page.setViewportSize({ width, height: 844 });
        const m = await page.evaluate(() => {
          const name = document.querySelector('.topbar .org-name-text') as HTMLElement;
          const icon = document.querySelector('.topbar-send svg') as SVGElement;
          return { text: name.textContent, client: name.clientWidth, scroll: name.scrollWidth, icon: getComputedStyle(icon).display };
        });
        expect(m.scroll, `${user} ${width}px 조직명 '${m.text}' ${m.client}/${m.scroll}`).toBeLessThanOrEqual(m.client);
        expect(m.icon, `${user} ${width}px`).toBe('none');
        await expect(headerSend(page).locator('.topbar-send-text'), `${user} ${width}px`).toBeVisible();
        expect(await overflow(page), `${user} ${width}px`).toBeLessThanOrEqual(0);
      }
      // 380px 아래(아이콘만 남는 폭)에서는 + 아이콘이 다시 보인다.
      await page.setViewportSize({ width: 375, height: 812 });
      expect(await page.locator('.topbar-send svg').evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
      await page.setViewportSize({ width: 1440, height: 900 });
      await logout(page);
    }
  });

  test('접근성 자동 검사: 머리글 버튼이 있는 홈·잔고(1440px·390px)', async ({ page }) => {
    await loginAs(page, '한지수');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ['/', '/balances']) {
        await page.goto(path);
        await page.locator('#page-title').waitFor();
        await page.waitForLoadState('networkidle');
        const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(r.violations.map((v) => `${width}px ${path} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
      }
    }
  });
});

test('메뉴(A1-02): 방향과 쓰임을 말하는 이름, 참고 묶음, 경로·깊은 링크는 그대로', async ({ page }) => {
  await loginAs(page, '강도윤');
  expect(await menu(page)).toEqual([
    { title: '', items: ['홈'] },
    { title: '업무', items: ['결재 및 요청', '보낼 곳 주소록'] },
    { title: '자산', items: ['잔고', '자산 활동 내역'] },
    { title: '참고', items: ['우리 회사 입금 주소', '스테이킹 현황', '지원 자산·네트워크'] },
    { title: '관리', items: ['조직 관리'] },
    { title: '정보', items: ['마켓 인사이트'] },
  ]);
  // 이름을 바꾼 네 화면: 경로는 그대로, 화면 제목(h1)과 문서 제목은 메뉴 이름과 같다.
  for (const [path, label] of [['/addresses', '보낼 곳 주소록'], ['/wallets', '우리 회사 입금 주소'], ['/staking', '스테이킹 현황'], ['/tokens', '지원 자산·네트워크']] as const) {
    await page.locator('#sidenav').getByRole('link', { name: label }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(label);
    await expect(page).toHaveTitle(`${label} · KODA 법인 대시보드 (개발 환경)`);
  }
  await page.goto('/wallets');
  await expect(page.locator('.page-desc')).toHaveText('다른 곳에서 우리 회사로 입금받을 때 알려 줄 주소입니다(KODA가 보관하는 조직 지갑). 네트워크가 맞는 지갑의 주소를 알려 주세요.');
  // 네트워크 불일치 고지는 접지 않고 그대로다(DESIGN.md 중요 고지).
  await expect(page.getByText('입금 주소를 알려 줄 때 네트워크도 함께 알려 주세요')).toBeVisible();
  // 깊은 링크
  await page.goto('/addresses?status=COOLING_DOWN');
  await expect(page.getByRole('combobox', { name: '상태' })).toHaveValue('COOLING_DOWN');
  await expect(page.getByRole('heading', { name: '보낼 곳 주소록', level: 1 })).toBeVisible();
  await page.goto('/requests?view=to_approve');
  await expect(page.getByRole('tab', { selected: true })).toHaveText(/^내가 승인할 요청/);
  await logout(page);

  // 다른 역할은 권한으로 걸러진다: 승인자(오민재)는 같은 순서에서 자기 권한의 항목만 본다.
  await loginAs(page, '오민재');
  expect(await menu(page)).toEqual([
    { title: '', items: ['홈'] },
    { title: '업무', items: ['결재 및 요청', '보낼 곳 주소록'] },
    { title: '자산', items: ['잔고', '자산 활동 내역'] },
    { title: '참고', items: ['우리 회사 입금 주소', '스테이킹 현황', '지원 자산·네트워크'] },
    { title: '관리', items: ['조직 관리'] },
    { title: '정보', items: ['마켓 인사이트'] },
  ]);
  await logout(page);
  // KODA 운영: 고객 업무·자산·관리 메뉴는 없다. 운영자는 자산 목록 조회 권한(catalog.read)이 있어 '참고'의 지원 자산·네트워크가 보인다(이전 '토큰 목록'과 같은 권한).
  await loginAs(page, 'KODA 운영 담당');
  expect(await menu(page)).toEqual([
    { title: '참고', items: ['지원 자산·네트워크'] },
    { title: '정보', items: ['마켓 인사이트', '인사이트 자료 관리'] },
  ]);
});

test('390px 메뉴(A1-02): 보낼 곳 주소록은 메뉴를 열기 전에는 숨고, 열고 닫을 수 있고, 메뉴가 넘치지 않는다', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, '강도윤');
  const link = page.locator('#sidenav').getByRole('link', { name: /보낼 곳 주소록/ });
  await expect(link).toBeHidden();
  await page.getByRole('button', { name: '메뉴 열기' }).click();
  await expect(link).toBeVisible();
  const right = await page.locator('#sidenav').evaluate((nav) => Math.max(...[...nav.querySelectorAll('.nav-link, .nav-badge')].map((e) => e.getBoundingClientRect().right)));
  const navRight = await page.locator('#sidenav').evaluate((nav) => nav.getBoundingClientRect().right);
  expect(right).toBeLessThanOrEqual(navRight);
  // 열린 메뉴 바깥(어두운 바탕)을 누르면 닫힌다(기존 동작). 메뉴 링크를 누르면 이동하면서 닫힌다.
  await page.mouse.click(360, 600);
  await expect(link).toBeHidden();
  await page.getByRole('button', { name: '메뉴 열기' }).click();
  await link.click();
  await expect(page.getByRole('heading', { name: '보낼 곳 주소록', level: 1 })).toBeVisible();
  await expect(link).toBeHidden();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

test('내 차례(A1-03): 종류별 배지와 탭 건수는 서버 할 일 건수와 같고, 상태 옆에 누구 차례인지 보인다', async ({ page }) => {
  // 강도윤(승인자 + 자산 담당자)에게 초안 하나를 만들어 두 종류의 배지가 함께 보이게 한다(끝에 취소).
  await loginAs(page, '강도윤');
  const draft = await apiPost(page, '/api/requests', { assetCode: 'ETH', networkCode: 'ETHEREUM', addressId: 'ab-05', amount: '0.01', purpose: 'E2E A1 배지 확인용 초안' });
  try {
    await page.goto('/');
    const tasks = await dashboardTasks(page);
    const a = tasks.find((t) => t.kind === 'approve_requests')!.count;
    const b = tasks.find((t) => t.kind === 'my_drafts')!.count;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    const link = page.locator('#sidenav').getByRole('link', { name: /결재 및 요청/ });
    await expect(link.locator('.nav-badge')).toHaveText([`승인 ${a}`, `제출 전 ${b}`]);
    await expect(link).toHaveAccessibleName(new RegExp(`^결재 및 요청\\s*처리할 일 ${a + b}건: 승인할 요청 ${a}건, 제출 전 내 요청 ${b}건$`));
    const fit = await link.evaluate((el) => ({ right: el.getBoundingClientRect().right, nav: el.closest('nav')!.getBoundingClientRect().right, badges: [...el.querySelectorAll('.nav-badge')].map((x) => x.getBoundingClientRect().right) }));
    for (const r of fit.badges) expect(r).toBeLessThanOrEqual(fit.right);
    expect(fit.right).toBeLessThanOrEqual(fit.nav);

    // 탭 건수: '내가 승인할 요청 a'는 그 탭 목록의 전체 건수와 같다. 탭을 누르면 view가 바뀐다(순서·기본 보기 그대로).
    const toApprove = await (await page.request.get('/api/requests?view=to_approve&pageSize=10')).json();
    expect(toApprove.total).toBe(a);
    await page.goto('/requests');
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveText(['조직 전체', `내가 승인할 요청 ${a}`, `내가 작성한 요청 · 제출 전 ${b}`, '승인 불가(주소 중지)']);
    await expect(page.getByRole('tab', { selected: true })).toHaveText('조직 전체');
    await page.getByRole('tab', { name: `내가 승인할 요청 ${a}` }).click();
    await expect(page).toHaveURL(/view=to_approve/);
    await expect(page.getByText(/^전체 \d+건 중/)).toHaveText(new RegExp(`^전체 ${a}건 중`));
    await page.getByRole('tab', { name: /^내가 작성한 요청/ }).click();
    await expect(page).toHaveURL(/view=mine/);
  } finally {
    await apiPost(page, `/api/requests/${draft.id}/cancel`, { version: draft.version });
  }
  await logout(page);

  // 오민재(승인자만): '승인 n'만. 한지수(자산 담당자만): '제출 전 n'만.
  await loginAs(page, '오민재');
  const oh = await dashboardTasks(page);
  await expect(page.locator('#sidenav').getByRole('link', { name: /결재 및 요청/ }).locator('.nav-badge')).toHaveText([`승인 ${oh.find((t) => t.kind === 'approve_requests')!.count}`]);
  // 홈 진행 중 요청: 내가 승인할 차례인 요청에 '내 승인 차례'
  const wr4 = page.locator('a.progress-item', { hasText: 'WR-000004' });
  await expect(wr4.locator('.badge-turn')).toHaveText('내 승인 차례');
  await expect(wr4.locator('.turn-text')).toHaveText('승인자 결정 대기');
  // 누구 차례인지는 둘째 줄(요청자 → 받는 곳) 맨 앞에 있고, 첫 줄의 수량은 '내 승인 차례'가 붙은 줄에서도 번호와 같은 줄에 남는다(1440px).
  await expect(wr4.locator('.progress-meta .turn-text')).toHaveCount(1);
  await expect(wr4.locator('.progress-meta')).toContainText(/^승인자 결정 대기 · 강도윤 → /);
  for (const ref of ['WR-000004', 'WR-000003', 'WR-000005']) {
    const row = page.locator('a.progress-item', { hasText: ref });
    const ys = await row.evaluate((el) => ['.ref', '.progress-amt'].map((s) => { const b = el.querySelector(s)!.getBoundingClientRect(); return Math.round((b.top + b.bottom) / 2); }));
    expect(Math.abs(ys[0]! - ys[1]!), `${ref} 수량이 번호와 같은 줄`).toBeLessThanOrEqual(4);
  }
  await logout(page);
  await loginAs(page, '한지수');
  const han = await dashboardTasks(page);
  const hanDrafts = han.find((t) => t.kind === 'my_drafts')!.count;
  expect(hanDrafts).toBeGreaterThan(0); // 시드: WR-000005(검토 중)·WR-000006(작성 중)
  await expect(page.locator('#sidenav').getByRole('link', { name: /결재 및 요청/ }).locator('.nav-badge')).toHaveText([`제출 전 ${hanDrafts}`]);
  // '검토 중'은 요청자 차례라는 것을 상태 옆에 쓴다(홈과 목록). 상태 이름은 그대로다.
  const homeRow = page.locator('a.progress-item', { hasText: 'WR-000005' });
  await expect(homeRow.locator('.badge')).toHaveText('검토 중');
  await expect(homeRow.locator('.turn-text')).toHaveText('요청자 최종 확인 중');
  await expect(homeRow.locator('.badge-turn')).toHaveCount(0);
  await page.goto('/requests');
  const listRow = page.locator('a.req-item', { hasText: 'WR-000005' });
  await expect(listRow.locator('.badge').first()).toHaveText('검토 중');
  await expect(listRow.locator('.turn-text')).toHaveText('요청자 최종 확인 중');
});

test('홈 지금 처리할 일(A1-04): 건수는 서버와 같고, 사용 대기 경고는 그 자리에, 한 줄 목록은 상세로 간다', async ({ page }) => {
  for (const user of ['한지수', '오민재', '강도윤', '윤가람', '문태호']) {
    await loginAs(page, user);
    const tasks = (await dashboardTasks(page)).filter((t) => t.count > 0);
    const list = page.locator('section.card-tasks');
    await expect(list.locator('a.task .task-count'), user).toHaveText(tasks.map((t) => String(t.count)));
    // 링크 이름에 메뉴 이름이 섞이지 않는다(메뉴 링크와 헷갈리지 않게).
    for (const name of await list.getByRole('link').evaluateAll((els) => els.map((e) => e.textContent ?? ''))) {
      expect(name, user).not.toMatch(/홈|결재 및 요청/);
    }
    const cooling = list.getByRole('link', { name: /사용 대기 중인 새 주소 — 모르는 등록이면 정지하세요/ });
    if (tasks.some((t) => t.kind === 'cooling_addresses')) {
      await expect(cooling, user).toHaveCount(1);
      await expect(cooling).toHaveClass(/task-warning/);
      // 두 가지 정지 사유가 모두 보인다: 제목의 '모르는 등록'과 설명의 '받는 곳에서 확인되지 않은 주소'(서버 문구와 같은 두 사유). 같은 지시를 두 번 쓰지 않는다.
      await expect(cooling).toContainText('받는 곳에서 확인되지 않은 주소도 정지하세요.');
      await expect(cooling).toContainText('정지는 주소를 열어 「사용 대기 중 정지」로 합니다.');
      await expect(cooling.locator('.task-desc')).not.toContainText('요청한 적 없는 등록이면');
    } else {
      await expect(cooling, user).toHaveCount(0);
    }
    if (user === '한지수') {
      // 본인이 등록한 사용 대기 주소는 그렇다고 알려 준다(ab-14: 한지수 등록, 서예린 확인).
      const sub = list.locator('.task-sub a', { hasText: '신규 거래처 L 정산 주소' });
      await expect(sub).toContainText('한지수 등록 · 서예린 확인');
      await expect(sub).toContainText('내가 등록한 주소 — 내가 요청한 등록이 맞는지 확인하세요');
      await expect(sub).toContainText(/\d{2}-\d{2} \d{2}:\d{2}부터 사용 가능/);
      await expect(sub).toHaveAttribute('href', '/addresses/ab-14');
    }
    if (user === '문태호') expect(tasks.some((t) => t.kind === 'cooling_addresses')).toBe(false);
    if (user === '오민재') {
      const sub = list.locator('.task-sub a', { hasText: '0.5 BTC' });
      await expect(sub).toHaveText(/^강도윤님 · 0\.5 BTC → 그룹사 BTC 보관 이전용 · \d+시간 전 승인 요청$/);
      await sub.click();
      await expect(page).toHaveURL(/\/requests\/wr-4$/);
      await page.goto('/');
      // 확인할 새 주소: 등록자·이름·자산/네트워크
      await expect(list.locator('.task-sub a', { hasText: '신규 거래처 G 입금 주소' })).toContainText('한지수님 등록 · 신규 거래처 G 입금 주소 (USDC/Ethereum)');
    }
    await logout(page);
  }
  await loginAs(page, '서예린');
  await expect(page.locator('.task-sub a', { hasText: '신규 거래처 L 정산 주소' })).toContainText('내가 확인한 주소');
});

test('결정 카드(A1-05·06·07): 요약 → 주소록 기록 → 지문 → 점검 → 주소와 확인 → 마지막 승인 버튼', async ({ page }) => {
  await loginAs(page, '오민재');
  const dto = await (await page.request.get('/api/requests/wr-4')).json();
  await page.goto('/requests/wr-4');
  const card = page.locator('section.card-action');
  await expect(card.locator('.rc-decide-summary')).toHaveText('강도윤님의 출금 요청: 그룹사 BTC 보관 이전용(모의 그룹사 C)에 0.5 BTC (약 5,000만 원) · 목적: 그룹사 보관 자산 일부 이전 (모의) · 승인 0/1명');
  // 카드의 첫 글은 제목 다음의 요약이다.
  expect(await card.evaluate((el) => el.querySelector('h2')!.nextElementSibling!.className)).toBe('rc-decide-summary');
  const rec = card.locator('.rc-addr-record');
  await expect(rec).toContainText(/^주소록: 강도윤 등록 \d{4}-\d{2}-\d{2} · 오민재 확인 \d{4}-\d{2}-\d{2} \(사람이 남긴 기록이며 증명이 아닙니다\) · 주소 기록 보기$/);
  await expect(rec.getByRole('link', { name: '주소 기록 보기' })).toHaveAttribute('href', '/addresses/ab-03');
  // 지문은 그대로 카드 안에 보인다(A-29). 요청자 화면과 같은 값(서버 값). 바로 아래 승인자 쪽 할 일(다른 연락 수단으로 받은 지문과 대조, 선택 단계).
  await expect(card.getByRole('group', { name: '승인 대상 지문' }).locator('.rc-intent-value')).toHaveText(dto.intentHashDisplay);
  await expect(card.locator('.rc-intent + .rc-intent-todo')).toHaveText('요청자에게서 이 지문을 메신저가 아닌 다른 연락 수단으로 받았다면 같은지 대조하세요. 다르면 승인하지 말고 반려하세요.');
  const order = await card.evaluate((el) => {
    const pos = (s: string) => [...el.querySelectorAll('*')].indexOf(el.querySelector(s)!);
    return [pos('.rc-decide-summary'), pos('.rc-addr-record'), pos('.rc-intent'), pos('.rc-list'), pos('.rc-check-address'), pos('button.btn-primary')];
  });
  expect(order.every((p) => p >= 0)).toBe(true);
  expect([...order].sort((x, y) => x - y)).toEqual(order);
  // 점검: 주의 → 확인 불가가 먼저 펼쳐져 있고, 기준 이내 3건은 접힌 묶음 안(항목 수는 그대로 5)
  const firstTwo = card.locator('.rc-list').first().locator('.rc-item');
  await expect(firstTwo).toHaveCount(2);
  await expect(firstTwo.nth(0)).toContainText('주의이 대시보드로 처음 보내는 주소입니다');
  await expect(firstTwo.nth(1)).toContainText('확인 불가과거 출금 부족');
  // 승인자 화면: '확인 불가'의 뜻만 쓰고, 요청자에게 하는 말('진행 사유는 적지 않아도 됩니다')은 붙이지 않는다.
  await expect(firstTwo.nth(1).locator('.rc-unknown-note')).toHaveText('자료가 부족해 판단하지 못한 항목입니다. 문제가 없다는 뜻은 아닙니다.');
  await expect(card).not.toContainText('진행 사유는 적지 않아도 됩니다');
  await expect(card.locator('.rc-item')).toHaveCount(5);
  const pass = card.locator('details.rc-pass-group');
  await expect(pass.locator('summary')).toHaveText('기준 이내 3건 · 기준과 세부 내용 보기');
  await expect(pass.locator('.rc-item').first()).toBeHidden();
  await expect(card.locator('.rc-summary').first()).toHaveText('주의 1건 · 확인 불가 1건 · 기준 이내 3건');
  await expect(card.locator('.rc-footnote')).toContainText('기준은 설계 가정이며, 기준 이내라는 결과도 받는 곳이나 전송을 보증하지 않습니다');
  // 키보드(Enter·Space)로 펼치고 접는다. 펼치면 항목마다 기준과 '(설계 가정)'이 보인다.
  await pass.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(pass).toHaveAttribute('open', '');
  for (const basis of await pass.locator('.rc-basis').all()) await expect(basis).toContainText('(설계 가정)');
  await page.keyboard.press('Space');
  await expect(pass).not.toHaveAttribute('open', '');
  // 승인 전 확인: 근거 문서가 첨부되지 않는다는 안내, 주소 대조 체크 바로 위의 전체 주소(모든 묶음)
  await expect(card.locator('#check-amount-hint')).toHaveText('이 화면에는 근거 문서가 첨부되지 않습니다. 요청자에게 받은 문서와 직접 대조하세요.');
  const strip = card.locator('.rc-check-address');
  await expect(strip.locator('.verify-label')).toHaveText(`대조할 받는 주소 (${dto.networkName})`);
  await expect(strip.locator('.addr-compact')).toHaveCount(0);
  expect((await strip.locator('.addr-chunk').allTextContents()).join('')).toBe(String(dto.address.address).replace(/^MOCK-[A-Z]+-/, ''));
  // 마지막 승인(1/1): 버튼 이름과 효과 문장, 되돌릴 수 없음 문장은 그대로
  const approve = card.getByRole('button', { name: '승인하고 처리 시작', exact: true });
  await expect(approve).toBeDisabled();
  await expect(card.getByRole('button', { name: '승인', exact: true })).toHaveCount(0);
  await expect(card.locator('#approve-effect')).toHaveText('이번 승인이 마지막 승인입니다. 승인하면 바로 수탁사 처리가 시작되고, 그 뒤에는 요청자도 취소할 수 없습니다.');
  await expect(approve).toHaveAttribute('aria-describedby', 'approve-effect approve-hint');
  await expect(card.locator('.rc-irreversible')).toHaveText('필요한 승인 수가 채워지면 바로 처리가 시작되며, 블록체인 전송은 처리 후 되돌릴 수 없습니다. 은행 착오송금처럼 되돌려 받는 절차도 없습니다.');
  // 마지막 승인에만 승인 뒤 흐름 한 줄(완료와 실패 둘 다)
  await expect(card.locator('.rc-after-approve')).toHaveText('처리 결과(처리 완료 또는 처리 실패)는 이 화면의 상태로 표시되고, 완료되면 자산 활동 내역에 출금으로 기록됩니다.');
  // 승인 전 확인의 체크 줄은 누르는 영역이 44px 이상이다(1440px).
  for (const h of await card.locator('.checks .check').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
  await page.getByLabel(/받는 곳과 목적이/).check();
  await page.getByLabel(/근거 문서와 같습니다/).check();
  await expect(approve).toBeDisabled(); // 세 항목을 모두 확인해야 한다(규칙 그대로)
  await page.getByLabel(/앞·뒤 묶음과 네트워크/).check();
  await expect(approve).toBeEnabled(); // 누르지 않는다(WR-000004는 다른 검사가 쓴다)
  // 레일 네 칸과 마지막 칸 설명
  await expect(page.locator('ol.rail').first().locator('.rail-step')).toHaveText(['작성', '검토', '승인 대기 (현재 단계)', '처리 결과']);
  await expect(page.locator('.rail-caption')).toHaveText("마지막 칸 '처리 결과'는 필요한 승인이 모두 모인 뒤 수탁사가 처리한 결과(처리 완료·처리 실패)입니다.");
  const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);

  // 390px: 대조할 주소와 주소 체크가 한 화면 높이 안에 있고, 가로로 넘치지 않는다.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await card.locator('.rc-check-address .addr-chunk').first().waitFor();
  await page.waitForLoadState('networkidle');
  const s = (await strip.boundingBox())!;
  const c = (await page.getByLabel(/앞·뒤 묶음과 네트워크/).boundingBox())!;
  expect(c.y + c.height - s.y).toBeLessThanOrEqual(844);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  for (const right of await card.locator('.rc-decide-summary, .rc-addr-record, .rc-check-address, .addr-chunk').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) expect(right).toBeLessThanOrEqual(390);
  // 390px: 체크 줄 44px 이상, 체크 상자 22px
  for (const h of await card.locator('.checks .check').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
  for (const w of await card.locator('.checks input[type=checkbox]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width))) expect(w).toBeGreaterThanOrEqual(22);
  await logout(page);

  // 요청자(강도윤)와 감사 담당자(문태호)에게는 결정 버튼이 없다.
  for (const user of ['강도윤', '문태호']) {
    await loginAs(page, user);
    await page.goto('/requests/wr-4');
    await expect(page.getByRole('heading', { name: '출금 요청 WR-000004' })).toBeVisible();
    await expect(page.getByRole('button', { name: BOTH_APPROVE }), user).toHaveCount(0);
    await logout(page);
  }
});

test('필요 승인 2명(A1-06): 첫 승인자는 승인·몇 번째, 다음 승인자는 승인하고 처리 시작·마지막 승인', async ({ page }) => {
  // 원화 평가액 1억 원 이상(ETH 30, 모의 시세)이라 서로 다른 승인자 2명이 필요하다(설계 가정). 끝에 요청자가 취소한다.
  await loginAs(page, '한지수');
  const ab05 = await (await page.request.get('/api/addresses/ab-05')).json();
  const draft = await apiPost(page, '/api/requests', { assetCode: 'ETH', networkCode: 'ETHEREUM', addressId: 'ab-05', amount: '30', purpose: 'E2E A1 마지막 승인 표시 확인' });
  const rv = await apiPost(page, `/api/requests/${draft.id}/review`, { version: draft.version });
  const checkReasons = Object.fromEntries((rv.checks?.items ?? []).filter((x: any) => x.requiresReason).map((x: any) => [x.id, 'E2E 거래처 재무팀과 등록된 번호로 통화해 확인했습니다']));
  const sent = await apiPost(page, `/api/requests/${draft.id}/submit`, { version: rv.version, confirmTail: String(ab05.address).slice(-6), ackIrreversible: true, checkReasons });
  expect(sent.requiredApprovals).toBe(2);
  try {
    // 요청자: 알림이 없다는 안내와, 누가 승인할 수 있는지 볼 곳(조직 관리)
    await page.goto(`/requests/${draft.id}`);
    const next = page.locator('section.next-action');
    await expect(next.locator('p').first()).toHaveText('승인자의 결정을 기다리는 중입니다. 알림이 가지 않으니 승인자에게 직접 알려 주세요. 요청을 취소할 수도 있습니다.');
    await expect(next).toContainText('승인할 수 있는 사람은 「조직 관리」의 역할 표에서 승인자로 표시된 구성원입니다.');
    await expect(page.getByRole('button', { name: BOTH_APPROVE })).toHaveCount(0);
    await next.getByRole('link', { name: '「조직 관리」' }).click();
    await expect(page.getByRole('heading', { name: '조직 관리', level: 1 })).toBeVisible();
    await logout(page);

    await loginAs(page, '오민재');
    await page.goto(`/requests/${draft.id}`);
    await expect(page.locator('#approve-effect')).toHaveText('지금 기준으로 이번 승인은 필요한 승인 2명 중 첫 번째입니다. 1명이 더 승인해야 처리가 시작됩니다.');
    await expect(page.getByRole('button', { name: '승인하고 처리 시작' })).toHaveCount(0);
    // 마지막이 아닌 승인에는 승인 뒤 흐름 줄이 없다(위 문장과 어긋나지 않게).
    await expect(page.locator('.rc-after-approve')).toHaveCount(0);
    await page.getByLabel(/받는 곳과 목적이/).check();
    await page.getByLabel(/근거 문서와 같습니다/).check();
    await page.getByLabel(/앞·뒤 묶음과 네트워크/).check();
    await page.getByRole('button', { name: '승인', exact: true }).click();
    const partial = page.getByRole('status').filter({ hasText: '승인했습니다 (1/2)' });
    await expect(partial).toContainText('필요한 승인 수가 채워지면 바로 수탁사 처리가 시작됩니다. 알림은 가지 않으니 필요하면 다른 승인자에게 직접 알려 주세요.');
    await expect(partial).not.toContainText('커스터디 처리');
    await logout(page);

    await loginAs(page, '서예린');
    await page.goto(`/requests/${draft.id}`);
    await expect(page.locator('.rc-decide-summary')).toContainText('· 승인 1/2명');
    await expect(page.getByRole('button', { name: '승인하고 처리 시작', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '승인', exact: true })).toHaveCount(0);
    await expect(page.locator('#approve-effect')).toContainText('이번 승인이 마지막 승인입니다.');
    await expect(page.locator('.rc-after-approve')).toBeVisible();
    await logout(page);
  } finally {
    // 정리: 요청자 세션으로 바꿔(화면 상태와 관계없이) 취소한다.
    expect((await page.request.post('/api/auth/dev-login', { data: { userId: 'u-a-han' } })).ok()).toBeTruthy();
    const cur = await (await page.request.get(`/api/requests/${draft.id}`)).json();
    if (cur.allowedActions?.includes('cancel')) await apiPost(page, `/api/requests/${draft.id}/cancel`, { version: cur.version });
  }
});

test('점검 목록(A1-07) 검토 단계: 주의 항목마다 진행 사유 칸이 그대로 펼쳐져 있고, 기준 이내는 접혀 있다', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/requests/wr-5');
  const card = page.locator('section.card-action');
  await expect(card.getByRole('heading', { name: '최종 검토 후 승인 요청' })).toBeVisible();
  const items = (await (await page.request.get('/api/requests/wr-5')).json()).checks.items as { id: string; label: string; outcome: string; requiresReason: boolean }[];
  for (const c of items.filter((x) => x.requiresReason)) {
    await expect(card.getByRole('textbox', { name: `진행 사유: ${c.label}` })).toBeVisible();
  }
  await expect(card.locator('.rc-item')).toHaveCount(items.length);
  const passN = items.filter((x) => x.outcome === 'pass' && !x.requiresReason).length;
  if (passN > 0) {
    await expect(card.locator('details.rc-pass-group summary')).toHaveText(`기준 이내 ${passN}건 · 기준과 세부 내용 보기`);
    await expect(card.locator('details.rc-pass-group')).not.toHaveAttribute('open', '');
  }
  await expect(card.locator('.rc-footnote')).toBeVisible();

  // 읽기 전용 점검(작성 중인 내 요청 wr-6, 승인자가 보는 검토 중 요청 wr-5): 기준 이내 항목이 접혀 있어도 '설계 가정·보증 아님' 각주는 접히지 않고 보인다.
  const footnote = '점검 기준은 설계 가정이며, 기준 이내라는 결과도 받는 곳이나 전송을 보증하지 않습니다.';
  await page.goto('/requests/wr-6');
  await expect(page.getByRole('heading', { name: '출금 전 점검', level: 2 })).toBeVisible();
  await expect(page.locator('.rc-footnote')).toBeVisible();
  await expect(page.locator('.rc-footnote')).toHaveText(footnote);
  await logout(page);
  await loginAs(page, '오민재');
  await page.goto('/requests/wr-5');
  await expect(page.getByRole('heading', { name: '출금 전 점검', level: 2 })).toBeVisible();
  await expect(page.locator('section.card-action')).toHaveCount(0); // 결정 카드가 아니라 읽기 전용 목록
  await expect(page.locator('.rc-footnote')).toBeVisible();
  await expect(page.locator('.rc-footnote')).toHaveText(footnote);
  await expect(page.getByText('진행 사유는 적지 않아도 됩니다')).toHaveCount(0); // 승인자에게는 요청자용 말을 붙이지 않는다
});

test('승인자가 보는 작성 중 요청(A1-08): 알려 드린다고 약속하지 않고 어디에 나타나는지 쓴다', async ({ page }) => {
  await loginAs(page, '오민재');
  await page.goto('/requests/wr-6');
  const next = page.locator('section.next-action');
  await expect(next).toContainText("승인 요청이 오면 '지금 처리할 일'과 「내가 승인할 요청」에 표시됩니다. 알림은 보내지 않습니다.");
  await expect(page.getByText(/알려 드립니다/)).toHaveCount(0);
});

test('감사 기록(A1-10): 내보내기 권한이 없으면 이유와 요청할 사람, 있으면 버튼만', async ({ page }) => {
  await loginAs(page, '윤가람');
  await page.goto('/audit');
  await expect(page.getByText('이 역할에는 CSV 내보내기 권한이 없습니다. 감사 증빙 파일이 필요하면 감사 담당자에게 요청하세요.')).toBeVisible();
  await expect(page.getByRole('link', { name: /CSV 내보내기/ })).toHaveCount(0);
  await expect(page.getByText('무결성 확인됨')).toBeVisible();
  await expect(page.locator('.audit-anchor')).toBeVisible();
  await logout(page);
  await loginAs(page, '문태호');
  await page.goto('/audit');
  await expect(page.getByRole('link', { name: /CSV 내보내기/ })).toBeVisible();
  await expect(page.getByText('이 역할에는 CSV 내보내기 권한이 없습니다')).toHaveCount(0);
});

test('잔고·스테이킹(A1-09·10): 묶인 수량(예약) 이름과 스테이킹이 총 평가액에 더해지지 않는다는 문장', async ({ page }) => {
  await loginAs(page, '한지수');
  // 홈 보유 자산의 USDC 행: 예약 대신 '출금 요청에 묶임'(승인 대기·처리 중 모두 맞는 말)
  const usdc = page.locator('.card-holdings.only-wide tbody tr', { hasText: 'USDC' });
  await expect(usdc).toContainText(/출금 요청에 묶임 [\d,]+/);
  await expect(page.getByText('승인 대기로 묶임')).toHaveCount(0);
  const shortNote = '스테이킹 현황의 맡긴 수량·보상은 이 합계에 넣지 않았습니다(모의 데이터).';
  // 홈 총 평가액 바로 아래 짧은 문장(넓은 화면은 오른쪽 열 카드, 좁은 화면은 할 일 아래 카드)
  await expect(page.locator('.card-holdings.only-wide .total .total-staking-note')).toHaveText(shortNote);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) {
      await page.goto('/');
      await expect(page.locator('.card-holdings.only-narrow .total .total-staking-note')).toBeVisible();
    }
    await page.goto('/balances');
    // 잔고: 총 평가액 바로 아래 짧은 문장(합계와 같은 덩어리), 화면 아래 긴 문장은 그대로
    const near = page.locator('.total .total-staking-note');
    await expect(near).toBeVisible();
    await expect(near).toHaveText(shortNote);
    const gap = await page.evaluate(() => document.querySelector('.total .total-staking-note')!.getBoundingClientRect().top - document.querySelector('.total-value')!.getBoundingClientRect().bottom);
    expect(gap, `${width}px 합계와 문장 사이`).toBeLessThanOrEqual(80);
    await expect(page.locator('.bal-staking-note')).toBeVisible();
    await expect(page.locator('.bal-staking-note')).toHaveText('총 평가액은 지갑 보유 수량으로만 계산하며, 스테이킹 현황의 맡긴 수량과 보상은 따로 더하지 않습니다. 맡긴 자산이 지갑 보유 수량에 들어 있는지는 KODA 자료로 확인해야 합니다(모의 데이터).');
    if (width === 1440) await expect(page.locator('.bal-wide thead')).toContainText('묶인 수량(예약)');
    else await expect(page.locator('.bal-legend dt').nth(1)).toHaveText('묶인 수량(예약)');
    await page.goto('/staking');
    await expect(page.getByText('이 화면의 수량은 잔고의 총 평가액에 따로 더하지 않습니다.', { exact: false })).toBeVisible();
  }
});

test('조직 관리(A1-10·11): 역할 이름, 저장 전 영향 안내와 경고, 저장 뒤 결과 안내(규칙은 서버 그대로)', async ({ page }) => {
  await loginAs(page, '윤가람');
  await page.goto('/org');
  await expect(page.getByText("한 사람이 자산 담당자와 승인자 역할을 함께 가질 수 있지만, 자기 요청과 자기가 등록한 주소는 승인할 수 없습니다. 출금 요청 화면의 '요청자'는 그 요청을 작성한 사람입니다.")).toBeVisible();
  const row = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '오민재' }) });
  await row.getByRole('button', { name: '역할 변경' }).click();
  await row.getByRole('checkbox', { name: '승인자' }).uncheck();
  await expect(row.getByRole('status')).toHaveText('저장하면 승인자 2명 · 자산 담당자 2명 · 조직 관리자 1명이 됩니다.');
  await expect(row.locator('.notice-warning')).toHaveCount(0);
  await row.getByRole('button', { name: '취소' }).click();
  await logout(page);

  // 모의법인 B: 유일한 승인자(임하은)의 승인자 역할을 빼면 0명 경고. 저장은 그대로 한 번에 되고 결과 안내가 보인다. 끝에 되돌린다.
  await loginAs(page, '조은비');
  await page.goto('/org');
  const lim = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '임하은' }) });
  await lim.getByRole('button', { name: '역할 변경' }).click();
  await expect(lim.locator('.notice-warning')).toContainText('승인자가 1명이면 원화 평가액 1억 원 이상 출금(서로 다른 승인자 2명 필요, 설계 가정)은 승인 요청을 보낼 수 없습니다.');
  await lim.getByRole('checkbox', { name: '승인자' }).uncheck();
  await expect(lim.locator('.role-impact-note')).toHaveText('저장하면 승인자 0명 · 자산 담당자 1명 · 조직 관리자 1명이 됩니다.');
  await expect(lim.locator('.notice-warning')).toHaveText(['승인자가 0명이 되면 아무도 출금 요청을 승인하거나 새 주소를 확인할 수 없고, 승인 요청 보내기가 거부됩니다.']);
  // 화면 낭독기: 인원 줄과 경고가 한 알림 영역 안에 있어 함께 읽힌다(경고만 빠지지 않게).
  const live = lim.getByRole('status');
  await expect(live).toHaveCount(1);
  await expect(live).toHaveClass(/role-impact/);
  await expect(live).toContainText('저장하면 승인자 0명');
  await expect(live).toContainText('승인자가 0명이 되면 아무도 출금 요청을 승인하거나');
  const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  for (const right of await lim.locator('.role-impact, .notice').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))) expect(right).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  await lim.getByRole('button', { name: '저장' }).click();
  const saved = page.getByRole('status').filter({ hasText: '임하은님의 역할을 저장했습니다. 바로 적용되었고 감사 기록에 남았습니다.' });
  await expect(saved).toBeVisible();
  await expect(page.locator('.rc-focus-target').filter({ has: saved })).toBeFocused();
  await expect(lim.getByRole('cell').filter({ hasText: '승인자' })).toHaveCount(0);
  // 되돌리기: 승인자 역할을 다시 준다(다른 사람에게 주는 것은 허용, A-19)
  await lim.getByRole('button', { name: '역할 변경' }).click();
  await lim.getByRole('checkbox', { name: '승인자' }).check();
  await lim.getByRole('button', { name: '저장' }).click();
  await expect(saved).toBeVisible();
  const members = await (await page.request.get('/api/org/members')).json();
  expect(members.find((m: any) => m.name === '임하은').roles).toContain('approver');

  // 유일한 자산 담당자(배서준)의 역할을 빼면 자산 담당자 0명 경고. 저장하지 않고 취소한다.
  const bae = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: '배서준' }) });
  await bae.getByRole('button', { name: '역할 변경' }).click();
  await bae.getByRole('checkbox', { name: '자산 담당자' }).uncheck();
  await expect(bae.locator('.role-impact-note')).toHaveText('저장하면 승인자 1명 · 자산 담당자 0명 · 조직 관리자 1명이 됩니다.');
  await expect(bae.locator('.notice-warning')).toContainText(['자산 담당자가 0명이 되면 출금 요청 작성과 주소 등록을 할 수 없습니다.']);
  await expect(bae.getByRole('status')).toContainText('자산 담당자가 0명이 되면 출금 요청 작성과 주소 등록을 할 수 없습니다.');
  await bae.getByRole('button', { name: '취소' }).click();
  await expect(bae.locator('.role-impact')).toHaveCount(0);
  const after = await (await page.request.get('/api/org/members')).json();
  expect(after.find((m: any) => m.name === '배서준').roles).toContain('requester');
});

test('자주 묻는 질문(A1-12): 처음에는 접혀 있고 키보드로 펼치며, 정책 숫자(설계 가정)를 쓰고 안전을 약속하지 않는다', async ({ page }) => {
  await loginAs(page, '한지수');
  const me = await (await page.request.get('/api/me')).json();
  const policy = await (await page.request.get('/api/org/policy')).json();

  await page.goto('/addresses');
  // 중요 고지('사용 가능'의 뜻)는 접히지 않은 본문 크기 그대로이고 자주 묻는 질문 밖에 있다.
  const notice = page.locator('.notice', { hasText: "주소록의 '사용 가능'은 주소가 안전하다는 뜻이 아닙니다" });
  await expect(notice).toBeVisible();
  await expect(page.locator('details.faq .notice')).toHaveCount(0);
  const faq = page.locator('details.faq');
  await expect(faq).toHaveCount(1);
  await expect(faq).not.toHaveAttribute('open', '');
  await expect(faq.locator('summary')).toHaveText('자주 묻는 질문');
  await expect(faq.locator('dd').first()).toBeHidden();
  await faq.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(faq).toHaveAttribute('open', '');
  const hours: number = policy.addressBook.cooldownHours;
  const when = faq.locator('.faq-item', { hasText: '새 주소는 언제부터 출금에 쓸 수 있나요?' });
  if (hours === 0) {
    await expect(when).toContainText('등록 → 등록자가 아닌 승인자의 확인 → 사용 가능 순서입니다.');
    await expect(when).not.toContainText('사용 대기');
  } else {
    await expect(when).toContainText(`사용 대기 ${hours === 24 ? '기본 24시간' : `${hours}시간`}(설계 가정)`);
  }
  await expect(faq).toContainText(`끝 ${me.policy.confirmTailLength}자리와 가운데 8자리를 직접 입력하세요`);
  await expect(faq).toContainText('이 대시보드는 알림을 보내지 않습니다.');
  // 정지할 수 있는 사람은 조직 관리에 보이는 역할 이름으로 쓴다(주소 등록·확인 권한과 관리 권한을 가진 세 역할).
  await expect(faq.locator('.faq-item', { hasText: '모르는 주소가 사용 대기 중이면요?' })).toContainText('자산 담당자·승인자·조직 관리자 누구나 정지할 수 있고, 사유는 감사 기록에 남습니다.');
  await expect(faq).not.toContainText('담당자와 조직 관리자가');
  await expect(faq.getByRole('link')).toHaveCount(0);
  await expect(page.getByText(/안전합니다|안전한 주소|검증됨|위험 없음/)).toHaveCount(0);
  let axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  await page.keyboard.press('Space');
  await expect(faq).not.toHaveAttribute('open', '');

  // 사용 대기 시간이 있는 정책(기본 24시간)이면 그 시간과 '설계 가정'을 쓴다(정책 응답만 바꿔 화면 문구를 본다).
  await page.route('**/api/org/policy', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, addressBook: { ...body.addressBook, cooldownHours: 24 } } });
  });
  await page.reload();
  await faq.locator('summary').click();
  await expect(faq.locator('.faq-item', { hasText: '새 주소는 언제부터 출금에 쓸 수 있나요?' })).toContainText('등록 → 등록자가 아닌 승인자의 확인 → 사용 대기 기본 24시간(설계 가정) → 사용 가능 순서입니다.');
  await page.unroute('**/api/org/policy');

  await page.goto('/requests');
  const rf = page.locator('details.faq');
  await expect(rf).not.toHaveAttribute('open', '');
  await rf.locator('summary').focus();
  await page.keyboard.press('Space');
  await expect(rf).toHaveAttribute('open', '');
  const a = me.policy.approval;
  const high = Math.max(a.highValueRequiredApprovals, a.defaultRequiredApprovals);
  const threshold = BigInt(a.highValueThresholdKrw) % 100_000_000n === 0n ? `${BigInt(a.highValueThresholdKrw) / 100_000_000n}억 원` : '';
  expect(threshold).not.toBe('');
  await expect(rf).toContainText(`원화 평가액 ${threshold} 미만은 ${a.defaultRequiredApprovals}명, 이상은 서로 다른 ${high}명입니다. 시세가 없거나 지연되면 ${high}명입니다(설계 가정, KODA 정책 아님).`);
  await expect(rf).toContainText("'검토 중'은 누구 차례인가요?");
  await expect(rf).toContainText('건마다 받는 주소·수량·승인 대상 지문을 대조하도록 한 건씩 처리합니다.');
  await expect(rf.getByRole('link')).toHaveCount(0);
  await expect(page.getByText(/안전합니다|안전한 주소|검증됨|위험 없음/)).toHaveCount(0);
  axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await page.goto('/addresses');
  await page.locator('details.faq summary').click();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});
