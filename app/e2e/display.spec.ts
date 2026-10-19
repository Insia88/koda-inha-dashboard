import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginAs, logout } from './helpers.ts';
import { middleSegment } from '../shared/address-rules.ts';

// 표시 규칙(WP-04): 글꼴은 같은 출처에서만, 숫자 열 오른쪽 정렬, 주소 대조 띠의 균일한 묶음과 가운데 구간 테두리.
// 데스크톱(1440px) 프로젝트에서 돈다. 마지막 테스트만 이 파일에서 만든 주소를 바꾸고 끝에 정리한다.

/** 띠 안에서 테두리로 표시된 글자를 순서대로 이어 붙인다. */
const outlinedText = (strip: Locator) => strip.locator('.addr-verify').allTextContents().then((t) => t.join(''));

/** 띠의 묶음(접두 제외)마다 굵기·글자색·바탕색 */
const chunkStyles = (strip: Locator) => strip.locator('.addr-chunk').evaluateAll((els) => els.map((e) => {
  const cs = getComputedStyle(e);
  return `${cs.fontWeight}|${cs.color}|${cs.backgroundColor}`;
}));

async function apiPost(page: Page, url: string, body: unknown) {
  const me = await (await page.request.get('/api/me')).json();
  const res = await page.request.post(url, { data: body, headers: { 'X-CSRF-Token': me.csrfToken, 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` } });
  return { status: res.status(), body: await res.json() };
}

test('글꼴: Pretendard Variable을 같은 출처에서만 내려받는다', async ({ page }) => {
  const requests: { url: string; type: string }[] = [];
  page.on('request', (r) => requests.push({ url: r.url(), type: r.resourceType() }));
  await loginAs(page, '한지수');
  await expect(page.getByRole('heading', { name: '지금 처리할 일' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const origin = new URL(page.url()).origin;
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Pretendard Variable');
    return { family: getComputedStyle(document.body).fontFamily, faces: faces.length, loaded: faces.filter((f) => f.status === 'loaded').length };
  });
  expect(font.family.startsWith('"Pretendard Variable"')).toBe(true);
  expect(font.faces).toBeGreaterThan(0);
  expect(font.loaded).toBeGreaterThan(0); // 화면의 한글·숫자에 맞는 서브셋이 실제로 쓰였다
  const fonts = requests.filter((r) => r.type === 'font');
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.filter((r) => !r.url.startsWith(origin + '/'))).toEqual([]);
  expect(requests.filter((r) => !r.url.startsWith(origin + '/') && !r.url.startsWith('data:'))).toEqual([]);
});

test('숫자 열: 1440px에서 표의 숫자 셀은 오른쪽 정렬', async ({ page }) => {
  await loginAs(page, '한지수');
  for (const path of ['/balances', '/activity', '/wallets']) {
    await page.goto(path);
    await page.locator('table td.num').first().waitFor();
    const aligns = await page.locator('table td.num').evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).map((e) => getComputedStyle(e).textAlign));
    expect(aligns.length, path).toBeGreaterThan(0);
    expect(new Set(aligns), path).toEqual(new Set(['right']));
  }
});

test('주소 대조 띠: 상세 화면의 묶음은 같은 굵기·대비, 확인 카드는 서버의 가운데 구간만 테두리', async ({ page }) => {
  await loginAs(page, '오민재');
  // 요청 상세(승인 대기)의 받는 주소: 모든 묶음이 같은 모양이고 테두리 표시는 없다
  await page.goto('/requests/wr-3');
  const reqStrip = page.locator('.addr').first();
  await expect(reqStrip.locator('.addr-chunk').first()).toBeVisible();
  const reqStyles = await chunkStyles(reqStrip);
  expect(reqStyles.length).toBeGreaterThanOrEqual(10);
  expect(new Set(reqStyles).size).toBe(1);
  await expect(reqStrip.locator('.addr-verify')).toHaveCount(0);

  for (const id of ['ab-08', 'ab-09']) { // EVM(묶음 경계와 일치), BTC(묶음 중간에서 시작·끝)
    const a = await (await page.request.get(`/api/addresses/${id}`)).json();
    const body = String(a.address).replace(/^MOCK-[A-Z]+-/, '');
    const serverMiddle = body.slice(a.middle.start - 1, a.middle.end);
    expect(serverMiddle).toBe(middleSegment(a.address).text);
    await page.goto(`/addresses/${id}`);
    // 정보 카드의 띠: 균일, 테두리 없음
    const infoStrip = page.locator('section.card').first().locator('.addr');
    await expect(infoStrip.locator('.addr-chunk').first()).toBeVisible(); // evaluateAll은 기다리지 않으므로 화면이 그려진 뒤 잰다
    expect(new Set(await chunkStyles(infoStrip)).size).toBe(1);
    await expect(infoStrip.locator('.addr-verify')).toHaveCount(0);
    // 확인 카드의 띠: 테두리 친 글자 = 서버가 다시 입력받는 가운데 구간
    const card = page.locator('section.card-action');
    const strip = card.locator('.addr');
    await expect(strip.locator('.addr-verify').first()).toBeVisible();
    expect(await outlinedText(strip), id).toBe(serverMiddle);
    expect(new Set(await chunkStyles(strip)).size).toBe(1);
    const outlines = await strip.locator('.addr-verify').evaluateAll((els) => els.map((e) => `${getComputedStyle(e).outlineStyle} ${getComputedStyle(e).outlineWidth}`));
    expect(new Set(outlines)).toEqual(new Set(['solid 2px']));
    await expect(card.getByText(`가운데 8자리(고유부 ${a.middle.start}~${a.middle.end}번째)입니다.`)).toBeVisible();
    await expect(card.getByText(/고유부는 주소에서 MOCK-[A-Z]+- 다음부터 센 글자입니다/)).toBeVisible();
    await expect(card.getByText('서버')).toHaveCount(0);
  }
});

test('주소 등록: 대조 단계의 띠는 다시 입력할 가운데 구간을 테두리로 보여 준다', async ({ page }) => {
  await loginAs(page, '한지수');
  const address = 'MOCK-EVM-0F1E2D3C4B5A69788796A5B4C3D2E1F00FEDCBA9';
  await page.goto('/addresses/new');
  await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
  await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
  await page.locator('#address').fill(address);
  const strip = page.locator('.verify-box .addr');
  await expect(strip.locator('.addr-verify').first()).toBeVisible();
  expect(await outlinedText(strip)).toBe(middleSegment(address).text);
  expect(new Set(await chunkStyles(strip)).size).toBe(1);
  await expect(page.getByLabel('원본 주소의 가운데 8자리 (고유부 17~24번째)')).toBeVisible();
});

test('메뉴 배지: 처리할 수 있는 승인 건수만, 중립 색으로 보인다', async ({ page }) => {
  await loginAs(page, '오민재');
  const dash = await (await page.request.get('/api/dashboard')).json();
  const count = (k: string) => dash.tasks.find((t: any) => t.kind === k)?.count ?? 0;
  const expected = count('approve_requests') + count('my_drafts'); // 주소가 사용 중지되어 승인할 수 없는 요청(blocked_requests)은 더하지 않는다
  expect(expected).toBeGreaterThan(0); // 시드: 오민재가 승인할 요청이 있다
  const badge = page.getByRole('link', { name: /결재 및 요청/ }).locator('.nav-badge');
  await expect(badge.locator('[aria-hidden="true"]')).toHaveText(String(expected));
  await expect(page.getByRole('link', { name: new RegExp(`결재 및 요청 처리할 일 ${expected}건`) })).toBeVisible();
  const color = await badge.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, fg: getComputedStyle(e).color }));
  expect(color.fg).toBe('rgb(16, 32, 27)'); // 잉크
  expect(color.bg).not.toBe('rgb(180, 35, 24)'); // 반려·실패용 빨강이 아님
});

test('주소 확인 중 비슷한 주소가 새로 확인되면 점검 결과를 자동으로 다시 불러와 보여 준다', async ({ page }) => {
  // 이 테스트에서만 쓰는 무작위 모의 주소(시드 주소와 겹치지 않음)
  const hex = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const body = hex();
  const flip = (c: string) => ((parseInt(c, 16) + 3) % 16).toString(16).toUpperCase();
  const lookBody = body.slice(0, 4) + [...body.slice(4, -6)].map(flip).join('') + body.slice(-6);
  const first = `MOCK-EVM-${body}`;
  const later = `MOCK-EVM-${lookBody}`;
  const stamp = Date.now().toString(36);
  const firstLabel = `E2E 먼저 등록 ${stamp}`;
  const laterLabel = `E2E 나중 유사 ${stamp}`;
  const create = (address: string, label: string, extra: Record<string, unknown> = {}) => apiPost(page, '/api/addresses', {
    assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '', label, counterparty: '모의 표시 점검 거래처',
    confirmTail: address.slice(-6), confirmMiddle: middleSegment(address).text, lookalikeReason: '', ackNotVerified: true, ackOutOfBandConfirmed: true, ...extra,
  });

  await loginAs(page, '한지수');
  const a = await create(first, firstLabel);
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  const b = await create(later, laterLabel, { lookalikeReason: '거래처와 전화로 두 주소를 각각 대조했습니다' });
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  await logout(page);

  await loginAs(page, '오민재');
  await page.goto(`/addresses/${a.body.address.id}`);
  const card = page.locator('section.card-action');
  await expect(card.getByRole('group', { name: /^이 주소와 기존 주소/ })).toHaveCount(0); // 등록할 때는 비슷한 주소가 없었다
  await page.getByLabel('원본 주소의 끝 6자리').fill(first.slice(-6));
  await page.getByLabel(/원본 주소의 가운데 8자리/).fill(middleSegment(first).text);
  await page.getByRole('button', { name: /사용 가능으로 확인/ }).click();
  const alert = card.getByRole('alert').filter({ hasText: laterLabel });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('갱신된 점검 결과와 글자 비교를 위에 다시 표시했습니다');
  await expect(card.getByRole('group', { name: new RegExp(`^이 주소와 기존 주소 '${laterLabel}'`) })).toBeVisible();
  await expect(page.getByText(/새로 고쳐|새로고침/)).toHaveCount(0);
  await expect(page.getByLabel('원본 주소의 끝 6자리')).toHaveValue(first.slice(-6)); // 입력은 그대로
  await expect(page.getByRole('textbox', { name: /^확인 메모/ })).toBeVisible(); // 이제 확인 메모가 필요하다

  // 정리: 이 테스트에서 만든 두 주소를 거절한다
  for (const id of [a.body.address.id, b.body.address.id]) {
    const cur = await (await page.request.get(`/api/addresses/${id}`)).json();
    const r = await apiPost(page, `/api/addresses/${id}/review`, { decision: 'reject', version: cur.version, note: 'E2E 표시 점검용 주소 정리' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
});

test('상세·작성 화면은 넓은 화면에서도 목록 화면과 왼쪽 기준선이 같고, 내용 폭은 820px까지', async ({ page }) => {
  await loginAs(page, '오민재');
  const left = async (path: string) => {
    await page.goto(path);
    await page.locator('#page-title').waitFor();
    await page.waitForLoadState('networkidle');
    return page.evaluate(() => {
      const p = document.querySelector('.page')!;
      const widest = Math.max(...[...p.children].filter((c) => c.tagName !== 'DIALOG' && c.getClientRects().length > 0).map((c) => c.getBoundingClientRect().width));
      return { left: Math.round(p.getBoundingClientRect().left), widest: Math.round(widest), narrow: p.classList.contains('page-narrow') };
    });
  };
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [list, detail] of [['/addresses', '/addresses/ab-08'], ['/requests', '/requests/wr-3']] as const) {
      const a = await left(list);
      const b = await left(detail);
      expect(b.narrow, detail).toBe(true);
      expect(b.left, `${width}px ${list} → ${detail}`).toBe(a.left);
      expect(b.widest, `${width}px ${detail}`).toBeLessThanOrEqual(820);
    }
  }
});

test('감사 기록: 무결성 확인의 범위를 넘겨 말하지 않고 보관용 값을 보여 준다', async ({ page }) => {
  await loginAs(page, '문태호');
  await page.goto('/audit');
  await expect(page.getByText('무결성 확인됨')).toBeVisible();
  const scope = page.locator('.audit-scope');
  await expect(scope).toContainText('바로 앞 기록의 해시와 맞게 이어지는지를 봅니다');
  await expect(scope).toContainText('기록을 고친 뒤 그 뒤 기록의 해시를 모두 다시 계산한 경우는 이 확인만으로 찾을 수 없습니다');
  await expect(scope).not.toContainText('수정·삭제를 찾아냅니다');
  await expect(scope.locator('.audit-anchor')).toContainText(/보관용 값: 기록 \d+건 · 마지막 기록 해시 [0-9a-f]{64}/);
});
