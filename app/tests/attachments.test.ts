// A2b: 출금 요청 지급 근거(파일·메모). 형식은 내용 앞부분으로만 판정하고, 승인 요청 뒤에는 고정되며, 같은 조직만 볼 수 있다.
// 테스트 파일은 모두 메모리에서 만든다(저장소에 바이너리 파일을 두지 않는다).
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, key, login, makeApp, upload, type Session, type TestCtx } from './helpers.ts';
import { verifyChain } from '../server/audit.ts';
import { intentFieldsOf, intentHashOf, INTENT_VERSION } from '../server/domain/checks.ts';
import { ACTION_LABEL, actionLabel } from '../shared/terms.ts';
import { ATTACHMENT_MAX_FILE_BYTES, fileSizeLabel } from '../shared/attachments.ts';

let ctx: TestCtx;
beforeEach(async () => { ctx = await makeApp(); });
afterEach(async () => { await ctx.app.close(); ctx.db.close(); });

// ---------- 메모리 안 테스트 파일 ----------
/** 1×1 투명 PNG(67바이트) */
const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082', 'hex');
/** '%PDF-1.4'로 시작하는 약 200바이트 */
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'), Buffer.alloc(120, 0x20)]);
/** JPEG 시작(FF D8 FF E0) + 채움 */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 0x11), Buffer.from([0xff, 0xd9])]);
/** 마지막 바이트 하나만 바꾼 사본(SHA-256이 달라진다) */
const variant = (b: Buffer, n = 1) => { const c = Buffer.from(b); c[c.length - 1] = (c[c.length - 1]! + n) % 256; return c; };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pdfOf = (size: number) => { const b = Buffer.alloc(size, 0x20); b.write('%PDF-1.4\n', 0, 'latin1'); return b; };

const tail = (addr: string) => addr.slice(-6);
const as = async (userId: string) => { const s = await login(ctx.app, userId); return { s, a: api(ctx.app, s) }; };
const auditRows = (requestId: string, action: string) =>
  (ctx.db.prepare('SELECT summary, detail FROM audit_log WHERE target_id = ? AND action = ? ORDER BY seq').all(requestId, action) as { summary: string; detail: string }[])
    .map((r) => ({ summary: r.summary, detail: JSON.parse(r.detail) }));
const rowCount = (requestId: string) => (ctx.db.prepare('SELECT COUNT(*) c FROM request_attachments WHERE request_id = ?').get(requestId) as { c: number }).c;
const version = (requestId: string) => (ctx.db.prepare('SELECT version FROM withdrawal_requests WHERE id = ?').get(requestId) as { version: number }).version;

async function draft(s: Session, amount = '1') {
  const r = await api(ctx.app, s).post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount, purpose: 'A2b 지급 근거 테스트' }, { 'idempotency-key': key() });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

describe('지급 근거 파일 올리기', () => {
  it('stores PDF, PNG and JPEG with the type from magic bytes, the SHA-256, the adder, one version bump and one metadata-only audit row each', async () => {
    const { s: han, a } = await as('u-a-han');
    const v0 = version('wr-6');
    const files: [Buffer, string, string, string][] = [[PDF, '인보이스 INV-1043.pdf', 'application/pdf', 'PDF'], [PNG, '영수증.png', 'image/png', 'PNG'], [JPEG, 'scan.jpg', 'image/jpeg', 'JPEG']];
    let last: any = null;
    for (const [i, [bytes, name, type]] of files.entries()) {
      const res = await upload(ctx.app, han, 'wr-6', bytes, name);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.version).toBe(v0 + i + 1);
      last = res.body;
      const added = res.body.paymentEvidence.attachments.at(-1);
      expect(added).toMatchObject({ fileName: name, contentType: type, sizeBytes: bytes.length, sha256: sha(bytes), addedBy: { name: '한지수' } });
    }
    const pe = last.paymentEvidence;
    expect(pe.attachments.map((x: any) => x.typeLabel)).toEqual(['PDF', 'PNG', 'JPEG']);
    expect(pe.attachments.map((x: any) => x.previewable)).toEqual([false, true, true]);
    expect(pe).toMatchObject({ hasAny: true, locked: false, canEdit: true, uploadsEnabled: true, isDesignAssumption: true, limits: { maxFiles: 5, maxFileBytes: ATTACHMENT_MAX_FILE_BYTES, noteMaxLength: 300, types: ['PDF', 'PNG', 'JPEG'] } });
    for (const x of pe.attachments) expect(x.contentUrl).toBe(`/api/requests/wr-6/attachments/${x.id}/content`);
    // 응답에는 파일 내용이 없다(메타데이터만)
    expect(JSON.stringify(last)).not.toContain(PNG.toString('base64'));

    const rows = auditRows('wr-6', 'request.attachment_added');
    expect(rows).toHaveLength(3);
    for (const [i, r] of rows.entries()) {
      expect(Object.keys(r.detail).sort()).toEqual(['attachmentId', 'contentType', 'fileName', 'sha256', 'sizeBytes']);
      expect(r.detail.sha256).toBe(sha(files[i]![0]));
      const raw = JSON.stringify(r);
      expect(raw).not.toContain(files[i]![0].toString('base64'));
      expect(raw).not.toContain(files[i]![0].toString('hex'));
    }
    expect(rows[0]!.summary).toBe(`WR-000006 지급 근거 파일 첨부: 인보이스 INV-1043.pdf (PDF, ${fileSizeLabel(PDF.length)})`);
    expect(rows[1]!.summary).toContain('영수증.png (PNG, 67B)');
    expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);
    // 처리 기록에 행동 이름과 함께 보인다
    const detail = (await a.get('/api/requests/wr-6')).body;
    const tl = detail.timeline.filter((t: any) => t.action === 'request.attachment_added');
    expect(tl).toHaveLength(3);
    expect(actionLabel('request.attachment_added')).toBe('지급 근거 파일 첨부');
    // 목록 응답의 항목 모양은 그대로다(paymentEvidence 없음)
    const list = await a.get('/api/requests?pageSize=50');
    expect(list.body.items.find((x: any) => x.id === 'wr-6')).not.toHaveProperty('paymentEvidence');
  });

  it('rejects spoofed and disallowed types by content (422), wrong upload formats (415) and empty bodies, storing nothing', async () => {
    const { s: han } = await as('u-a-han');
    const spoofs: [Buffer, string][] = [
      [Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>'), 'invoice.pdf'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'a.png'],
      [Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), 'b.svg'],
      [Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), 'c.gif'],
      [Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'), Buffer.alloc(20)]), 'd.webp'],
      [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), PDF]), 'bom.pdf'],
      [Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(20)]), 'noihdr.png'],
      [Buffer.from([0xff, 0xd8]), 'short.jpg'],
    ];
    for (const [bytes, name] of spoofs) {
      const res = await upload(ctx.app, han, 'wr-6', bytes, name);
      expect(res.status, name).toBe(422);
      expect(res.body.error.code, name).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');
      expect(res.body.error.allowed).toEqual(['PDF', 'PNG', 'JPEG']);
    }
    const empty = await upload(ctx.app, han, 'wr-6', Buffer.alloc(0), 'empty.pdf');
    expect(empty.status).toBe(422);
    expect(empty.body.error.code).toBe('ATTACHMENT_EMPTY');
    for (const ct of ['image/svg+xml', 'text/html', 'application/pdf', 'multipart/form-data; boundary=x', 'application/json']) {
      const res = await upload(ctx.app, han, 'wr-6', PDF, 'x.pdf', { 'content-type': ct });
      expect(res.status, ct).toBe(415);
      expect(res.body.error.code, ct).toBe('ATTACHMENT_UPLOAD_FORMAT');
    }
    expect(rowCount('wr-6')).toBe(0);
    expect(auditRows('wr-6', 'request.attachment_added')).toHaveLength(0);

    // 이름만 HTML이고 내용이 PNG면 PNG로 저장하고, 내려받을 이름에 PNG 확장자를 붙인다.
    const ok = await upload(ctx.app, han, 'wr-6', PNG, 'evil.html');
    expect(ok.status).toBe(201);
    const x = ok.body.paymentEvidence.attachments[0];
    expect(x).toMatchObject({ fileName: 'evil.html.png', contentType: 'image/png' });
    const dl = await ctx.app.inject({ method: 'GET', url: x.contentUrl, headers: { cookie: han.cookie } });
    expect(dl.headers['content-type']).toBe('image/png');
    expect(dl.headers['content-disposition']).toContain('filename="evil.html.png"');
  });

  it('accepts exactly 2 MiB and refuses 2 MiB + 1 byte with 413 before storing anything', async () => {
    const { s: han } = await as('u-a-han');
    const big = await upload(ctx.app, han, 'wr-6', pdfOf(ATTACHMENT_MAX_FILE_BYTES + 1), 'big.pdf');
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(big.body.error.message).toBe('파일이 2MB를 넘어 올리지 않았습니다.');
    expect(rowCount('wr-6')).toBe(0);
    expect(auditRows('wr-6', 'request.attachment_added')).toHaveLength(0);
    // 길이를 미리 알리지 않고 흘려 보내도(Content-Length 없음) 경로 본문 한도가 2MiB에서 끊는다(Fastify 본문 한도 → 같은 413).
    const streamed = await ctx.app.inject({
      method: 'POST', url: '/api/requests/wr-6/attachments', payload: Readable.from([pdfOf(ATTACHMENT_MAX_FILE_BYTES + 1)]),
      headers: { cookie: han.cookie, 'x-csrf-token': han.csrf, 'content-type': 'application/octet-stream', 'x-attachment-name': 'stream.pdf' },
    });
    expect(streamed.statusCode).toBe(413);
    expect(streamed.json().error.code).toBe('ATTACHMENT_TOO_LARGE');
    expect(rowCount('wr-6')).toBe(0);
    const exact = await upload(ctx.app, han, 'wr-6', pdfOf(ATTACHMENT_MAX_FILE_BYTES), 'exact.pdf');
    expect(exact.status, JSON.stringify(exact.body).slice(0, 300)).toBe(201);
    expect(exact.body.paymentEvidence.attachments[0].sizeBytes).toBe(2097152);
  });

  it('keeps at most 5 files per request (6th is 422 ATTACHMENT_LIMIT) and allows a new one after a delete', async () => {
    const { s: han, a } = await as('u-a-han');
    let last: any;
    for (let i = 0; i < 5; i++) {
      last = await upload(ctx.app, han, 'wr-6', variant(PDF, i + 1), `doc-${i}.pdf`);
      expect(last.status).toBe(201);
    }
    const sixth = await upload(ctx.app, han, 'wr-6', variant(PDF, 9), 'doc-6.pdf');
    expect(sixth.status).toBe(422);
    expect(sixth.body.error).toMatchObject({ code: 'ATTACHMENT_LIMIT', maxFiles: 5 });
    const del = await a.del(`/api/requests/wr-6/attachments/${last.body.paymentEvidence.attachments[0].id}`);
    expect(del.status).toBe(200);
    expect(del.body.paymentEvidence.attachments).toHaveLength(4);
    // 지우기도 요청 버전을 올린다(거부된 6번째는 올리지 않았다). 그 전에 연 승인 요청 화면은 409로 다시 불러온다(A-38).
    expect(del.body.version).toBe(last.body.version + 1);
    expect((await upload(ctx.app, han, 'wr-6', variant(PDF, 9), 'doc-6.pdf')).status).toBe(201);
  });

  it('refuses the same content twice with 409 ATTACHMENT_DUPLICATE and the existing id', async () => {
    const { s: han } = await as('u-a-han');
    const first = await upload(ctx.app, han, 'wr-6', PNG, 'a.png');
    const again = await upload(ctx.app, han, 'wr-6', PNG, 'other-name.png');
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'ATTACHMENT_DUPLICATE', attachmentId: first.body.paymentEvidence.attachments[0].id });
    expect(rowCount('wr-6')).toBe(1);
  });
});

describe('승인 요청 뒤 고정', () => {
  it('refuses upload, delete and note on a submitted request with 409 EVIDENCE_LOCKED (status PENDING_APPROVAL)', async () => {
    const { s: han, a } = await as('u-a-han');
    const up = await upload(ctx.app, han, 'wr-3', PNG, 'late.png');
    expect(up.status).toBe(409);
    expect(up.body.error).toMatchObject({ code: 'EVIDENCE_LOCKED', status: 'PENDING_APPROVAL' });
    const note = await a.put('/api/requests/wr-3/evidence-note', { note: 'INV-1' });
    expect(note.status).toBe(409);
    expect(note.body.error).toMatchObject({ code: 'EVIDENCE_LOCKED', status: 'PENDING_APPROVAL' });
    const del = await a.del('/api/requests/wr-3/attachments/00000000-0000-4000-8000-000000000000');
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('EVIDENCE_LOCKED');
    const pe = (await a.get('/api/requests/wr-3')).body.paymentEvidence;
    expect(pe).toMatchObject({ attachments: [], note: null, hasAny: false, locked: true, canEdit: false });
  });

  it('allows changes in DRAFT and REVIEW, snapshots the evidence at submit, keeps the intent hash formula, and locks after submit and after a cancel', async () => {
    const { s: han, a } = await as('u-a-han');
    const d = await draft(han);
    const up1 = await upload(ctx.app, han, d.id, PDF, 'invoice.pdf');
    expect(up1.status).toBe(201);
    const rv = await a.post(`/api/requests/${d.id}/review`, { version: up1.body.version });
    expect(rv.status).toBe(200);
    const up2 = await upload(ctx.app, han, d.id, PNG, 'receipt.png');
    expect(up2.status).toBe(201); // 검토 중에도 붙일 수 있다
    const back = await a.post(`/api/requests/${d.id}/back-to-draft`, { version: up2.body.version });
    expect(back.status).toBe(200);
    const pngId = up2.body.paymentEvidence.attachments.find((x: any) => x.contentType === 'image/png').id;
    const rm = await a.del(`/api/requests/${d.id}/attachments/${pngId}`);
    expect(rm.status).toBe(200);
    const removed = auditRows(d.id, 'request.attachment_removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]!.detail).toEqual({ attachmentId: pngId, fileName: 'receipt.png', contentType: 'image/png', sizeBytes: PNG.length, sha256: sha(PNG) });
    const note = await a.put(`/api/requests/${d.id}/evidence-note`, { note: '인보이스 INV-2026-1043' });
    expect(note.status).toBe(200);
    const rv2 = await a.post(`/api/requests/${d.id}/review`, { version: note.body.version });
    // 승인 요청 전에 연 화면(낡은 버전)으로 보내면 409 VERSION_CONFLICT다(지급 근거를 바꾸면 버전이 오른다).
    const stale = await a.post(`/api/requests/${d.id}/submit`, { version: rv2.body.version - 1, confirmTail: tail(d.address.address), ackIrreversible: true });
    expect(stale.status).toBe(409);
    // 검토 중에 붙였다가 지운 경우도 같다: 지우기 전 버전으로 보낸 승인 요청은 409 VERSION_CONFLICT
    const tmp = await upload(ctx.app, han, d.id, JPEG, 'tmp.jpg');
    expect(tmp.status).toBe(201);
    const tmpId = tmp.body.paymentEvidence.attachments.find((x: any) => x.contentType === 'image/jpeg').id;
    const tmpDel = await a.del(`/api/requests/${d.id}/attachments/${tmpId}`);
    expect(tmpDel.status).toBe(200);
    expect(tmpDel.body.version).toBe(tmp.body.version + 1);
    const beforeDel = await a.post(`/api/requests/${d.id}/submit`, { version: tmp.body.version, confirmTail: tail(d.address.address), ackIrreversible: true, checkReasons: { first_use: '거래처와 등록된 번호로 통화해 주소를 대조했습니다' } });
    expect(beforeDel.status).toBe(409);
    expect(beforeDel.body.error.code).toBe('VERSION_CONFLICT');
    const sub = await a.post(`/api/requests/${d.id}/submit`, { version: tmpDel.body.version, confirmTail: tail(d.address.address), ackIrreversible: true, checkReasons: { first_use: '거래처와 등록된 번호로 통화해 주소를 대조했습니다' } });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.status).toBe('PENDING_APPROVAL');
    expect(sub.body.paymentEvidence).toMatchObject({ locked: true, canEdit: false, hasAny: true });

    // 승인 요청 감사 기록에 그때의 근거 목록(메타데이터만)
    const submitted = auditRows(d.id, 'request.submitted')[0]!.detail;
    const pdfMeta = sub.body.paymentEvidence.attachments[0];
    expect(submitted.paymentEvidence).toEqual({
      note: { length: [...'인보이스 INV-2026-1043'].length, sha256: createHash('sha256').update('인보이스 INV-2026-1043', 'utf8').digest('hex') },
      attachments: [{ id: pdfMeta.id, fileName: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, sha256: sha(PDF) }],
    });
    expect(JSON.stringify(submitted)).not.toContain('INV-2026-1043');

    // 지문은 기존 계산식 그대로(지급 근거는 넣지 않는다)
    const row = ctx.db.prepare(`SELECT r.*, ab.address address_value, ab.memo address_memo, n.family network_family FROM withdrawal_requests r JOIN address_book ab ON ab.id = r.address_id JOIN networks n ON n.code = r.network_code WHERE r.id = ?`).get(d.id) as any;
    const fields = intentFieldsOf(row);
    expect(Object.keys(fields).sort()).toEqual(['address', 'addressId', 'amountUnits', 'assetCode', 'memo', 'networkCode', 'orgId', 'requestId', 'requiredApprovals', 'v']);
    expect(fields.v).toBe(INTENT_VERSION);
    expect(sub.body.intentHash).toBe(intentHashOf(fields));

    // 승인 요청 뒤에는 바꿀 수 없다
    const late = await upload(ctx.app, han, d.id, JPEG, 'late.jpg');
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('EVIDENCE_LOCKED');
    expect((await a.del(`/api/requests/${d.id}/attachments/${pdfMeta.id}`)).body.error.code).toBe('EVIDENCE_LOCKED');

    // 승인자는 바뀌지 않은 승인·반려 본문(version, intentHash)으로 승인한다
    const { a: oh } = await as('u-a-oh');
    const cur = (await oh.get(`/api/requests/${d.id}`)).body;
    expect(cur.paymentEvidence.attachments).toHaveLength(1);
    expect(cur.paymentEvidence.canEdit).toBe(false);
    const ap = await oh.post(`/api/requests/${d.id}/approve`, { version: cur.version, intentHash: cur.intentHash });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.status).toBe('PROCESSING');
    expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);

    // 작성 중에 취소한 요청도 고정된다
    const d2 = await draft(han);
    const c = await a.post(`/api/requests/${d2.id}/cancel`, { version: d2.version });
    expect(c.status).toBe(200);
    const after = await upload(ctx.app, han, d2.id, PNG, 'x.png');
    expect(after.status).toBe(409);
    expect(after.body.error).toMatchObject({ code: 'EVIDENCE_LOCKED', status: 'CANCELLED' });
  });
});

describe('권한과 조직 격리', () => {
  it('lets only the creator change evidence, lets same-org readers list and download, and refuses the operator', async () => {
    const { s: han } = await as('u-a-han');
    const up = await upload(ctx.app, han, 'wr-6', PNG, 'a.png');
    const x = up.body.paymentEvidence.attachments[0];
    const { s: kangS, a: kang } = await as('u-a-kang');
    const k = await upload(ctx.app, kangS, 'wr-6', PDF, 'k.pdf');
    expect(k.status).toBe(403);
    expect(k.body.error.code).toBe('NOT_REQUEST_OWNER');
    expect((await kang.del(`/api/requests/wr-6/attachments/${x.id}`)).body.error.code).toBe('NOT_REQUEST_OWNER');
    expect((await kang.put('/api/requests/wr-6/evidence-note', { note: '남의 메모' })).body.error.code).toBe('NOT_REQUEST_OWNER');
    // 작성자 화면에서만 canEdit
    expect((await kang.get('/api/requests/wr-6')).body.paymentEvidence.canEdit).toBe(false);

    const { s: ohS, a: oh } = await as('u-a-oh');
    const o = await upload(ctx.app, ohS, 'wr-6', PDF, 'o.pdf');
    expect(o.status).toBe(403);
    expect(o.body.error.code).toBe('FORBIDDEN');
    for (const user of ['u-a-oh', 'u-a-moon', 'u-a-yoon']) {
      const s = await login(ctx.app, user);
      const list = await api(ctx.app, s).get('/api/requests/wr-6/attachments');
      expect(list.status, user).toBe(200);
      expect(list.body.attachments.map((y: any) => y.id)).toEqual([x.id]);
      expect(list.body.canEdit, user).toBe(false);
      const dl = await ctx.app.inject({ method: 'GET', url: x.contentUrl, headers: { cookie: s.cookie } });
      expect(dl.statusCode, user).toBe(200);
      expect(Buffer.compare(dl.rawPayload, PNG), user).toBe(0);
    }
    expect((await oh.del(`/api/requests/wr-6/attachments/${x.id}`)).body.error.code).toBe('FORBIDDEN');
    const op = await login(ctx.app, 'u-k-op');
    expect((await api(ctx.app, op).get('/api/requests/wr-6/attachments')).status).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: x.contentUrl, headers: { cookie: op.cookie } })).statusCode).toBe(403);
    expect((await upload(ctx.app, op, 'wr-6', PDF, 'op.pdf')).status).toBe(403);
    expect(rowCount('wr-6')).toBe(1);
  });

  it('answers 404 to another org for list, content, upload, delete and note, and to a file id under another request', async () => {
    const { s: han } = await as('u-a-han');
    const x = (await upload(ctx.app, han, 'wr-6', PNG, 'a.png')).body.paymentEvidence.attachments[0];
    const { s: baeS, a: bae } = await as('u-b-bae');
    expect((await bae.get('/api/requests/wr-6/attachments')).status).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: x.contentUrl, headers: { cookie: baeS.cookie } })).statusCode).toBe(404);
    expect((await upload(ctx.app, baeS, 'wr-6', PDF, 'b.pdf')).status).toBe(404);
    expect((await bae.del(`/api/requests/wr-6/attachments/${x.id}`)).status).toBe(404);
    expect((await bae.put('/api/requests/wr-6/evidence-note', { note: '다른 조직' })).status).toBe(404);
    // 같은 조직이라도 다른 요청 경로로는 그 파일을 찾지 않는다
    const wrong = await ctx.app.inject({ method: 'GET', url: `/api/requests/wr-5/attachments/${x.id}/content`, headers: { cookie: han.cookie } });
    expect(wrong.statusCode).toBe(404);
    expect((await api(ctx.app, han).del(`/api/requests/wr-5/attachments/${x.id}`)).status).toBe(404);
    expect(rowCount('wr-6')).toBe(1);
  });
});

describe('CSRF와 본문 한도', () => {
  it('requires X-CSRF-Token on upload, delete and note before reading the body (oversize without CSRF is 403, not 413)', async () => {
    const { s: han, a } = await as('u-a-han');
    for (const h of [{ 'x-csrf-token': null }, { 'x-csrf-token': 'wrong-token' }]) {
      const res = await upload(ctx.app, han, 'wr-6', PDF, 'x.pdf', h);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_REJECTED');
    }
    const big = await upload(ctx.app, han, 'wr-6', pdfOf(ATTACHMENT_MAX_FILE_BYTES + 1), 'big.pdf', { 'x-csrf-token': null });
    expect(big.status).toBe(403);
    expect(big.body.error.code).toBe('CSRF_REJECTED');
    const x = (await upload(ctx.app, han, 'wr-6', PNG, 'a.png')).body.paymentEvidence.attachments[0];
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/requests/wr-6/attachments/${x.id}`, headers: { cookie: han.cookie } });
    expect(del.statusCode).toBe(403);
    expect(del.json().error.code).toBe('CSRF_REJECTED');
    const note = await ctx.app.inject({ method: 'PUT', url: '/api/requests/wr-6/evidence-note', headers: { cookie: han.cookie, 'x-csrf-token': 'nope' }, payload: { note: 'x' } });
    expect(note.statusCode).toBe(403);
    expect(rowCount('wr-6')).toBe(1);
    expect((await a.get('/api/requests/wr-6')).body.paymentEvidence.note).toBeNull();
  });

  it('checks owner, state and org before reading an oversize body (403, 409 and 404, not 413)', async () => {
    const big = pdfOf(ATTACHMENT_MAX_FILE_BYTES + 1);
    const kang = await login(ctx.app, 'u-a-kang');
    const r1 = await upload(ctx.app, kang, 'wr-6', big, 'big.pdf');
    expect([r1.status, r1.body.error.code]).toEqual([403, 'NOT_REQUEST_OWNER']);
    const han = await login(ctx.app, 'u-a-han');
    const r2 = await upload(ctx.app, han, 'wr-3', big, 'big.pdf');
    expect([r2.status, r2.body.error.code]).toEqual([409, 'EVIDENCE_LOCKED']);
    const bae = await login(ctx.app, 'u-b-bae');
    const r3 = await upload(ctx.app, bae, 'wr-6', big, 'big.pdf');
    expect([r3.status, r3.body.error.code]).toEqual([404, 'NOT_FOUND']);
    expect(rowCount('wr-6')).toBe(0);
  });

  it('keeps the global 64KB JSON limit elsewhere and the byte parser only on the upload route', async () => {
    const { a } = await as('u-a-han');
    const huge = 'x'.repeat(70 * 1024);
    const draftBig = await a.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '1', purpose: huge }, { 'idempotency-key': key() });
    expect(draftBig.status).toBe(413);
    const noteBig = await a.put('/api/requests/wr-6/evidence-note', { note: huge });
    expect(noteBig.status).toBe(413);
    const cur = (await a.get('/api/requests/wr-5')).body;
    const octet = await a.post('/api/requests/wr-5/submit', Buffer.from(JSON.stringify({ version: cur.version })), { 'content-type': 'application/octet-stream' });
    expect(octet.status).toBe(415);
    expect(octet.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('내려받기 머리글과 파일 이름', () => {
  it('sends the stored type, an attachment disposition, nosniff, a single sandbox CSP and no-store', async () => {
    const { s: han } = await as('u-a-han');
    for (const [bytes, name, type] of [[PNG, 'a.png', 'image/png'], [PDF, 'b.pdf', 'application/pdf'], [JPEG, 'c.jpg', 'image/jpeg']] as const) {
      const x = (await upload(ctx.app, han, 'wr-6', bytes, name)).body.paymentEvidence.attachments.at(-1);
      const dl = await ctx.app.inject({ method: 'GET', url: x.contentUrl, headers: { cookie: han.cookie } });
      expect(dl.statusCode).toBe(200);
      expect(dl.headers['content-type']).toBe(type);
      expect(dl.headers['content-disposition']).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`);
      expect(dl.headers['x-content-type-options']).toBe('nosniff');
      expect(dl.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(dl.headers['cache-control']).toBe('no-store');
      expect(dl.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(Number(dl.headers['content-length'])).toBe(bytes.length);
      expect(Buffer.compare(dl.rawPayload, bytes)).toBe(0);
      // 로그인하지 않으면 내려받기도 401
      expect((await ctx.app.inject({ method: 'GET', url: x.contentUrl })).statusCode).toBe(401);
    }
    // 로그인하지 않으면 목록도 401
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/requests/wr-6/attachments' });
    expect(anon.statusCode).toBe(401);
  });

  it('cleans names: quotes and CR/LF stay out of the header, Korean goes to filename*, paths are dropped', async () => {
    const { s: han } = await as('u-a-han');
    const cases: [Buffer, string, string, RegExp][] = [
      [PDF, 'in"voice\r\nX-Evil: 1.pdf', 'in_voiceX-Evil_ 1.pdf', /^attachment; filename="in_voiceX-Evil_ 1\.pdf"; filename\*=UTF-8''in_voiceX-Evil_%201\.pdf$/],
      [variant(PDF), '인보이스.pdf', '인보이스.pdf', /^attachment; filename="attachment\.pdf"; filename\*=UTF-8''%EC%9D%B8%EB%B3%B4%EC%9D%B4%EC%8A%A4\.pdf$/],
      [variant(PDF, 2), '../../x.pdf', 'x.pdf', /^attachment; filename="x\.pdf"/],
      [variant(PDF, 3), 'C:\\Users\\me\\계약서 (최종).pdf', '계약서 (최종).pdf', /filename="_ \(_\)\.pdf"|filename="attachment\.pdf"/],
    ];
    for (const [bytes, raw, stored, header] of cases) {
      const res = await upload(ctx.app, han, 'wr-6', bytes, raw);
      expect(res.status, raw).toBe(201);
      const x = res.body.paymentEvidence.attachments.at(-1);
      expect(x.fileName, raw).toBe(stored);
      const dl = await ctx.app.inject({ method: 'GET', url: x.contentUrl, headers: { cookie: han.cookie } });
      const cd = String(dl.headers['content-disposition']);
      expect(cd, raw).toMatch(header);
      expect(cd).not.toMatch(/[\r\n\0]/);
    }
  });

  it('rejects a badly encoded name header (422 VALIDATION fileName) and names a file without the header from its SHA-256', async () => {
    const { s: han } = await as('u-a-han');
    const bad = await upload(ctx.app, han, 'wr-6', PDF, null, { 'x-attachment-name': '%E0%A4%A' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION');
    expect(bad.body.error.fields[0].field).toBe('fileName');
    const broken = await upload(ctx.app, han, 'wr-6', PDF, null, { 'x-attachment-name': '%ED%A0%80.pdf' }); // 짝 없는 서로게이트(U+D800)
    expect(broken.status).toBe(422);
    expect(broken.body.error.fields[0].field).toBe('fileName');
    const none = await upload(ctx.app, han, 'wr-6', PDF, null);
    expect(none.status).toBe(201);
    expect(none.body.paymentEvidence.attachments[0].fileName).toBe(`지급근거-${sha(PDF).slice(0, 8)}.pdf`);
  });
});

describe('지급 근거 메모', () => {
  it('saves a cleaned note, refuses 301 characters, clears with an empty value and audits only length and SHA-256', async () => {
    const { a } = await as('u-a-han');
    const v0 = version('wr-6');
    const saved = await a.put('/api/requests/wr-6/evidence-note', { note: '  인보이스\u200b INV-2026-1043\u202e  ' });
    expect(saved.status).toBe(200);
    expect(saved.body.paymentEvidence.note).toMatchObject({ text: '인보이스 INV-2026-1043', updatedBy: { name: '한지수' } });
    expect(saved.body.paymentEvidence.hasAny).toBe(true);
    expect(saved.body.version).toBe(v0 + 1);
    const long = await a.put('/api/requests/wr-6/evidence-note', { note: 'x'.repeat(301) });
    expect(long.status).toBe(422);
    expect(long.body.error.code).toBe('VALIDATION');
    expect(long.body.error.fields[0].field).toBe('note');
    // 같은 값 다시 저장: 아무것도 쓰지 않는다
    const same = await a.put('/api/requests/wr-6/evidence-note', { note: '인보이스 INV-2026-1043' });
    expect(same.status).toBe(200);
    expect(same.body.version).toBe(v0 + 1);
    const rows = auditRows('wr-6', 'request.evidence_note_updated');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe('WR-000006 지급 근거 메모 저장');
    expect(rows[0]!.detail).toEqual({ before: null, after: { length: [...'인보이스 INV-2026-1043'].length, sha256: createHash('sha256').update('인보이스 INV-2026-1043', 'utf8').digest('hex') } });
    expect(JSON.stringify(rows)).not.toContain('INV-2026-1043');
    const cleared = await a.put('/api/requests/wr-6/evidence-note', { note: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.paymentEvidence).toMatchObject({ note: null, hasAny: false });
    const rows2 = auditRows('wr-6', 'request.evidence_note_updated');
    expect(rows2).toHaveLength(2);
    expect(rows2[1]!.summary).toBe('WR-000006 지급 근거 메모 지움');
    expect(rows2[1]!.detail.after).toBeNull();
    expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);
    expect(ACTION_LABEL['request.evidence_note_updated']).toBe('지급 근거 메모 수정');
  });
});

describe('끄기 스위치와 업로드 한도', () => {
  it('REQUEST_ATTACHMENTS=off refuses only uploads (403 ATTACHMENTS_DISABLED); list, download, delete and note keep working', async () => {
    const on = await makeApp();
    const han1 = await login(on.app, 'u-a-han');
    const x = (await upload(on.app, han1, 'wr-6', PNG, 'a.png')).body.paymentEvidence.attachments[0];
    await on.app.close(); on.db.close();

    process.env.REQUEST_ATTACHMENTS = 'off';
    let off: TestCtx;
    try { off = await makeApp(); } finally { delete process.env.REQUEST_ATTACHMENTS; }
    try {
      const han = await login(off.app, 'u-a-han');
      // 끈 앱에는 같은 파일이 없으므로 DB에 직접 넣어 둔다(앱 밖 준비)
      off.db.prepare('INSERT INTO request_attachments (id, request_id, org_id, file_name, content_type, size_bytes, sha256, added_by, added_at, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(x.id, 'wr-6', 'org-a', 'a.png', 'image/png', PNG.length, sha(PNG), 'u-a-han', new Date().toISOString(), PNG);
      const up = await upload(off.app, han, 'wr-6', PDF, 'b.pdf');
      expect(up.status).toBe(403);
      expect(up.body.error.code).toBe('ATTACHMENTS_DISABLED');
      const a = api(off.app, han);
      const list = await a.get('/api/requests/wr-6/attachments');
      expect(list.status).toBe(200);
      expect(list.body.uploadsEnabled).toBe(false);
      expect((await off.app.inject({ method: 'GET', url: x.contentUrl, headers: { cookie: han.cookie } })).statusCode).toBe(200);
      expect((await a.put('/api/requests/wr-6/evidence-note', { note: 'INV-1' })).status).toBe(200);
      expect((await a.del(`/api/requests/wr-6/attachments/${x.id}`)).status).toBe(200);
    } finally {
      await off!.app.close(); off!.db.close();
    }
  });

  it('applies a per-route upload rate limit (third upload in a minute is 429 RATE_LIMITED)', async () => {
    const limited = await makeApp({ config: { attachmentUploadRateLimitMax: 2 } });
    try {
      const han = await login(limited.app, 'u-a-han');
      expect((await upload(limited.app, han, 'wr-6', PNG, 'a.png')).status).toBe(201);
      expect((await upload(limited.app, han, 'wr-6', PDF, 'b.pdf')).status).toBe(201);
      const third = await upload(limited.app, han, 'wr-6', JPEG, 'c.jpg');
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('RATE_LIMITED');
      // 다른 경로는 이 한도를 쓰지 않는다
      expect((await api(limited.app, han).get('/api/requests/wr-6')).status).toBe(200);
    } finally {
      await limited.app.close(); limited.db.close();
    }
  });

  it('counts attempts the pre-check rejects (wrong format, not logged in, another org) toward the route limit', async () => {
    // 사전 검사는 경로 한도 훅 뒤(preParsing)에 돈다. onRequest였을 때는 거부된 시도가 한도에 세지지 않아 끝없이 보낼 수 있었다.
    const cases: [string, (app: TestCtx['app']) => Promise<{ status: number; body: any }>, number][] = [
      ['wrong format', async (app) => upload(app, await login(app, 'u-a-han'), 'wr-6', PDF, 'x.pdf', { 'content-type': 'text/plain' }), 415],
      ['not logged in', async (app) => upload(app, null, 'wr-6', PDF, 'x.pdf'), 401],
      ['another org', async (app) => upload(app, await login(app, 'u-b-bae'), 'wr-6', PDF, 'x.pdf'), 404],
    ];
    for (const [label, send, rejected] of cases) {
      const limited = await makeApp({ config: { attachmentUploadRateLimitMax: 3 } });
      try {
        const out: { status: number; body: any }[] = [];
        for (let i = 0; i < 4; i++) out.push(await send(limited.app));
        expect(out.map((r) => r.status), label).toEqual([rejected, rejected, rejected, 429]);
        expect(out[3]!.body.error.code, label).toBe('RATE_LIMITED');
      } finally {
        await limited.app.close(); limited.db.close();
      }
    }
  });
});

describe('로그', () => {
  it('keeps attachment names and bytes out of the request log (upload, download, delete)', async () => {
    const { Writable } = await import('node:stream');
    const lines: string[] = [];
    const logStream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const logged = await makeApp({ config: { logLevel: 'info' }, logStream });
    try {
      const han = await login(logged.app, 'u-a-han');
      const up = await upload(logged.app, han, 'wr-6', PNG, '비밀-인보이스.png');
      expect(up.status).toBe(201);
      const x = up.body.paymentEvidence.attachments[0];
      expect(x.fileName).toBe('비밀-인보이스.png');
      const dl = await logged.app.inject({ method: 'GET', url: x.contentUrl, headers: { cookie: han.cookie } });
      expect(Buffer.compare(dl.rawPayload, PNG)).toBe(0);
      expect((await api(logged.app, han).del(`/api/requests/wr-6/attachments/${x.id}`)).status).toBe(200);
      const text = lines.join('');
      // 로그는 실제로 남았다(올리기 경로의 요청 기록 포함)
      expect(text).toContain('/api/requests/wr-6/attachments');
      expect(text).toContain('request completed');
      for (const secret of ['비밀', encodeURIComponent('비밀'), encodeURIComponent('비밀').toLowerCase(), PNG.toString('base64'), PNG.toString('hex'), PNG.toString('latin1')]) {
        expect(text, secret).not.toContain(secret);
      }
    } finally {
      await logged.app.close(); logged.db.close();
    }
  });
});

describe('파일 내용을 읽는 조회', () => {
  it('selects the content column only in the download query', async () => {
    const { readFileSync } = await import('node:fs');
    const sources = ['server/domain/attachment-store.ts', 'server/domain/attachments.ts', 'server/domain/requests.ts', 'server/app.ts'].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
    const selects = sources.join('\n').match(/SELECT[^;`']*?\bcontent\b[^;`']*?FROM request_attachments/g) ?? [];
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain('a.content FROM request_attachments');
    // 'SELECT *'·'SELECT a.*'도 내용 열을 읽으므로 쓰지 않는다
    expect(sources.join('\n')).not.toMatch(/SELECT\s+(?:\w+\.)?\*[^;`']*?FROM request_attachments/);
  });
});
