import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAs, logout } from './helpers.ts';
import { PAYMENT_EVIDENCE_TEXT as T } from '../shared/terms.ts';
import { fileSizeLabel } from '../shared/attachments.ts';

// A2b 지급 근거: 요청자가 작성·검토 중에 파일·메모를 붙이고 승인 요청 뒤에는 고정, 승인자는 결정 카드에서 목록·미리 보기·내려받기,
// 근거가 없으면 '근거 기록 없음'. 테스트 파일은 메모리에서 만든다(저장소에 바이너리 파일 없음, 내려받은 파일은 브라우저 문맥과 함께 지워진다).
// 바꾸는 데이터: 모의법인 B(배서준 → 임하은)의 새 요청 2건, 모의법인 A의 KAIA 요청 1건(ab-06). 모두 검사 끝에 취소한다.
// 시드 요청(wr-4 등)은 읽기만 한다. 다른 검사의 출금 전 점검(같은 자산 최근 요청 수)에 영향을 주지 않게 USDC 요청은 모의법인 B로만 만든다.

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** 1×1 투명 PNG(67바이트) */
const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082', 'hex');
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'), Buffer.alloc(120, 0x20)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
const sha12 = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const LONG_PDF_NAME = '2026년4분기_정산파트너B_지급근거_인보이스_INV-2026-1043_최종본_서명완료_스캔본_원본대조용.pdf';

async function axe(page: Page) {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

async function csrf(page: Page) {
  return (await (await page.request.get('/api/me')).json()).csrfToken as string;
}

async function send(page: Page, method: 'POST' | 'PUT', url: string, body: unknown) {
  const headers = { 'X-CSRF-Token': await csrf(page), 'Idempotency-Key': `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}` };
  const res = method === 'POST' ? await page.request.post(url, { data: body, headers }) : await page.request.put(url, { data: body, headers });
  const json = await res.json();
  expect(res.ok(), `${url} ${JSON.stringify(json)}`).toBeTruthy();
  return json;
}

async function uploadApi(page: Page, id: string, bytes: Buffer, name: string) {
  const res = await page.request.post(`/api/requests/${id}/attachments`, {
    data: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': await csrf(page), 'X-Attachment-Name': encodeURIComponent(name) },
  });
  const json = await res.json();
  expect(res.status(), JSON.stringify(json)).toBe(201);
  return json;
}

/** 지금 로그인한 사람이 작성자인 요청을 취소한다(이미 끝난 요청이면 그대로 둔다). */
async function cancel(page: Page, id: string) {
  const cur = await (await page.request.get(`/api/requests/${id}`)).json();
  if (['DRAFT', 'REVIEW', 'PENDING_APPROVAL'].includes(cur.status)) await send(page, 'POST', `/api/requests/${id}/cancel`, { version: cur.version });
}

/** 지금 로그인한 요청자가 지급 근거(파일·메모)를 붙여 승인 요청까지 보낸다. 사유가 필요한 점검 항목에는 사유를 넣는다. */
async function submitWithEvidence(page: Page, body: Record<string, unknown>, files: [Buffer, string][], note: string) {
  const draft = await send(page, 'POST', '/api/requests', body);
  for (const [bytes, name] of files) await uploadApi(page, draft.id, bytes, name);
  const noted = await send(page, 'PUT', `/api/requests/${draft.id}/evidence-note`, { note });
  const rv = await send(page, 'POST', `/api/requests/${draft.id}/review`, { version: noted.version });
  const checkReasons = Object.fromEntries((rv.checks?.items ?? []).filter((x: any) => x.requiresReason).map((x: any) => [x.id, 'E2E 거래처 재무팀과 등록된 번호로 통화해 확인했습니다']));
  return send(page, 'POST', `/api/requests/${draft.id}/submit`, { version: rv.version, confirmTail: String(rv.address.address).slice(-6), ackIrreversible: true, checkReasons });
}

test('지급 근거: 요청자가 작성·검토 중에 붙이고 승인 요청 뒤에는 고정', async ({ page }) => {
  await loginAs(page, '배서준');
  const draft = await send(page, 'POST', '/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-b1', amount: '1', purpose: 'E2E A2b 지급 근거 첨부' });
  try {
    await page.goto(`/requests/${draft.id}`);
    const editor = page.locator('section.pe-editor');
    await expect(editor.getByRole('heading', { name: '지급 근거', level: 2 })).toBeVisible();
    await expect(editor).toContainText(T.mockWarning);
    await expect(editor.locator('.pe-empty')).toHaveText(T.editorEmpty);
    await expect(editor.locator('.pe-limits')).toHaveText(T.limits);
    const posts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/attachments$/.test(new URL(r.url()).pathname)) posts.push(r.url()); });

    // 두 파일을 한 번에 고르면 차례로 올린다
    await page.setInputFiles('#pe-file', [
      { name: '인보이스 INV-1043.pdf', mimeType: 'application/pdf', buffer: PDF },
      { name: '영수증.png', mimeType: 'image/png', buffer: PNG },
    ]);
    const items = editor.getByRole('list', { name: '지급 근거 파일' }).getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(editor.locator('.pe-progress')).toHaveText('파일 2개를 붙였습니다');
    await expect(items.nth(0)).toContainText('인보이스 INV-1043.pdf');
    await expect(items.nth(0)).toContainText(`PDF · ${fileSizeLabel(PDF.length)} · SHA-256 앞 12자리 ${sha12(PDF)}`);
    await expect(items.nth(0)).toContainText('첨부 배서준 · ');
    await expect(items.nth(1)).toContainText(`PNG · 67B · SHA-256 앞 12자리 ${sha12(PNG)}`);
    await expect(items.nth(1).getByRole('img', { name: '영수증.png 미리 보기' })).toBeVisible();
    expect(posts).toHaveLength(2);

    // SVG는 보내기 전에 화면에서 거부한다(서버로 요청이 가지 않는다)
    await page.setInputFiles('#pe-file', [{ name: 'scan.svg', mimeType: 'image/svg+xml', buffer: SVG }]);
    const alert = editor.getByRole('alert').filter({ hasText: '올리지 못한 파일이 있습니다' });
    await expect(alert).toContainText('scan.svg');
    await expect(alert).toContainText('이 파일 형식은 올릴 수 없습니다. PDF·PNG·JPEG 파일만 받습니다.');
    expect(posts).toHaveLength(2);
    await expect(items).toHaveCount(2);

    // 메모를 적고 저장하지 않은 채 떠나려 하면 작성 중 보호가 묻는다(한 화면에 하나뿐인 보호)
    const note = editor.locator('#pe-note');
    await note.fill('INV-2026-1043');
    await expect(editor.locator('.pe-counter')).toHaveText('13/300');
    await page.getByRole('link', { name: '홈' }).click();
    const leave = page.getByRole('alertdialog', { name: '작성 중인 내용이 있습니다' });
    await expect(leave).toBeVisible();
    await leave.getByRole('button', { name: '계속 작성' }).click();
    await expect(page).toHaveURL(new RegExp(`/requests/${draft.id}$`));
    await editor.getByRole('button', { name: '메모 저장' }).click();
    await expect(editor.getByRole('button', { name: '메모 저장' })).toBeDisabled();
    await expect(note).toHaveValue('INV-2026-1043');

    // 390px: 편집 카드 넘침 없음, 누르기 쉬운 크기, axe
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    for (const b of await editor.locator('.pe-actions .btn, .pe-add .btn').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await axe(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // PNG를 확인 대화상자로 지우고 다시 붙인다. 지운 뒤에는 「파일 추가」로 포커스가 간다.
    await editor.getByRole('button', { name: '삭제 영수증.png' }).click();
    const dlg = page.getByRole('alertdialog', { name: "'영수증.png'을(를) 지급 근거에서 삭제할까요?" });
    await expect(dlg).toContainText('이 요청에서 파일이 지워집니다. 삭제 기록(파일 이름·크기·SHA-256)은 감사 기록에 남습니다.');
    await expect(dlg.getByRole('button', { name: '돌아가기' })).toBeFocused();
    await dlg.getByRole('button', { name: '삭제', exact: true }).click();
    await expect(dlg).toHaveCount(0);
    await expect(items).toHaveCount(1);
    await expect(editor.getByRole('button', { name: '파일 추가' })).toBeFocused();
    await page.setInputFiles('#pe-file', [{ name: '영수증.png', mimeType: 'image/png', buffer: PNG }]);
    await expect(items).toHaveCount(2);

    // 검토 중에도 고칠 수 있다
    await page.getByRole('button', { name: '검토로 이동' }).click();
    await expect(page.getByRole('heading', { name: '최종 검토 후 승인 요청' })).toBeVisible();
    await expect(editor.getByRole('button', { name: '파일 추가' })).toBeEnabled();
    const submitCard = page.locator('section.card-action');
    await expect(submitCard.locator('.pe-submit-line')).toHaveText(T.submitLine(2, true));

    // 승인 요청
    const addr = await (await page.request.get('/api/addresses/ab-b1')).json();
    await page.locator('#tail').fill(String(addr.address).slice(-6));
    await page.getByLabel(/되돌릴 수 없다는 점/).check();
    for (const t of await submitCard.locator('textarea[id^="check-reason-"]').all()) await t.fill('E2E 거래처 재무팀과 등록된 번호로 통화해 확인했습니다');
    await page.getByRole('button', { name: '승인 요청 보내기' }).click();
    await expect(page.getByText('승인 대기').first()).toBeVisible();

    // 승인 요청 뒤: 편집 수단이 어디에도 없고 고정 안내가 보인다
    await expect(page.locator('#pe-file')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '파일 추가' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^삭제/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '메모 저장' })).toHaveCount(0);
    await expect(page.locator('#pe-note')).toHaveCount(0);
    const ro = page.locator('.pe-card');
    await expect(ro.locator('.pe-state')).toHaveText(T.locked);
    await expect(ro.locator('.pe-source')).toHaveText(T.sourceCard);
    await expect(ro.locator('.pe-note-text')).toHaveText('INV-2026-1043');
    await expect(ro.getByRole('list', { name: '지급 근거 파일' }).getByRole('listitem')).toHaveCount(2);
  } finally {
    await cancel(page, draft.id);
  }
});

test('승인자: 결정 카드의 지급 근거 목록·미리 보기·내려받기 (1440·390px, axe)', async ({ page }) => {
  await loginAs(page, '배서준');
  const sent = await submitWithEvidence(page, { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-b1', amount: '2', purpose: 'E2E A2b 승인자 확인' },
    [[PDF, LONG_PDF_NAME], [PNG, '영수증.png']], '인보이스 INV-2026-1043');
  try {
    expect(sent.status).toBe('PENDING_APPROVAL');
    await logout(page);
    await loginAs(page, '임하은');
    await page.goto(`/requests/${sent.id}`);
    const card = page.locator('section.card-action');
    await expect(card.getByRole('heading', { name: '승인 또는 반려' })).toBeVisible();
    const block = card.getByRole('group', { name: '지급 근거' });
    await expect(block).toBeVisible();
    // 점검 결과 다음, 승인 효과 문장 앞
    const order = await card.evaluate((el) => {
      const all = [...el.querySelectorAll('*')];
      const pos = (s: string) => all.indexOf(el.querySelector(s)!);
      return { checks: pos('.rc-list'), evidence: pos('.pe-block'), effect: pos('#approve-effect'), button: pos('button.btn-primary') };
    });
    expect(order.checks).toBeGreaterThanOrEqual(0);
    expect(order.checks).toBeLessThan(order.evidence);
    expect(order.evidence).toBeLessThan(order.effect);
    expect(order.effect).toBeLessThan(order.button);
    await expect(block.locator('.pe-source')).toHaveText(T.source);
    await expect(block.locator('.pe-note-text')).toHaveText('인보이스 INV-2026-1043');
    await expect(block.locator('.pe-note-label')).toHaveText(`${T.noteLabel} (설계 가정)`);
    const items = block.getByRole('list', { name: '지급 근거 파일' }).getByRole('listitem');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText(LONG_PDF_NAME);
    await expect(items.nth(0)).toContainText(`PDF · ${fileSizeLabel(PDF.length)} · SHA-256 앞 12자리 ${sha12(PDF)}`);
    await expect(items.nth(0).getByRole('img')).toHaveCount(0); // PDF는 미리 보기 없이 내려받기만
    const img = items.nth(1).getByRole('img', { name: '영수증.png 미리 보기' });
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
    await expect(block.getByRole('button', { name: /^삭제/ })).toHaveCount(0);
    await expect(card.locator('#check-amount-hint')).toHaveText(T.amountHintWith);

    // 내려받기: 정리된 이름과 같은 바이트
    const [download] = await Promise.all([page.waitForEvent('download'), block.getByRole('button', { name: `내려받기 ${LONG_PDF_NAME}` }).click()]);
    expect(download.suggestedFilename()).toBe(LONG_PDF_NAME);
    expect(readFileSync((await download.path())!).equals(PDF)).toBe(true);
    await axe(page);

    // 390px: 넘침 없음, 근거 버튼 44px 이상, 긴 파일 이름은 카드 안에서 줄바꿈
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    for (const b of await block.locator('.pe-actions .btn').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const fit = await card.evaluate((el) => {
      const c = el.getBoundingClientRect();
      const n = el.querySelector('.pe-name')!;
      const r = n.getBoundingClientRect();
      return { inside: r.left >= c.left - 1 && r.right <= c.right + 1, lines: Math.round(r.height / parseFloat(getComputedStyle(n).lineHeight)) };
    });
    expect(fit.inside).toBe(true);
    expect(fit.lines).toBeGreaterThan(1);
    await axe(page);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
    await logout(page);
    await loginAs(page, '배서준');
    await cancel(page, sent.id);
  }
});

test("근거 기록 없음: 지급 근거가 없는 승인 대기 요청(wr-4)의 결정 카드와 수량 확인 안내 (390px, axe)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, '오민재');
  await page.goto('/requests/wr-4');
  const card = page.locator('section.card-action');
  const block = card.getByRole('group', { name: '지급 근거' });
  await expect(block.locator('.pe-none-title')).toHaveText(T.none);
  await expect(block.locator('.pe-none')).toContainText(T.noneBody);
  await expect(block.locator('.pe-source')).toHaveCount(0);
  await expect(block.getByRole('list', { name: '지급 근거 파일' })).toHaveCount(0);
  await expect(card.locator('#check-amount-hint')).toHaveText(T.amountHintNone);
  // 성공 색(녹색)으로 보이지 않는다
  const color = await block.locator('.pe-none').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(color).not.toBe('rgb(228, 244, 236)');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await axe(page);
});

test('요청자(승인 요청 뒤)와 감사 담당자는 읽기 전용 목록만 본다 (390px, axe)', async ({ page }) => {
  await loginAs(page, '한지수');
  const sent = await submitWithEvidence(page, { assetCode: 'KAIA', networkCode: 'KAIA', addressId: 'ab-06', amount: '5', purpose: 'E2E A2b 읽기 전용 확인' }, [[PNG, '정산서 캡처.png']], '정산서 2026-10');
  try {
    await page.goto(`/requests/${sent.id}`);
    const ro = page.locator('.pe-card');
    await expect(ro.getByRole('heading', { name: '지급 근거', level: 2 })).toBeVisible();
    await expect(ro.getByRole('list', { name: '지급 근거 파일' }).getByRole('listitem')).toHaveCount(1);
    await expect(ro.locator('.pe-state')).toHaveText(T.locked);
    await expect(page.getByRole('button', { name: /^삭제/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '파일 추가' })).toHaveCount(0);
    await logout(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, '문태호');
    await page.goto(`/requests/${sent.id}`);
    await expect(page.locator('section.card-action')).toHaveCount(0);
    const audit = page.locator('.pe-card');
    await expect(audit.getByRole('list', { name: '지급 근거 파일' }).getByRole('listitem')).toContainText('정산서 캡처.png');
    await expect(audit.locator('.pe-note-text')).toHaveText('정산서 2026-10');
    await expect(audit.getByRole('button', { name: '내려받기 정산서 캡처.png' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^삭제/ })).toHaveCount(0);
    await expect(page.locator('#pe-file')).toHaveCount(0);
    // 처리 기록에 행동 이름으로 남는다(메타데이터만)
    await expect(page.locator('.timeline')).toContainText('지급 근거 파일 첨부: 정산서 캡처.png (PNG, 67B)');
    await expect(page.locator('.timeline')).toContainText('지급 근거 메모 저장');
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await axe(page);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
    await logout(page);
    await loginAs(page, '한지수');
    await cancel(page, sent.id);
  }
});
