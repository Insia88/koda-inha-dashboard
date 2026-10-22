import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, logout } from './helpers.ts';

// A3 접근성: 공개 데모에서 확인한 위반 7건(docs/traceability.md 'A3 접근성·CSV')을 하나씩 검사한다.
// 휴대폰 메뉴 서랍의 포커스, sticky 머리글에 가린 포커스, 입력 칸 테두리 대비, 어두운 패널의 포커스 링,
// 처음부터 있는 알림 영역, '요청 보기' 눌림 버튼 묶음, 글자 간격을 늘렸을 때 머리글 조직명.
// A3 검토 반영: 작성 중 확인에 막힌 서랍 메뉴의 포커스 복귀, 알림 줄이 앞 결과·빈 글자를 끼워 쓰지 않음(응답 지연 흉내),
// 점검 미리 보기 오류 문장, 요소 여백과 겹치지 않는 스크롤 위치, 320px 글자 간격.
// 이 파일은 데이터를 바꾸지 않는다(로그인, 점검 미리 보기·주소 형식 점검 조회만. 작성 중인 입력을 버리는 흐름은 저장 전 입력만 버린다).

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** 'rgb(…)'·'rgba(…)' → [r, g, b, a] */
function rgba(css: string): [number, number, number, number] {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`색을 읽을 수 없습니다: ${css}`);
  const [r, g, b, a = '1'] = m[1]!.split(/[\s,/]+/).filter(Boolean);
  return [Number(r), Number(g), Number(b), Number(a)];
}
const luminance = ([r, g, b]: number[]) => {
  const c = [r!, g!, b!].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
/** WCAG 대비(불투명 색끼리) */
function contrast(a: string, b: string): number {
  const x = luminance(rgba(a));
  const y = luminance(rgba(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** 지금 포커스가 있는 곳: 메뉴 안이면 'nav:이름', 머리글 토글이면 'toggle', 그 밖이면 'outside:…' */
const focusWhere = (page: Page) => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null;
  if (!a || a === document.body) return 'outside:body';
  if (a.closest('#sidenav')) return `nav:${(a.textContent ?? '').trim()}`;
  if (a.classList.contains('nav-toggle')) return 'toggle';
  return `outside:${a.tagName}.${a.className}:${(a.textContent ?? '').trim().slice(0, 20)}`;
});
const mainInert = (page: Page) => page.evaluate(() => !!document.getElementById('main')?.closest('[inert]'));

test.describe('휴대폰 메뉴 서랍(390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('열면 포커스가 서랍으로 가고, Tab은 서랍과 토글 안에서만 돌고, Escape로 닫히면 토글로 돌아온다', async ({ page }) => {
    await loginAs(page, '한지수');
    await page.locator('#page-title').waitFor();
    const toggle = page.locator('.topbar .nav-toggle');
    await expect(toggle).toHaveAccessibleName('메뉴 열기');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAccessibleName('메뉴 닫기');
    // 열자마자 포커스는 서랍 안(첫 메뉴)에 있다. 예전에는 서랍 밑에 깔린 토글에 남았다.
    expect(await focusWhere(page)).toBe('nav:홈');
    // 토글은 서랍에 가리지 않고 보이며 누를 수 있다(그 자리의 맨 위 요소가 토글).
    expect(await toggle.evaluate((t) => {
      const r = t.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!top && t.contains(top);
    })).toBe(true);
    // 서랍은 머리글 바로 아래에서 화면 아래 끝까지 이어진다(긴 메뉴는 서랍 안에서 스크롤).
    const geo = await page.evaluate(() => {
      const n = document.getElementById('sidenav')!.getBoundingClientRect();
      return { top: n.top, bottom: n.bottom, headBottom: document.querySelector('.topbar')!.getBoundingClientRect().bottom, vh: window.innerHeight };
    });
    expect(Math.abs(geo.top - geo.headBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(geo.bottom - geo.vh)).toBeLessThanOrEqual(1);
    // 열려 있는 동안 본문·환경 고지·머리글의 다른 버튼은 inert다. 환경 고지는 로컬이면 상단 환경 띠, 공개 데모(배포 확인)면 맨 아래 한 줄이다(A5).
    // 둘 다 없으면 첫 값이 false라 실패한다.
    expect(await mainInert(page)).toBe(true);
    expect(await page.evaluate(() => [document.querySelector('.env-ribbon') ?? document.querySelector('.demo-footer'), ...['.skip-link', '.topbar-send', '.topbar-user'].map((s) => document.querySelector(s))]
      .map((el) => !!el?.closest('[inert]')))).toEqual([true, true, true, true]);
    expect(await toggle.evaluate((t) => !!t.closest('[inert]'))).toBe(false);

    // Tab을 메뉴 수보다 넉넉히 눌러도 서랍과 토글 밖으로 나가지 않는다(끝에서 토글로 돌아온다).
    const links = await page.locator('#sidenav a').count();
    const seen: string[] = [];
    for (let i = 0; i < links + 3; i++) {
      await page.keyboard.press('Tab');
      seen.push(await focusWhere(page));
    }
    expect(seen.filter((w) => !/^(nav:|toggle$)/.test(w)), seen.join(' → ')).toEqual([]);
    expect(seen).toContain('toggle');
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusWhere(page)).toMatch(/^(nav:|toggle$)/);
    }

    // Escape로 닫히고 포커스는 토글로 돌아오며, 본문의 inert가 풀린다.
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await expect(page.locator('#sidenav').getByRole('link', { name: '잔고' })).toBeHidden();
    expect(await mainInert(page)).toBe(false);
  });

  test('막을 눌러 닫으면 토글로, 메뉴 링크로 이동하면 새 화면 제목으로 포커스가 간다', async ({ page }) => {
    await loginAs(page, '한지수');
    await page.locator('#page-title').waitFor();
    const toggle = page.locator('.topbar .nav-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.mouse.click(360, 600);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    expect(await mainInert(page)).toBe(false);

    await toggle.click();
    await page.locator('#sidenav').getByRole('link', { name: '잔고' }).click();
    await expect(page.getByRole('heading', { name: '잔고', level: 1 })).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await mainInert(page)).toBe(false);
  });

  // A3 검토: 서랍 링크가 서랍을 먼저 닫고(숨김) 이동은 작성 중 확인에 막히면, 확인 대화상자가 숨겨진 링크를 돌아갈 곳으로 기억해
  // 「계속 작성」 뒤 포커스가 문서 맨 앞(body)으로 떨어졌다. 이제 링크를 고르면 포커스를 먼저 토글로 돌려주므로 대화상자가 토글로 돌려준다.
  test('작성 중인 화면에서 서랍 메뉴를 고르고 이탈 확인에서 「계속 작성」을 고르면 포커스가 토글로 돌아오고, 「작성 내용 버리기」면 새 화면 제목으로 간다', async ({ page }) => {
    await loginAs(page, '한지수');
    await page.goto('/requests/new');
    await page.locator('#page-title').waitFor();
    await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
    const toggle = page.locator('.topbar .nav-toggle');
    const dialog = page.getByRole('alertdialog', { name: '작성 중인 내용이 있습니다' });
    for (const key of ['Enter', 'Escape']) {
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(await focusWhere(page)).toBe('nav:홈');
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: '계속 작성' })).toBeFocused();
      // Enter는 「계속 작성」을 누르고, Escape는 안전한 선택(계속 작성)으로 닫는다
      await page.keyboard.press(key);
      await expect(dialog).toBeHidden();
      await expect(toggle, key).toBeFocused();
      await expect(page).toHaveURL(/\/requests\/new$/);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(await mainInert(page)).toBe(false);
      // 입력은 그대로이고, 다음 Tab은 문서 맨 앞('본문으로 건너뛰기')이 아니라 토글 다음 요소로 간다
      await expect(page.getByRole('combobox', { name: /^자산/ })).toHaveValue('USDC');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.classList.contains('skip-link') ?? false)).toBe(false);
    }
    // 버리고 떠나면 새 화면(홈)의 제목이 포커스를 받는다
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '작성 내용 버리기' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#page-title')).toBeFocused();
    expect(await mainInert(page)).toBe(false);
  });

  test('접근성 자동 검사: 서랍을 연 상태(390px)', async ({ page }) => {
    await loginAs(page, '한지수');
    await page.locator('#page-title').waitFor();
    await page.waitForLoadState('networkidle');
    await page.locator('.topbar .nav-toggle').click();
    await expect(page.locator('#sidenav').getByRole('link', { name: '잔고' })).toBeVisible();
    // A3의 서랍 상태(포커스는 서랍 안, 서랍 밖은 inert)를 검사한다
    expect(await focusWhere(page)).toBe('nav:홈');
    expect(await mainInert(page)).toBe(true);
    const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  });
});

test.describe('sticky 머리글에 가린 포커스', () => {
  // 결정 카드(승인자)가 있는 요청 상세에서 본문의 포커스 대상을 맨 아래부터 Shift+Tab으로 거꾸로 지나간다.
  // 매번 다음에 포커스를 받을 요소를 머리글(.topbar) 밑(위에서 10px)에 걸쳐 둔다. 사용자가 위로 조금 스크롤해 그 요소가
  // 머리글 밑에 들어가 있는 상태다(공개 데모에서 '복사'가 완전히 가려진 경우). 브라우저는 화면 안에 있는 요소를 스크롤하지 않으므로,
  // 머리글 높이를 스크롤 여백(scroll-padding-top)으로 알려 주지 않으면 포커스가 머리글 밑에 남는다.
  // 머리글 아래 공간보다 작은 요소는 머리글과 전혀 겹치지 않아야 하고, 더 큰 요소는 일부라도 머리글 아래에 보여야 한다.
  for (const [width, height] of [[1440, 900], [390, 844], [320, 256]] as const) {
    test(`Shift+Tab으로 거꾸로 이동해도 포커스가 머리글 밑에 가리지 않는다 ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await loginAs(page, '오민재');
      await page.goto('/requests/wr-4');
      await page.locator('#page-title').waitFor();
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('button', { name: '복사' }).first()).toBeVisible();
      const total = await page.evaluate(() => {
        const sel = ['a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])', 'textarea:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])'];
        const els = [...document.querySelectorAll<HTMLElement>(sel.map((s) => `#main ${s}`).join(', '))].filter((e) => e.getClientRects().length > 0);
        (window as unknown as { a3Focusables: HTMLElement[] }).a3Focusables = els;
        return els.length;
      });
      expect(total).toBeGreaterThan(5);
      const problems: string[] = [];
      const names: string[] = [];
      for (let i = total - 1; i >= 1; i--) {
        const ready = await page.evaluate((idx) => {
          const els = (window as unknown as { a3Focusables: HTMLElement[] }).a3Focusables;
          els[idx]!.focus({ preventScroll: true });
          const target = els[idx - 1]!;
          window.scrollBy(0, target.getBoundingClientRect().top - 10);
          return document.activeElement === els[idx];
        }, i);
        if (!ready) continue;
        await page.keyboard.press('Shift+Tab');
        const m = await page.evaluate((idx) => {
          const target = (window as unknown as { a3Focusables: HTMLElement[] }).a3Focusables[idx - 1]!;
          if (document.activeElement !== target) return null;
          const head = document.querySelector('.topbar')!.getBoundingClientRect();
          const r = target.getBoundingClientRect();
          return { name: (target.getAttribute('aria-label') ?? target.textContent ?? target.tagName).trim().slice(0, 30), top: r.top, bottom: r.bottom, height: r.height, headBottom: head.bottom, vh: window.innerHeight };
        }, i);
        if (!m) continue;
        names.push(m.name);
        const room = m.vh - m.headBottom;
        if (m.height <= room ? m.top < m.headBottom - 0.5 : m.bottom <= m.headBottom + 0.5) {
          problems.push(`${m.name}: top ${m.top.toFixed(1)} bottom ${m.bottom.toFixed(1)} / 머리글 아래 끝 ${m.headBottom.toFixed(1)}`);
        }
      }
      // 결정 카드의 받는 주소 '복사' 버튼을 지나갔다.
      expect(names.length).toBeGreaterThan(5);
      expect(names).toContain('복사');
      expect(problems).toEqual([]);
    });
  }

  // A3 검토: 전역 scroll-padding-top(72px)에 요소별 scroll-margin-top(72px)이 더해져, 화면이 다음 할 일 패널로 포커스를 옮길 때
  // (RequestDetail의 scrollIntoView({ block: 'nearest' })) 패널이 머리글 아래 끝(56px)에서 88px 더 내려간 144px에 놓였다.
  test('다음 할 일 패널로 스크롤하면 머리글 바로 아래(72px)에 온다(여백이 두 번 더해지지 않는다) 390x500', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 500 });
    await loginAs(page, '한지수');
    await page.goto('/requests/wr-3');
    const panel = page.locator('section.next-action');
    await panel.waitFor();
    await page.waitForLoadState('networkidle');
    const m = await panel.evaluate((el) => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
      return { top: el.getBoundingClientRect().top, headBottom: document.querySelector('.topbar')!.getBoundingClientRect().bottom, scrolled: window.scrollY };
    });
    expect(m.scrolled).toBeGreaterThan(0);
    expect(m.top).toBeGreaterThanOrEqual(m.headBottom);
    expect(Math.abs(m.top - 72), `패널 위 ${m.top} / 머리글 아래 끝 ${m.headBottom}`).toBeLessThanOrEqual(1);
  });
});

test('입력 칸(input·select·textarea) 테두리는 칸 안쪽과 바깥 바탕 모두와 3:1 이상이다', async ({ page }) => {
  await loginAs(page, '한지수');
  const rows: { path: string; id: string; border: string; inner: string; outer: string }[] = [];
  for (const path of ['/requests/new', '/addresses/new', '/requests', '/requests/wr-5']) {
    await page.goto(path);
    await page.locator('#page-title').waitFor();
    await page.waitForLoadState('networkidle');
    rows.push(...(await page.evaluate((p) => {
      const opaque = (el: Element | null): string => {
        for (let e = el; e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          if (!/rgba\(.*,\s*0\)$/.test(c) && c !== 'transparent') return c;
        }
        return 'rgb(255, 255, 255)';
      };
      return [...document.querySelectorAll<HTMLInputElement>('input, select, textarea')]
        .filter((el) => !['checkbox', 'radio', 'hidden', 'file'].includes(el.type) && el.getClientRects().length > 0)
        .map((el) => ({ path: p, id: el.id || el.getAttribute('aria-label') || el.name || el.tagName, border: getComputedStyle(el).borderTopColor, inner: opaque(el), outer: opaque(el.parentElement) }));
    }, path)));
  }
  expect(rows.length).toBeGreaterThan(5);
  const weak = rows
    .map((r) => ({ ...r, inside: contrast(r.border, r.inner), outside: contrast(r.border, r.outer) }))
    .filter((r) => r.inside < 3 || r.outside < 3)
    .map((r) => `${r.path} ${r.id}: ${r.border} / 안 ${r.inside.toFixed(2)} · 바깥 ${r.outside.toFixed(2)}`);
  expect(weak).toEqual([]);
});

test('어두운 다음 할 일 패널 안 링크의 포커스 링은 패널 바탕과 3:1 이상이다', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/requests/wr-3');
  const panel = page.locator('section.next-action');
  const link = panel.getByRole('link', { name: '「조직 관리」' });
  await expect(link).toBeVisible();
  await panel.focus();
  await page.keyboard.press('Tab');
  await expect(link).toBeFocused();
  const m = await link.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { focusVisible: el.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: cs.outlineColor, panel: getComputedStyle(el.closest('.next-action')!).backgroundColor };
  });
  expect(m.focusVisible).toBe(true);
  expect(m.style).toBe('solid');
  expect(m.width).toBeGreaterThanOrEqual(2);
  expect(contrast(m.color, m.panel), `${m.color} / ${m.panel}`).toBeGreaterThanOrEqual(3);
  // 패널 밖(밝은 바탕)으로 나가면 포커스 링은 그대로 파랑이다.
  await page.keyboard.press('Tab');
  const outside = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    return { inPanel: !!a.closest('.next-action'), visible: a.matches(':focus-visible'), color: getComputedStyle(a).outlineColor };
  });
  expect(outside).toEqual({ inPanel: false, visible: true, color: 'rgb(31, 79, 191)' });
});

test.describe('상태 알림 영역', () => {
  /** 요소에 표시를 남겨, 내용이 바뀐 뒤에도 같은 요소(새로 그린 것이 아님)인지 본다. */
  const mark = (page: Page, selector: string) => page.locator(selector).evaluate((el) => { (el as unknown as { a3Mark: boolean }).a3Mark = true; });
  const marked = (page: Page, selector: string) => page.locator(selector).evaluate((el) => (el as unknown as { a3Mark?: boolean }).a3Mark === true);
  /** 알림 영역의 글자가 바뀔 때마다 그때의 글자를 기록한다(화면 낭독기가 받는 변경 순서). takeLog로 꺼내고 비운다. */
  const recordText = (page: Page, selector: string) => page.locator(selector).evaluate((el) => {
    const w = window as unknown as { a3Log: string[] };
    w.a3Log = [];
    new MutationObserver(() => w.a3Log.push(el.textContent ?? '')).observe(el, { childList: true, characterData: true, subtree: true });
  });
  const takeLog = (page: Page) => page.evaluate(() => {
    const w = window as unknown as { a3Log?: string[] };
    const log = w.a3Log ?? [];
    w.a3Log = [];
    return log;
  });

  test('출금 요청 작성: 수량 미리 보기와 점검 요약 알림 영역은 처음부터 비어 있고, 점검은 목록 대신 요약 한 줄만 알린다', async ({ page }) => {
    await loginAs(page, '한지수');
    await page.goto('/requests/new');
    await page.locator('#page-title').waitFor();
    const amount = page.locator('output.amount-preview');
    const checks = page.locator('.rc-live');
    await expect(amount).toHaveCount(1);
    await expect(amount).toHaveText('');
    await expect(checks).toHaveCount(1);
    await expect(checks).toHaveAttribute('role', 'status');
    await expect(checks).toHaveText('');
    await mark(page, 'output.amount-preview');
    await mark(page, '.rc-live');

    await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
    await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
    await page.getByLabel(/받는 주소/).selectOption({ label: '모의 거래소 A 입금 (USDC) — 모의 거래소 A' });
    await page.getByLabel(/수량/).fill('3');
    await expect(amount).toContainText('읽은 수량 3 USDC');
    await expect(page.locator('.rc-block')).toBeVisible();
    await expect(checks).toHaveText(/^출금 전 점검: (주의|확인 불가|기준 이내) \d+건(, (확인 불가|기준 이내) \d+건)*$/);
    // 같은 요소의 내용만 바뀌었다(알림 영역을 새로 그리지 않음).
    expect(await marked(page, 'output.amount-preview')).toBe(true);
    expect(await marked(page, '.rc-live')).toBe(true);
    // 점검 목록 전체는 알림 영역 밖에 있다(요약 한 줄만 알린다).
    expect(await page.locator('.rc-block').evaluate((el) => !!el.closest('[aria-live], [role="status"], output'))).toBe(false);

    // A3 검토: 수량을 바꿔 새 미리 보기를 불러오는 동안 요약 줄을 비우지 않는다(비웠다가 같은 문장을 다시 쓰면 멈출 때마다 같은 요약을 다시 읽는다).
    // 공개 데모의 응답 지연을 흉내 내 미리 보기 응답을 600ms 늦추고, 요약 줄의 글자가 바뀔 때마다 기록한다.
    await page.route('**/api/requests/checks-preview', async (route) => { await new Promise((r) => setTimeout(r, 600)); await route.continue(); });
    const first = await checks.textContent();
    await recordText(page, '.rc-live');
    const preview = page.waitForResponse((r) => r.url().endsWith('/api/requests/checks-preview'));
    await page.getByLabel(/수량/).press('End');
    await page.keyboard.type('0');
    await expect(amount).toContainText('읽은 수량 30 USDC');
    await preview;
    await expect(page.locator('.rc-block')).toBeVisible();
    await expect(checks).toHaveText(/^출금 전 점검: /);
    const log = await takeLog(page);
    expect(log, log.join(' → ')).not.toContain('');
    // 요약이 같으면 알림 줄은 한 번도 바뀌지 않고, 달라졌으면 새 요약을 한 번만 쓴다
    const now = await checks.textContent();
    expect(log).toEqual(now === first ? [] : [now]);

    // 수량을 지우면 미리 보기 알림 영역은 남은 채 비워진다.
    await page.getByLabel(/수량/).fill('');
    await expect(amount).toHaveText('');
    expect(await marked(page, 'output.amount-preview')).toBe(true);
  });

  test('주소 등록: 형식 점검 알림 영역은 처음부터 비어 있고 같은 요소에 결과가 들어온다', async ({ page }) => {
    await loginAs(page, '한지수');
    await page.goto('/addresses/new');
    await page.locator('#page-title').waitFor();
    const live = page.locator('.findings');
    await expect(live).toHaveCount(1);
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText('');
    await mark(page, '.findings');
    await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
    await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
    await page.locator('#address').fill('MOCK-BTC-ABCDEFGHJKLMNPQRSTUV');
    await expect(live).toContainText(/Ethereum 형식이 아닙니다.*Bitcoin/);
    expect(await marked(page, '.findings')).toBe(true);
  });

  test('결재 및 요청: 결과 줄이 늘 있어 0건도 같은 알림 영역으로 알린다', async ({ page }) => {
    await loginAs(page, '한지수');
    await page.goto('/requests');
    await page.locator('#page-title').waitFor();
    const live = page.locator('.req-result');
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveText(/^전체 요청 \d+건 중 1–\d+$/);
    await mark(page, '.req-result');
    await page.getByRole('searchbox', { name: '요청 검색' }).fill('없는-요청-A3');
    await page.keyboard.press('Enter');
    await expect(page.getByText('조건에 맞는 요청이 없습니다')).toBeVisible();
    await expect(live).toHaveText('조건에 맞는 요청 0건');
    expect(await marked(page, '.req-result')).toBe(true);
    // 범위 밖 페이지도 같은 줄이 알린다(보이는 빈 결과 안내와 다른 문장).
    await page.goto('/requests?page=99');
    await expect(page.getByText('이 페이지에는 요청이 없습니다', { exact: true })).toBeVisible();
    await expect(live).toHaveText(/^전체 요청 \d+건 · 99페이지에는 요청 없음$/);
    // 결과가 있는 동안 페이지 줄(pager-info)은 알림 영역이 아니다(같은 내용을 두 번 읽지 않게).
    await page.goto('/requests');
    await expect(page.locator('.pager-info')).toBeVisible();
    await expect(page.locator('.pager-info')).not.toHaveAttribute('aria-live', /.+/);
  });

  // A3 검토: 보기·상태를 바꾸면 새 결과가 올 때까지 앞 결과가 남아 있어, 결과 줄이 새 조건과 앞 결과의 건수를 섞은
  // '조건에 맞는 요청 6건 중 1–6'을 먼저 쓰고 '1건 중 1–1'로 고쳐 썼다(화면 낭독기는 틀린 건수를 먼저 듣는다).
  test('결재 및 요청: 보기·상태를 바꾸면 결과 줄은 새 결과의 건수만 한 번 쓴다(앞 결과의 건수를 먼저 쓰지 않음)', async ({ page }) => {
    await loginAs(page, '강도윤');
    await page.goto('/requests');
    await page.locator('#page-title').waitFor();
    const live = page.locator('.req-result');
    await expect(live).toHaveText(/^전체 요청 \d+건 중 1–\d+$/);
    await page.waitForLoadState('networkidle');
    // 공개 데모의 응답 지연을 흉내 내 목록 조회만 500ms 늦춘다.
    await page.route((url) => url.pathname === '/api/requests', async (route) => { await new Promise((r) => setTimeout(r, 500)); await route.continue(); });
    await recordText(page, '.req-result');
    const steps = [
      { what: "보기 '내가 승인할 요청'", button: page.getByRole('group', { name: '요청 보기' }).getByRole('button', { name: /^내가 승인할 요청/ }), match: (u: URL) => u.searchParams.get('view') === 'to_approve' && !u.searchParams.get('status') },
      { what: "상태 칩 '완료'", button: page.getByRole('group', { name: '상태 필터' }).getByRole('button', { name: /^완료/ }), match: (u: URL) => u.searchParams.get('view') === 'to_approve' && u.searchParams.get('status') === 'COMPLETED' },
      { what: "보기 '조직 전체'", button: page.getByRole('group', { name: '요청 보기' }).getByRole('button', { name: '조직 전체' }), match: (u: URL) => !u.searchParams.get('view') && u.searchParams.get('status') === 'COMPLETED' },
    ];
    for (const step of steps) {
      const before = await live.textContent();
      const response = page.waitForResponse((r) => { const u = new URL(r.url()); return u.pathname === '/api/requests' && step.match(u); });
      await step.button.focus();
      await page.keyboard.press('Enter');
      const { total } = await (await response).json() as { total: number };
      const expected = total === 0 ? '조건에 맞는 요청 0건' : `조건에 맞는 요청 ${total}건 중 1–${Math.min(total, 10)}`;
      await expect(live).toHaveText(expected);
      const log = await takeLog(page);
      expect(log, `${step.what}: ${before} → ${log.join(' → ')}`).toEqual(before === expected ? [] : [expected]);
    }
  });

  test('출금 요청 작성: 점검 미리 보기를 불러오지 못했거나 고른 주소를 쓸 수 없으면 그 문장을 알림 줄이 알리고, 같은 보이는 문장은 낭독기에서 숨긴다', async ({ page }) => {
    let reply: 'error' | 'inactive' = 'error';
    await page.route('**/api/requests/checks-preview', (route) => route.fulfill(reply === 'error'
      ? { status: 500, contentType: 'application/json', body: '{}' }
      : { status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ADDRESS_NOT_ACTIVE', message: '받는 주소를 지금 쓸 수 없습니다.', action: '사용 가능한 다른 받는 주소를 고르세요.' } }) }));
    await loginAs(page, '한지수');
    await page.goto('/requests/new');
    await page.locator('#page-title').waitFor();
    const checks = page.locator('.rc-live');
    await expect(checks).toHaveText('');
    await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
    await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
    await page.getByLabel(/받는 주소/).selectOption({ label: '모의 거래소 A 입금 (USDC) — 모의 거래소 A' });
    await page.getByLabel(/수량/).fill('3');

    const LOAD_ERROR = '출금 전 점검 미리 보기를 불러오지 못했습니다. 검토 단계에서 다시 보여 드립니다.';
    await expect(checks).toHaveText(LOAD_ERROR);
    const loadShown = page.locator('p:not(.rc-live)', { hasText: LOAD_ERROR });
    await expect(loadShown).toHaveCount(1);
    await expect(loadShown).toBeVisible();
    await expect(loadShown).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.rc-block')).toHaveCount(0);

    reply = 'inactive';
    await page.getByLabel(/수량/).fill('4');
    const INACTIVE = '고른 받는 주소를 지금 쓸 수 없어 출금 전 점검을 보여 드리지 않습니다. 사용 가능한 다른 받는 주소를 고르세요.';
    await expect(checks).toHaveText(INACTIVE);
    const inactiveShown = page.locator('p:not(.rc-live)', { hasText: INACTIVE });
    await expect(inactiveShown).toHaveCount(1);
    await expect(inactiveShown).toBeVisible();
    await expect(inactiveShown).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('p:not(.rc-live)', { hasText: LOAD_ERROR })).toHaveCount(0);
  });
});

test('요청 보기: 탭이 아니라 상태 칩과 같은 눌림 버튼 묶음이고, 320px에서도 모두 보인다', async ({ page }) => {
  await loginAs(page, '강도윤');
  await page.goto('/requests');
  await page.locator('#page-title').waitFor();
  const group = page.getByRole('group', { name: '요청 보기' });
  await expect(group).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  const buttons = group.getByRole('button');
  await expect(buttons).toHaveText(['조직 전체', /^내가 승인할 요청/, /^내가 작성한 요청/, '승인 불가(주소 중지)']);
  await expect(group.getByRole('button', { pressed: true })).toHaveText('조직 전체');
  await expect(group.getByRole('button', { pressed: false })).toHaveCount(3);
  await group.getByRole('button', { name: '승인 불가(주소 중지)' }).click();
  await expect(page).toHaveURL(/view=blocked/);
  await expect(group.getByRole('button', { pressed: true })).toHaveText('승인 불가(주소 중지)');
  // 모든 보기 버튼이 Tab 순서에 있다(눌림 버튼은 각각 Tab으로 간다).
  expect(await buttons.evaluateAll((els) => els.map((e) => (e as HTMLElement).tabIndex))).toEqual([0, 0, 0, 0]);

  await page.setViewportSize({ width: 320, height: 640 });
  const boxes = await buttons.evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    const g = e.parentElement!.getBoundingClientRect();
    return { text: (e.textContent ?? '').trim(), left: r.left, right: r.right, gLeft: g.left, gRight: g.right };
  }));
  for (const b of boxes) {
    expect(b.left, b.text).toBeGreaterThanOrEqual(0);
    expect(b.right, b.text).toBeLessThanOrEqual(320);
    expect(b.left, b.text).toBeGreaterThanOrEqual(b.gLeft - 0.5);
    expect(b.right, b.text).toBeLessThanOrEqual(b.gRight + 0.5);
  }
  expect(await page.locator('.tabs').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test.describe('글자 간격(1.4.12) 390·320px', () => {
  // WCAG 1.4.12 검사 값: 줄 간격 1.5, 자간 0.12em, 단어 간격 0.16em, 문단 아래 2em
  const SPACING = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }';
  // 320px(A3 검토)은 머리글 '출금 요청 작성'이 아이콘만 보이는 사람(요청 권한) 셋을 모두 본다. 글자 간격을 늘리면 조직명은 두 줄이 된다.
  const CASES = [
    { width: 390, users: ['한지수', '배서준'] },
    { width: 320, users: ['한지수', '배서준', '강도윤'] },
  ] as const;

  for (const { width, users } of CASES) {
    test(`글자 간격을 늘려도 머리글 조직명이 잘리지 않고 머리글 안에 있다 ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      for (const user of users) {
        await loginAs(page, user);
        for (const path of ['/', '/requests']) {
          await page.goto(path);
          await page.locator('#page-title').waitFor();
          const measure = () => page.evaluate(() => {
            const el = document.querySelector('.topbar .org-name-text') as HTMLElement;
            const head = document.querySelector('.topbar')!.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            const tag = document.querySelector('.topbar .mock-tag')!.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(el);
            const lines = new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size;
            return { text: el.textContent, name: el.title, lines, sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight, top: r.top, bottom: r.bottom, headTop: head.top, headBottom: head.bottom, tagWidth: tag.width };
          });
          const normal = await measure();
          // 보통 간격의 390px에서는 지금처럼 한 줄이다(줄을 바꾸는 것은 글자 간격을 늘렸을 때뿐). 320px에서도 잘리지 않는다.
          if (width === 390) expect(normal.lines, `${user} ${path} 보통 간격`).toBe(1);
          expect(normal.sh, `${user} ${path} 보통 간격 세로 ${normal.ch}/${normal.sh}`).toBeLessThanOrEqual(normal.ch);
          await page.addStyleTag({ content: SPACING });
          const m = await measure();
          const where = `${user} ${width}px ${path} '${m.text}'`;
          // 글자는 그대로(조직 이름 전체, 'A'·'B'까지)이고 가로·세로로 잘리지 않으며 머리글 안에 있다
          expect(m.text, where).toMatch(/^모의법인 [AB]$/);
          expect(m.text, where).toBe(m.name);
          expect(m.sw, `${where} 가로 ${m.cw}/${m.sw}`).toBeLessThanOrEqual(m.cw);
          expect(m.sh, `${where} 세로 ${m.ch}/${m.sh}`).toBeLessThanOrEqual(m.ch);
          expect(m.top, where).toBeGreaterThanOrEqual(m.headTop);
          expect(m.bottom, where).toBeLessThanOrEqual(m.headBottom);
          expect(m.tagWidth, `${where} 모의 표시`).toBeGreaterThan(20);
        }
        await logout(page);
      }
    });
  }
});

test.describe('접근성 자동 검사(A3 화면 상태)', () => {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    test(`출금 요청 작성 미리 보기·주소 형식 점검·요청 보기·다음 할 일 ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await loginAs(page, '한지수');
      const check = async (label: string) => {
        await page.waitForLoadState('networkidle');
        const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        expect(r.violations.map((v) => `${label} ${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
      };
      await page.goto('/requests/new');
      await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
      await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
      await page.getByLabel(/받는 주소/).selectOption({ label: '모의 거래소 A 입금 (USDC) — 모의 거래소 A' });
      await page.getByLabel(/수량/).fill('3');
      // 점검 목록이 그려진 뒤 검사한다(.rc-block은 A3 전에도 있어 고치기 전 빌드에서도 axe까지 간다. 요약 줄 글자는 알림 영역 검사가 본다)
      await expect(page.locator('.rc-block')).toBeVisible();
      await check('/requests/new');
      await page.goto('/addresses/new');
      await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
      await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
      await page.locator('#address').fill('MOCK-BTC-ABCDEFGHJKLMNPQRSTUV');
      await expect(page.locator('.findings')).not.toHaveText('');
      await check('/addresses/new');
      await page.goto('/requests?view=blocked');
      await page.locator('#page-title').waitFor();
      await check('/requests?view=blocked');
      await page.goto('/requests/wr-3');
      await page.locator('section.next-action').waitFor();
      await check('/requests/wr-3');
    });
  }
});
