import { expect, test, type Page } from '@playwright/test';
import { loginAs, logout } from './helpers.ts';
import { middleSegment } from '../shared/address-rules.ts';
import { GLOSSARY } from '../shared/terms.ts';

/**
 * 390px 폭에서 표 화면이 읽히는지: 가로 넘침, 보이는 표 셀의 최소 폭, 화면 밖으로 나간 배지를 잰다.
 * 모바일 기기 흉내(isMobile)에서는 내용이 넘치면 window.innerWidth가 내용 폭만큼 늘어나 넘침이 0으로 보인다.
 * 그래서 넘침은 레이아웃 폭(documentElement.clientWidth) 기준으로 잰다.
 */
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
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
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
      if (path.startsWith('/balances')) {
        // 넓은 표 머리글의 용어 설명(Term)이 숨으므로, 같은 설명이 덩어리 위에 보인다
        const legend = page.locator('.bal-legend');
        await expect(legend).toBeVisible();
        await expect(legend).toContainText(GLOSSARY.available!);
        await expect(legend).toContainText(GLOSSARY.reserved!);
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

/** 띄어쓰기 없는 한글은 keep-all에서 줄을 바꿀 곳이 없다. 같은 글자를 이어 붙여 정확히 n자로 만든다. */
const noSpace = (seed: string, n: number, stamp: string) => (seed.repeat(Math.ceil(n / seed.length)).slice(0, n - stamp.length) + stamp);

async function apiPost(page: Page, url: string, body: unknown) {
  const me = await (await page.request.get('/api/me')).json();
  const res = await page.request.post(url, { data: body, headers: { 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  const json = await res.json();
  expect(res.ok(), JSON.stringify(json)).toBeTruthy();
  return json;
}

/** 문서 가로 넘침(레이아웃 폭 기준)과, 오른쪽 끝이 화면 밖으로 밀려난 주요 요소(제목·설명·정의 목록 값·주소 묶음·요청 항목·표 머리 칸·선택 상자)를 잰다. */
const measureDetail = (page: Page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const out = (sel: string) => [...document.querySelectorAll(sel)]
    .filter((e) => e.getClientRects().length > 0)
    .map((e) => ({ sel, right: Math.round(e.getBoundingClientRect().right), text: (e.textContent ?? '').trim().slice(0, 12) }))
    .filter((r) => r.right > vw + 1);
  return {
    overflow: document.documentElement.scrollWidth - vw,
    offscreen: [...out('h1'), ...out('.page-desc'), ...out('.dl dd'), ...out('.addr-chunk'), ...out('.req-item'), ...out('.req-meta > span'), ...out('table tbody th'), ...out('select')],
  };
});

test.describe('390px 긴 이름(띄어쓰기 없음)', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  // 주소·요청을 새로 만들고 정리하므로 공유 배포(E2E_BASE_URL)에서는 돌지 않는다.
  test.skip(!!process.env.E2E_BASE_URL, '데이터를 바꾸는 검사는 로컬·CI에서만 돈다');

  test('최대 길이 이름·받는 곳·목적: 주소 상세·요청 상세·요청 목록·주소록·홈·요청 작성이 가로로 넘치지 않고 주소 묶음이 모두 화면 안에 있다', async ({ page }) => {
    const stamp = Date.now().toString(36).slice(-6).toUpperCase();
    const label = noSpace('해외법인결제대행사분기정산전용계정', 60, stamp); // 주소 이름 최대 60자
    const counterparty = noSpace('모의해외결제대행주식회사아시아태평양지역본부재무팀', 80, stamp); // 받는 곳 최대 80자
    const purpose = noSpace('사분기해외법인결제대행수수료정산및예치금반환요청', 200, stamp); // 요청 목적 최대 200자
    const body = [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const address = `MOCK-EVM-${body}`;
    const measure = async (who: string, where: string) => {
      const m = await measureDetail(page);
      expect(m.offscreen, `${who} ${where}`).toEqual([]);
      expect(m.overflow, `${who} ${where}`).toBeLessThanOrEqual(1);
    };
    /** ready: 이 화면에서 반드시 그려져 있어야 하는 요소(주소 띠의 묶음 등). 그려진 뒤에 잰다. */
    const check = async (path: string, who: string, ready: string) => {
      await page.goto(path);
      await page.locator('#page-title').waitFor();
      await page.locator(ready).first().waitFor();
      await page.waitForLoadState('networkidle');
      await measure(who, path);
    };

    // 등록자: 확인 대기 상태의 상세(상태 설명 포함)
    await loginAs(page, '한지수');
    const created = await apiPost(page, '/api/addresses', {
      assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '', label, counterparty,
      confirmTail: address.slice(-6), confirmMiddle: middleSegment(address).text, lookalikeReason: '', ackNotVerified: true, ackOutOfBandConfirmed: true, receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호',
    });
    const id: string = created.address.id;
    await check(`/addresses/${id}`, '한지수', 'section.card .addr-chunk');
    await expect(page.getByRole('heading', { name: label, level: 1 })).toBeVisible();
    await logout(page);

    // 승인자: 확인 카드(주소 띠 두 개)와 확인 뒤 상세
    await loginAs(page, '오민재');
    await check(`/addresses/${id}`, '오민재', 'section.card-action .addr-chunk'); // 확인 카드의 띠(가운데 구간 테두리)도 화면 폭 안
    const me = await (await page.request.get('/api/me')).json();
    const cur = await (await page.request.get(`/api/addresses/${id}`)).json();
    const reviewed = await apiPost(page, `/api/addresses/${id}/review`, {
      decision: 'approve', version: cur.version, note: '', confirmTail: address.slice(-me.policy.confirmTailLength), confirmMiddle: middleSegment(address).text,
    });
    expect(reviewed.status).toBe('ACTIVE');
    await check(`/addresses/${id}`, '오민재', 'section.card .addr-chunk');
    await logout(page);

    // 요청자: 긴 목적의 초안 → 요청 상세·요청 목록·주소록·홈
    await loginAs(page, '한지수');
    const draft = await apiPost(page, '/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: id, amount: '1', purpose });
    await check(`/requests/${draft.id}`, '한지수', '.dl .addr-chunk');
    await check('/requests', '한지수', `.req-item[href="/requests/${draft.id}"]`);
    await check(`/addresses?q=${stamp}`, '한지수', `table tbody tr:visible:has-text("${stamp}")`);
    await check('/', '한지수', '.task-list, .progress-list');
    // 요청 작성: 받는 주소 목록에 긴 이름이 있고, 고른 주소의 띠가 화면 폭 안에 있다
    await page.goto('/requests/new');
    await page.locator('#assetCode').selectOption('USDC');
    await page.locator('#networkCode').selectOption('ETHEREUM');
    await page.locator('#addressId').selectOption(id);
    await page.locator('.verify-box .addr-chunk').first().waitFor();
    await measure('한지수', '/requests/new');
    // 작성 중인 화면을 떠난다(창 닫기 경고가 뜨면 떠나기를 고른다)
    page.once('dialog', (d) => void d.accept());
    await page.goto('/');
    await page.locator('#page-title').waitFor();

    // 정리: 이 테스트에서 만든 초안을 취소하고, 주소는 사용 중지한다
    await apiPost(page, `/api/requests/${draft.id}/cancel`, { version: draft.version });
    await logout(page);
    await loginAs(page, '윤가람');
    const last = await (await page.request.get(`/api/addresses/${id}`)).json();
    await apiPost(page, `/api/addresses/${id}/disable`, { version: last.version });
  });
});

test('모바일: 메뉴 열기/닫기, 가로 넘침 없음', async ({ page }) => {
  await loginAs(page, '한지수');
  await expect(page.getByRole('heading', { name: '지금 처리할 일' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole('link', { name: '주소록 관리' })).toBeHidden();
  await page.getByRole('button', { name: '메뉴 열기' }).click();
  await page.getByRole('link', { name: '주소록 관리' }).click();
  await expect(page.getByRole('heading', { name: '주소록 관리' })).toBeVisible();
  await expect(page.getByRole('link', { name: '잔고' })).toBeHidden();
});