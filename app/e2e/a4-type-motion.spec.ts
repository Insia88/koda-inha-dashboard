import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs } from './helpers.ts';

// A4 서체·모션(DESIGN.md '서체'·'모션'): 글자 크기 8단계와 굵기 4단계, 식별자 전용 고정폭(Source Code Pro),
// 자료 숫자의 고정폭 숫자, 짧은 피드백 모션과 줄인 움직임에서의 정지, 글꼴이 늦게 와도 자리가 거의 그대로인지 본다.
// 데스크톱 프로젝트(1440px)에서 돌고, 390px은 각 검사가 창 크기를 바꾼다. 화면 데이터는 바꾸지 않는다(주소 등록은 제출하지 않음).

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PHONE = { width: 390, height: 844 };

type Screen = { user: string; path: string; ready: (page: Page) => Promise<void> };
const SCREENS: Screen[] = [
  { user: '한지수', path: '/', ready: async (page) => { await page.locator('.total-value').filter({ visible: true }).first().waitFor(); } },
  { user: '오민재', path: '/requests/wr-4', ready: async (page) => { await page.locator('.rc-intent-value').waitFor(); } },
  { user: '한지수', path: '/balances', ready: async (page) => { await page.locator('.total-value').waitFor(); } },
  {
    user: '한지수', path: '/addresses/new', ready: async (page) => {
      // 대조 띠가 보일 때까지만 채운다(제출하지 않음).
      await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
      await page.getByRole('combobox', { name: /^네트워크/ }).selectOption('ETHEREUM');
      await page.locator('#address').fill('MOCK-EVM-0F1E2D3C4B5A69788796A5B4C3D2E1F00FEDCBA9');
      await page.locator('.verify-box .addr-chunk').first().waitFor();
    },
  },
];

async function open(page: Page, s: Screen) {
  await loginAs(page, s.user);
  await page.goto(s.path);
  await page.locator('#page-title').waitFor();
  await s.ready(page);
  await page.waitForLoadState('networkidle');
}

/**
 * 자기 글자(빈칸이 아닌 글자 노드)를 가진 보이는 요소 가운데 눈금 밖 크기·굵기를 쓴 것(scale)과,
 * 행간이 글자 크기의 1.2~1.75배를 벗어난 블록 요소(leading). 본문 행간이 24px 절대값이라 글자 크기만 정한 요소는 24px을 물려받는다
 * (A4 검토: 공개 데모 띠가 13/24·12/24가 되어 4px 높아졌다). 줄 안의 글자(display: inline)는 줄 높이를 부모가 정하므로 보지 않는다.
 */
function offScale(page: Page, allow28OnTotal: boolean) {
  return page.evaluate((allow28) => {
    const sizes = new Set([12, 13, 14, 15, 17, 20, 24, 32]);
    const weights = new Set(['400', '500', '600', '700']);
    const scale: string[] = [];
    const leading: string[] = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (['OPTION', 'SCRIPT', 'STYLE'].includes(el.tagName)) continue;
      if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')) continue;
      if (el.getClientRects().length === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      const name = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent ?? '').trim().slice(0, 24)}"`;
      const size = parseFloat(cs.fontSize);
      const sizeOk = sizes.has(size) || (allow28 && size === 28 && !!el.closest('.total-value'));
      if (!sizeOk || !weights.has(cs.fontWeight)) scale.push(`${name} ${cs.fontSize}/${cs.fontWeight}`);
      if (cs.display !== 'inline' && cs.display !== 'contents' && cs.lineHeight !== 'normal') {
        const ratio = parseFloat(cs.lineHeight) / size;
        if (ratio < 1.2 || ratio > 1.75) leading.push(`${name} ${cs.fontSize}/${cs.lineHeight}`);
      }
    }
    return { scale, leading };
  }, allow28OnTotal);
}

test.describe('글자 눈금: 크기 12·13·14·15·17·20·24·32, 굵기 400·500·600·700, 행간 1.2~1.75배', () => {
  for (const s of SCREENS) {
    test(`${s.path} (${s.user}) 1440px·390px`, async ({ page }) => {
      await open(page, s);
      const wide = await offScale(page, false);
      expect(wide.scale, '1440px 크기·굵기').toEqual([]);
      expect(wide.leading, '1440px 행간').toEqual([]);
      await page.setViewportSize(PHONE);
      await page.reload();
      await page.locator('#page-title').waitFor();
      await s.ready(page);
      await page.waitForLoadState('networkidle');
      // 좁은 화면의 총 평가액만 28px(--fs-metric)을 쓴다
      const narrow = await offScale(page, true);
      expect(narrow.scale, '390px 크기·굵기').toEqual([]);
      expect(narrow.leading, '390px 행간').toEqual([]);
    });
  }
});

test('식별자 글꼴: 지문·주소 묶음은 Adobe Source Code Pro, 홈·요청 목록은 그 파일을 받지 않는다', async ({ page }) => {
  const monoRequests: string[] = [];
  page.on('request', (r) => { if (r.url().includes('SourceCodeVF')) monoRequests.push(new URL(r.url()).pathname); });
  await loginAs(page, '오민재');
  // 홈·요청 목록에는 고정폭 글자가 없다(요청 번호 .ref는 Pretendard 고정폭 숫자)
  await page.goto('/');
  await page.locator('.progress-item .ref').first().waitFor();
  await page.waitForLoadState('networkidle');
  await page.goto('/requests');
  await page.locator('.req-item .ref').first().waitFor();
  await page.waitForLoadState('networkidle');
  expect(await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => getComputedStyle(e).fontFamily.startsWith('"Source Code Pro Variable"') && e.getClientRects().length > 0 && (e.textContent ?? '').trim() !== '').length)).toBe(0);
  expect(await page.locator('.req-item .ref').first().evaluate((e) => getComputedStyle(e).fontFamily)).toMatch(/^"Pretendard Variable"/);
  expect(monoRequests, '홈·요청 목록에서 받은 고정폭 글꼴').toEqual([]);

  // 요청 상세: 승인 대상 지문과 주소 묶음
  await page.goto('/requests/wr-4');
  await page.locator('.rc-intent-value').waitFor();
  await page.waitForLoadState('networkidle');
  const mono = await page.evaluate(async () => {
    await document.fonts.ready;
    const fam = (s: string) => getComputedStyle(document.querySelector(s)!).fontFamily;
    const faces = [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Source Code Pro Variable');
    const lig = (s: string) => getComputedStyle(document.querySelector(s)!).fontVariantLigatures;
    return { intent: fam('.rc-intent-value'), chunk: fam('.addr-chunk'), loaded: faces.filter((f) => f.status === 'loaded').length, lig: [lig('.rc-intent-value'), lig('.addr-code')] };
  });
  expect(mono.intent.startsWith('"Source Code Pro Variable"')).toBe(true);
  expect(mono.chunk.startsWith('"Source Code Pro Variable"')).toBe(true);
  expect(mono.loaded).toBeGreaterThan(0);
  expect(mono.lig).toEqual(['none', 'none']);
  // 같은 출처에서 한 번, Adobe 원본 이름 그대로(빌드가 붙인 해시만 다름)
  expect(monoRequests.length).toBe(1);
  expect(monoRequests[0]).toMatch(/^\/assets\/SourceCodeVF-Upright\.ttf-[\w-]+\.woff2$/);
});

/** 고정폭 숫자를 쓰는 보이는 글자 요소 가운데 글꼴 스택에 'Pretendard Fallback Tnum'이 없는 것(styles.css의 두 목록이 어긋났는지) */
function tnumWithoutFallback(page: Page) {
  return page.evaluate(() => [...document.body.querySelectorAll('*')].filter((el) => {
    if (!el.getClientRects().length) return false;
    if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '')) return false;
    const cs = getComputedStyle(el);
    return cs.fontVariantNumeric.includes('tabular-nums') && cs.fontFamily.startsWith('"Pretendard Variable"') && !cs.fontFamily.includes('Pretendard Fallback Tnum');
  }).map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent ?? '').trim().slice(0, 24)}"`));
}

test('숫자: 금액·수량 칸은 고정폭 숫자이고, 숫자 폭을 바꾸는 글꼴 기능(ss01·ss02·ss06·zero)을 켜지 않는다', async ({ page }) => {
  await loginAs(page, '한지수');
  await page.goto('/balances');
  await page.locator('.bal-wide td.num').first().waitFor();
  await page.waitForLoadState('networkidle');
  const r = await page.evaluate(async () => {
    await document.fonts.ready;
    const sel = ['.bal-wide td.num', '.total-value', '.total-exact', '.bal-wide td.num .amt-n'];
    const styles = sel.flatMap((s) => [...document.querySelectorAll(s)].map((e) => ({ s, num: getComputedStyle(e).fontVariantNumeric, feat: getComputedStyle(e).fontFeatureSettings })));
    // 실제 글꼴에서 '1111'과 '0000'의 폭이 같은지(고정폭 숫자가 정말 적용되었는지) 같은 칸 안에서 잰다
    const cell = document.querySelector('.bal-wide td.num')!;
    const probe = (t: string) => { const sp = document.createElement('span'); sp.textContent = t; cell.appendChild(sp); const w = sp.getBoundingClientRect().width; sp.remove(); return w; };
    // 단위 칸(.amt-u)이 같은 폭이라 단위가 달라도 숫자 오른쪽 끝이 같은 열에서 한 줄로 선다
    const rows = [...document.querySelectorAll('.bal-wide tbody tr')].map((tr) => [...tr.querySelectorAll('td.num')]
      .map((td) => td.querySelector('.amt-n')).filter((n): n is Element => !!n).map((n) => n.getBoundingClientRect().right));
    const cols = [0, 1, 2].map((k) => rows.map((row) => row[k]).filter((x): x is number => x !== undefined));
    // 가장 긴 단위(USDC)의 오른쪽 끝이 오른쪽 정렬한 머리글 글자 끝과 만난다(단위 칸 폭을 가장 긴 단위에 맞춤, A4 검토)
    const heads = [...document.querySelectorAll('.bal-wide thead th')].slice(2, 5).map((th) => th.getBoundingClientRect().right - parseFloat(getComputedStyle(th).paddingRight));
    const textRight = (e: Element) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().right; };
    const unitEdges = [0, 1, 2].map((k) => Math.max(...[...document.querySelectorAll('.bal-wide tbody tr')].map((tr) => tr.querySelectorAll('td.qty')[k]?.querySelector('.amt-u')).filter((u): u is Element => !!u).map(textRight)));
    return { styles, ones: probe('1111'), zeros: probe('0000'), sixes: probe('6969'), fours: probe('4444'), cols, heads, unitEdges };
  });
  for (const s of r.styles) {
    expect(s.num, s.s).toContain('tabular-nums');
    expect(s.feat, s.s).not.toMatch(/ss0[126]|zero/);
  }
  expect(Math.abs(r.ones - r.zeros)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(r.sixes - r.zeros)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(r.fours - r.zeros)).toBeLessThanOrEqual(0.5);
  for (const col of r.cols) {
    expect(col.length).toBeGreaterThan(1);
    expect(Math.max(...col) - Math.min(...col)).toBeLessThanOrEqual(1);
  }
  r.heads.forEach((h, k) => expect(Math.abs(h - r.unitEdges[k]!), `${k}번째 수량 열: 머리글 끝 ${h.toFixed(1)}, 단위 끝 ${r.unitEdges[k]!.toFixed(1)}`).toBeLessThanOrEqual(1.5));
  expect(await tnumWithoutFallback(page), '잔고: 고정폭 숫자 자리의 대체 글꼴').toEqual([]);
  // 홈 보유 자산 표도 같은 방식(AmountText와 단위 칸)으로 수량을 쓴다: 열마다 숫자 오른쪽 끝이 1px 이내
  await page.goto('/');
  await page.locator('.card-holdings td.qty .amt-n').filter({ visible: true }).first().waitFor();
  await page.waitForLoadState('networkidle');
  const home = await page.evaluate(async () => {
    await document.fonts.ready;
    const rows = [...document.querySelectorAll('.card-holdings tbody tr')].filter((tr) => tr.getClientRects().length > 0).map((tr) => [...tr.querySelectorAll('td.qty .amt-n')].map((n) => n.getBoundingClientRect().right));
    return [0, 1].map((k) => rows.map((row) => row[k]).filter((x): x is number => x !== undefined));
  });
  for (const col of home) {
    expect(col.length).toBeGreaterThan(1);
    expect(Math.max(...col) - Math.min(...col), '홈 보유 자산 수량 열').toBeLessThanOrEqual(1);
  }
  expect(await tnumWithoutFallback(page), '홈: 고정폭 숫자 자리의 대체 글꼴').toEqual([]);
  // 요청 목록·홈의 수량과 요청 번호
  await page.goto('/requests');
  await page.locator('.req-amt').first().waitFor();
  for (const s of ['.req-amt', '.ref']) expect(await page.locator(s).first().evaluate((e) => getComputedStyle(e).fontVariantNumeric), s).toContain('tabular-nums');
  expect(await page.locator('.ref').first().evaluate((e) => getComputedStyle(e).fontFeatureSettings)).toBe('"case"');
  expect(await tnumWithoutFallback(page), '요청 목록: 고정폭 숫자 자리의 대체 글꼴').toEqual([]);
});

/** 모든 요소와 ::before·::after의 전환·애니메이션 */
function motionScan(page: Page) {
  return page.evaluate(() => {
    const secs = (v: string) => v.split(',').map((x) => { const t = x.trim(); return t.endsWith('ms') ? parseFloat(t) / 1000 : parseFloat(t); });
    let maxTransition = 0; let maxAnimation = 0;
    const longOnes: string[] = []; const allProps: string[] = []; const textFades: string[] = [];
    for (const el of document.querySelectorAll('*')) {
      const ownText = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
      for (const pseudo of [null, '::before', '::after'] as const) {
        const cs = getComputedStyle(el, pseudo);
        const name = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}${pseudo ?? ''}`;
        const props = cs.transitionProperty.split(',').map((x) => x.trim());
        const durs = secs(cs.transitionDuration);
        props.forEach((p, i) => {
          const d = durs[i % durs.length] ?? 0;
          if (d > maxTransition) maxTransition = d;
          if (d > 0.24) longOnes.push(`${name} ${p} ${d}s`);
          if (p === 'all' && d > 0) allProps.push(name);
          if (!pseudo && ownText && d > 0 && ['opacity', 'font-weight', 'font-size', 'letter-spacing', 'line-height', 'outline', 'outline-color', 'box-shadow'].includes(p)) textFades.push(`${name} ${p}`);
        });
        if (el.classList.contains('spinner') && !pseudo) continue; // 불러오는 중 고리만 예외(글자와 함께 보이는 필수 표시)
        if (cs.animationName !== 'none') {
          for (const d of secs(cs.animationDuration)) { if (d > maxAnimation) maxAnimation = d; if (d > 0.24) longOnes.push(`${name} animation ${d}s`); }
        }
      }
    }
    return { maxTransition, maxAnimation, longOnes, allProps, textFades };
  });
}

test.describe('모션(움직임 허용): 240ms 이하, all 금지, 글자 요소의 투명도·굵기 전환 없음', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('홈·요청 상세·390px 메뉴 서랍', async ({ page }) => {
    await loginAs(page, '오민재');
    for (const path of ['/', '/requests/wr-4']) {
      await page.goto(path);
      await page.locator('#page-title').waitFor();
      await page.waitForLoadState('networkidle');
      const m = await motionScan(page);
      expect(m.longOnes, path).toEqual([]);
      expect(m.allProps, path).toEqual([]);
      expect(m.textFades, path).toEqual([]);
      expect(m.maxTransition, path).toBeGreaterThan(0); // 피드백 전환이 실제로 있다(토큰이 0으로 꺼지지 않았다)
    }
    await page.setViewportSize(PHONE);
    const toggle = page.locator('.topbar .nav-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // 서랍은 열 때만 240ms로 움직인다(닫힘은 즉시)
    expect(await page.locator('#sidenav').evaluate((e) => getComputedStyle(e).transitionDuration)).toBe('0.24s');
    const m = await motionScan(page);
    expect(m.longOnes).toEqual([]);
    expect(m.allProps).toEqual([]);
    expect(m.textFades).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await page.locator('#sidenav').evaluate((e) => getComputedStyle(e).transitionDuration)).toBe('0s');
  });
});

test.describe('줄인 움직임(prefers-reduced-motion: reduce)', () => {
  test.use({ reducedMotion: 'reduce', viewport: PHONE });
  test('서랍·막·확인 대화상자·버튼·진행선이 움직이지 않고 바로 끝 모습이다', async ({ page }) => {
    await loginAs(page, '한지수');
    await page.goto('/requests');
    await page.locator('.req-item .rail').first().waitFor();
    const rail = await page.evaluate(() => {
      const step = document.querySelector('.rail-step:nth-child(2)')!;
      const all = (e: Element, p: string | null) => getComputedStyle(e, p).transitionDuration.split(',').map((x) => x.trim());
      return [...all(document.querySelector('.btn')!, null), ...all(step, '::before'), ...all(step, '::after'), ...all(step.querySelector('.rail-dot')!, null)];
    });
    expect(new Set(rail)).toEqual(new Set(['0s']));

    // 메뉴 서랍: 전환 없음, 막은 처음부터 불투명도 1
    const toggle = page.locator('.topbar .nav-toggle');
    await toggle.click();
    const drawer = await page.evaluate(() => ({
      nav: getComputedStyle(document.getElementById('sidenav')!).transitionDuration.split(',').map((x) => x.trim()),
      scrim: getComputedStyle(document.querySelector('.nav-scrim')!).opacity,
      scrimDur: getComputedStyle(document.querySelector('.nav-scrim')!).transitionDuration,
      transform: getComputedStyle(document.getElementById('sidenav')!).transform,
    }));
    expect(new Set(drawer.nav)).toEqual(new Set(['0s']));
    expect(drawer.scrim).toBe('1');
    expect(drawer.scrimDur).toBe('0s');
    expect(drawer.transform).toBe('none'); // 열자마자 제자리
    await page.keyboard.press('Escape');

    // 작성 중 이탈 확인: 대화상자는 처음부터 제자리(transform none), 바탕 전환 0s
    await page.goto('/requests/new');
    await page.locator('#page-title').waitFor();
    await page.getByRole('combobox', { name: /^자산/ }).selectOption('USDC');
    await toggle.click();
    await page.locator('#sidenav').getByRole('link', { name: '홈' }).click();
    const dialog = page.getByRole('alertdialog', { name: '작성 중인 내용이 있습니다' });
    await expect(dialog).toBeVisible();
    const dlg = await dialog.evaluate((d) => ({ transform: getComputedStyle(d).transform, dur: getComputedStyle(d).transitionDuration, backdrop: getComputedStyle(d, '::backdrop').transitionDuration }));
    expect(dlg).toEqual({ transform: 'none', dur: '0s', backdrop: '0s' });
    await dialog.getByRole('button', { name: '계속 작성' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/requests\/new$/);
  });
});

test('진행선: 지난·지금 단계로 오는 선은 Action 색으로 채워져 있고(scaleX 1), 다음 단계는 비어 있다(scaleX 0)', async ({ page }) => {
  await loginAs(page, '오민재');
  await page.goto('/requests/wr-4');
  await page.locator('ol.rail .rail-step').first().waitFor();
  const steps = await page.locator('ol.rail').first().locator('.rail-step').evaluateAll((els) => els.map((e, i) => ({
    i, cls: e.className, before: getComputedStyle(e, '::before').backgroundColor, after: getComputedStyle(e, '::after').backgroundColor,
    transform: getComputedStyle(e, '::after').transform, shown: getComputedStyle(e, '::after').display !== 'none',
  })));
  expect(steps.map((s) => s.cls.replace('rail-step ', ''))).toEqual(['rail-done', 'rail-done', 'rail-current', 'rail-todo']);
  expect(steps[0]!.shown).toBe(false); // 첫 단계 앞에는 선이 없다
  for (const s of steps.slice(1)) {
    expect(s.before, `${s.i} 회색 길`).toBe('rgb(219, 226, 223)');
    expect(s.after, `${s.i} 채움 색`).toBe('rgb(0, 112, 79)');
    expect(s.transform, `${s.i} ${s.cls}`).toBe(/rail-(done|current|bad)/.test(s.cls) ? 'matrix(1, 0, 0, 1, 0, 0)' : 'matrix(0, 0, 0, 1, 0, 0)');
  }
});

test('CSS 규칙: @starting-style은 모두 움직임 허용(no-preference) 안에 있고, 경고·위험·role="alert"에는 없다', async ({ page }) => {
  await loginAs(page, '한지수');
  const found = await page.evaluate(() => {
    const out: { selectors: string[]; media: string[] }[] = [];
    const walk = (rules: CSSRuleList, media: string[]) => {
      for (const r of rules) {
        if (r.constructor.name === 'CSSStartingStyleRule') {
          out.push({ selectors: [...(r as CSSGroupingRule).cssRules].map((x) => (x as CSSStyleRule).selectorText), media });
        } else if (r instanceof CSSMediaRule) walk(r.cssRules, [...media, r.conditionText]);
        else if ('cssRules' in r && (r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules, media);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules, []);
    return out;
  });
  expect(found.length).toBeGreaterThanOrEqual(4);
  for (const f of found) {
    expect(f.media.some((m) => /prefers-reduced-motion:\s*no-preference/.test(m)), f.selectors.join()).toBe(true);
    for (const s of f.selectors) expect(s).not.toMatch(/notice-warning|notice-danger|role=["']?alert/);
  }
});

// 글꼴이 바뀔 때의 자리 이동 예산(A4 검토): 홈만 보던 것을 요청 목록·잔고·요청 상세(주소 띠·재입력·승인 버튼이 있는 화면)까지 넓혔다.
// 고치기 전(A4 첫 판) 측정: 요청 목록 390px +32px, 잔고 1440px CLS 0.0206(글꼴 조각이 오는 중간에 설명이 두 줄이 되었다 돌아옴),
// 요청 상세 1440px −25px·390px +21px. 지금은 모두 0~1px, CLS 0.0002 이하다.
const SWAP: { user: string; path: string; ready: (page: Page) => Promise<void> }[] = [
  { user: '한지수', path: '/', ready: async (page) => { await page.locator('.progress-item').first().waitFor(); await page.locator('.task').first().waitFor(); } },
  { user: '한지수', path: '/requests', ready: async (page) => { await page.locator('.req-item').first().waitFor(); } },
  { user: '한지수', path: '/balances', ready: async (page) => { await page.locator('.total-value').waitFor(); } },
  { user: '오민재', path: '/requests/wr-4', ready: async (page) => { await page.locator('.rc-intent-value').waitFor(); } },
];

test.describe('글꼴이 늦게 와도 자리가 거의 그대로다(크기를 맞춘 대체 글꼴)', () => {
  for (const s of SWAP) {
    for (const vp of [{ width: 1440, height: 900 }, PHONE]) {
      test(`${s.path} ${vp.width}px: 글꼴이 바뀔 때 페이지 높이 차 10px 이하, 자리 이동(CLS) 0.02 이하`, async ({ page }) => {
        await page.setViewportSize(vp);
        await loginAs(page, s.user);
        await page.locator('#page-title').waitFor();
        await page.waitForLoadState('networkidle');
        // 글꼴 파일을 붙잡아 두고 화면을 새로 연다(라우팅 중에는 HTTP 캐시를 쓰지 않는다)
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        let held = 0;
        await page.route(/\.woff2(\?.*)?$/, async (route) => { held += 1; await gate; await route.continue(); });
        await page.goto(s.path);
        await page.locator('#page-title').waitFor();
        await s.ready(page);
        // 글꼴 요청이 붙잡혀 있어 networkidle을 쓸 수 없다. 늦게 오는 목록까지 자리 잡을 시간을 둔다
        await page.waitForTimeout(1500);
        expect(held).toBeGreaterThan(0);
        const fallback = await page.evaluate(() => [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Pretendard Fallback').map((f) => f.status));
        test.skip(!fallback.includes('loaded'), '이 환경에는 맑은 고딕이 없어 크기를 맞춘 대체 글꼴(Pretendard Fallback)을 쓰지 않는다');
        const before = await page.evaluate(() => {
          const w = window as unknown as { __a4Shift: number };
          w.__a4Shift = 0;
          new PerformanceObserver((list) => { for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) w.__a4Shift += e.value; }).observe({ type: 'layout-shift' });
          return document.documentElement.scrollHeight;
        });
        release();
        await page.waitForLoadState('networkidle');
        const after = await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const loaded = [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Pretendard Variable' && f.status === 'loaded').length;
          return { height: document.documentElement.scrollHeight, shift: (window as unknown as { __a4Shift: number }).__a4Shift, loaded };
        });
        await page.unroute(/\.woff2(\?.*)?$/);
        expect(after.loaded).toBeGreaterThan(0);
        expect(Math.abs(after.height - before), `높이 ${before} → ${after.height}`).toBeLessThanOrEqual(10);
        expect(after.shift, 'CLS').toBeLessThanOrEqual(0.02);
      });
    }
  }
});

// 400% 확대(1280px 화면의 320px)에서 가로 스크롤 없이 다시 배치된다(WCAG 1.4.10). A4 검토에서 지갑·인사이트가 12px 넘쳤다(8f2dcb5부터 있던 문제)
test.describe('400% 확대(320px)에서 가로 스크롤이 없다', () => {
  const REFLOW: [string, string][] = [
    ['한지수', '/'], ['한지수', '/requests'], ['한지수', '/balances'], ['한지수', '/addresses'], ['한지수', '/addresses/new'], ['한지수', '/activity'],
    ['한지수', '/wallets'], ['한지수', '/insights'], ['한지수', '/staking'], ['한지수', '/tokens'], ['한지수', '/org'], ['오민재', '/requests/wr-4'], ['문태호', '/audit'],
  ];
  test.use({ viewport: { width: 320, height: 640 } });
  test('주요 화면 13개', async ({ page }) => {
    const over: string[] = [];
    let user = '';
    for (const [who, path] of REFLOW) {
      if (who !== user) { await page.context().clearCookies(); await loginAs(page, who); user = who; }
      await page.goto(path);
      await page.locator('#page-title').waitFor();
      await page.waitForLoadState('networkidle');
      const d = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (d > 0) over.push(`${path} +${d}px`);
    }
    expect(over).toEqual([]);
  });
});

test.describe('접근성 자동 검사(A4 화면, WCAG 2.2 AA 규칙 포함)', () => {
  for (const s of SCREENS) {
    test(`${s.path} (${s.user}) 1440px·390px`, async ({ page }) => {
      await open(page, s);
      const wide = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(wide.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`), '1440px').toEqual([]);
      await page.setViewportSize(PHONE);
      await page.reload();
      await page.locator('#page-title').waitFor();
      await s.ready(page);
      await page.waitForLoadState('networkidle');
      const narrow = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(narrow.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`), '390px').toEqual([]);
    });
  }
});
