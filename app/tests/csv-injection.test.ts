// A3: CSV 수식 주입 막기. csvCell은 = + - @ 탭 CR에 더해 LF와 전각 ＝＋－＠로 시작하는 값도 글자로 남긴다(앞에 작은따옴표).
// A3 검토: 목록 구분 기호가 ';'인 지역 설정의 Excel은 ';'에서 칸을 나누므로, 값 가운데 ';' 바로 뒤의 수식 문자 앞에도 작은따옴표를 넣는다.
// 내보낼 때의 글자 표현만 바뀌고 저장된 감사 기록 행·해시는 그대로다. 감사 기록 CSV의 표지 행과, 지급 근거(파일 이름·메모)·주소 이름이 닿는 칸도 확인한다.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { csvCell, FORMULA_START, toCsv, toCsvWithCover } from '../server/csv.ts';
import { auditCsvCover, type AuditCsvCoverInput } from '../server/domain/readmodels.ts';
import { verifyChain } from '../server/audit.ts';
import { middleSegment } from '../shared/address-rules.ts';
import { api, login, makeApp, parseCsv, splitAuditCsv, upload } from './helpers.ts';

/** 스프레드시트가 수식으로 읽을 수 있는 첫 글자(반각·전각, 탭·CR·LF) */
const DANGEROUS = ['=', '+', '-', '@', '\t', '\r', '\n', '＝', '＋', '－', '＠'];
/** 셀 하나만 담은 CSV 한 줄을 다시 읽는다 */
const readCell = (cell: string) => {
  const rows = parseCsv(`${cell}\r\n`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveLength(1);
  return rows[0]![0]!;
};
const startsDangerous = (s: string) => DANGEROUS.some((c) => s.startsWith(c));
/**
 * 칸 맨 앞의 글자 읽기: 큰따옴표로 시작하면 여는 따옴표를 떼고, 이어지는 '""'는 글자 '"' 하나, 바로 닫는 따옴표('""' 뒤 다른 글자)면 빈 따옴표 뒤의 글자가 칸의 시작이다.
 */
const fieldStart = (p: string) => {
  if (!p.startsWith('"')) return p;
  const rest = p.slice(1);
  if (rest.startsWith('""')) return rest.slice(1);
  if (rest.startsWith('"')) return rest.slice(1);
  return rest;
};
/**
 * 목록 구분 기호가 ';'인 Excel이 이 CSV 글자를 읽는 방식을 흉내 낸다: ';'와 줄바꿈마다 새 칸이 시작되고(칸 맨 앞이 아닌 큰따옴표는
 * 따옴표로 보지 않으므로 칸 가운데의 줄바꿈도 새 행이 된다), 칸 맨 앞의 큰따옴표는 따옴표로 읽힌다.
 * 그렇게 시작하는 칸 가운데 수식 문자로 시작하는 것을 돌려준다(빈 배열이면 안전).
 */
const semicolonFormulaCells = (csvText: string) => csvText.split(/;|\r\n|\r|\n/).map(fieldStart).filter(startsDangerous);
/** csvCell을 거쳐 다시 읽었을 때 나와야 하는 글자: 맨 앞이 수식 문자면 작은따옴표, 가운데 ';'·줄바꿈 바로 뒤(큰따옴표만 끼어 있어도)의 수식 문자 앞에도 작은따옴표 */
const expectedText = (t: string) => (startsDangerous(t) ? `'${t}` : t).replace(/(;|\r\n|\r|\n)(?="*[=+\-@\t\r\n＝＋－＠])/gu, "$1'");

describe('csvCell', () => {
  it('neutralises values starting with LF and with full-width ＝＋－＠, and keeps the existing =,+,-,@,TAB,CR handling', () => {
    // LF로 시작: 맨 앞에 작은따옴표, 그리고 줄바꿈 바로 뒤의 '='에도(A3 검토, ';' 구분 Excel에서는 둘째 줄이 새 행의 첫 칸이 된다)
    expect(csvCell('\n=1+1')).toBe(`"'\n'=1+1"`);
    expect(csvCell('\nx')).toBe(`"'\nx"`);
    expect(csvCell('＝HYPERLINK("http://evil")')).toBe(`"'＝HYPERLINK(""http://evil"")"`);
    expect(csvCell('＋1')).toBe(`"'＋1"`);
    expect(csvCell('－2')).toBe(`"'－2"`);
    expect(csvCell('＠SUM(A1)')).toBe(`"'＠SUM(A1)"`);
    // 기존 처리는 그대로
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('-2')).toBe(`"'-2"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('\t=1')).toBe(`"'\t=1"`);
    expect(csvCell('\r=1')).toBe(`"'\r'=1"`);
    expect(csvCell('\rx')).toBe(`"'\rx"`);
    // 가운데에 있는 기호나 보통 글자는 바꾸지 않는다
    expect(csvCell('A＝B')).toBe('A＝B');
    expect(csvCell('정상 값')).toBe('정상 값');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12)).toBe('12');
    expect(toCsv(['a'], [['b,c']])).toBe('﻿a\r\n"b,c"\r\n');
    for (const c of DANGEROUS) expect(FORMULA_START.test(`${c}x`), JSON.stringify(c)).toBe(true);
    for (const c of ['a', '가', ' ', "'", '"', '0', '#', 'Ａ']) expect(FORMULA_START.test(`${c}x`), c).toBe(false);
  });

  it("puts a quote after a ';' that is followed by a formula character, so Excel with ';' as the list separator does not start a cell with it", () => {
    // R5 검토의 두 입력: 주소 이름이 들어간 감사 기록 요약, 내용 검색 필터가 들어간 표지 '조건'
    expect(csvCell("주소 등록 요청: x;=cmd|' /C calc'!A0; (USDC/Ethereum)")).toBe("주소 등록 요청: x;'=cmd|' /C calc'!A0; (USDC/Ethereum)");
    expect(csvCell('x;=1+1')).toBe("x;'=1+1");
    expect(csvCell('내용 검색: x;=1+1;')).toBe("내용 검색: x;'=1+1;");
    for (const c of DANGEROUS) {
      const out = csvCell(`a;${c}b`);
      expect(semicolonFormulaCells(out), JSON.stringify(out)).toEqual([]);
      expect(readCell(out)).toBe(`a;'${c}b`);
    }
    // 사이에 큰따옴표만 있어도(그 칸은 큰따옴표로 시작해 따옴표가 벗겨진다)
    expect(csvCell('x;"=1+1"')).toBe(`"x;'""=1+1"""`);
    expect(csvCell('x;""＝1')).toBe(`"x;'""""＝1"`);
    // 맨 앞과 가운데가 함께
    expect(csvCell('=a;+b')).toBe(`"'=a;'+b"`);
    // 가운데 줄바꿈 바로 뒤도 같다(';' 구분 Excel은 칸 가운데의 줄바꿈에서 새 행을 시작한다)
    expect(csvCell('a\n=b')).toBe(`"a\n'=b"`);
    expect(csvCell('a\r\n－b')).toBe(`"a\r\n'－b"`);
    // ';'·줄바꿈 뒤가 수식 문자가 아니면 그대로(공백이 끼어도 그 칸은 공백으로 시작하므로 그대로)
    expect(csvCell('a;b')).toBe('a;b');
    expect(csvCell('a; =b')).toBe('a; =b');
    expect(csvCell('a;')).toBe('a;');
    expect(csvCell('A＝B;C')).toBe('A＝B;C');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });

  it("for any text, the cell reads back as one cell that does not start with a formula character, no piece after a ';' or line break starts with one, and it is the original text with quotes added only before those characters", () => {
    const unit = fc.constantFrom(...DANGEROUS, 'a', '가', '"', ',', ';', "'", ' ', '1', 'Ａ');
    fc.assert(fc.property(fc.oneof(fc.string({ unit, maxLength: 12 }), fc.string({ maxLength: 12 })), (text) => {
      const cell = csvCell(text);
      const back = readCell(cell);
      expect(startsDangerous(back)).toBe(false);
      expect(semicolonFormulaCells(cell)).toEqual([]);
      expect(back).toBe(expectedText(text));
      // 맨 앞이 수식 문자가 아니고 ';'·줄바꿈이 없으면 글자가 바뀌지 않는다(내보낸 '내용' = 저장된 요약)
      if (!startsDangerous(text) && !/[;\r\n]/.test(text)) expect(back).toBe(text);
    }), { numRuns: 1000 });
  });
});

describe('감사 기록 CSV: 표지 행과 표의 모든 칸', () => {
  const base: AuditCsvCoverInput = {
    filters: {}, rowCount: 1, matchedCount: 1, limit: 10, exporter: { name: '문태호', roleLabels: ['감사 담당자'] }, exportedAt: '2026-10-21T00:00:00.000Z',
    chain: { ok: true, count: 1, brokenAtNo: null, headHash: 'a'.repeat(64) },
  };
  const HEADER = ['순번', '시각(한국 시간)', '수행자', '행동', '행동 코드', '대상 종류', '대상 ID', '내용', '결정 근거(내보낼 때 계산)', '해시'];

  it('cover rows: an exporter name or a filter value starting with a full-width or LF formula character stays text', () => {
    for (const c of DANGEROUS) {
      const evil = `${c}HYPERLINK("http://evil")`;
      const cover = auditCsvCover({ ...base, exporter: { name: evil, roleLabels: [] }, filters: { actor: evil, q: `${c}cmd` } });
      const csv = toCsvWithCover(cover, HEADER, []);
      const parsed = parseCsv(csv.slice(1));
      for (const row of parsed) for (const cell of row) expect(startsDangerous(cell), `${JSON.stringify(c)} ${JSON.stringify(cell)}`).toBe(false);
      const { cover: back } = splitAuditCsv(csv);
      const get = (k: string) => back.find((r) => r[0] === k)?.[1];
      // 셀 첫 글자가 수식 문자이면 작은따옴표가 붙는다(이름은 표지 칸의 맨 앞)
      expect(get('내보낸 사람')).toBe(`'${evil} (역할 없음)`);
      // 표지 안의 사용자 입력도 같은 규칙(줄바꿈·탭은 공백으로 바뀌어 줄 수가 늘지 않는다)
      const cond = get('조건')!;
      if (['\t', '\r', '\n'].includes(c)) expect(cond).toBe(`수행자:  HYPERLINK("http://evil") · 내용 검색:  cmd`);
      else expect(cond).toBe(`수행자: '${evil} · 내용 검색: '${c}cmd`);
    }
  });

  it('table rows: actor, summary (attachment file name, evidence note) and decision-evidence cells starting with any formula character stay text; the stored hash column is unchanged', () => {
    for (const c of DANGEROUS) {
      const row = [7, '2026-10-21 09:00:00', `${c}사용자`, '지급 근거 파일 첨부', 'request.attachment_added', 'withdrawal_request', `${c}id`, `${c}HYPERLINK("x").pdf (PDF, 1KB)`, `${c}결정 근거`, 'b'.repeat(64)];
      const { rows } = splitAuditCsv(toCsvWithCover(auditCsvCover(base), HEADER, [row]));
      expect(rows).toHaveLength(1);
      for (const cell of rows[0]!) expect(startsDangerous(cell), `${JSON.stringify(c)} ${JSON.stringify(cell)}`).toBe(false);
      expect(rows[0]![2]).toBe(`'${c}사용자`);
      expect(rows[0]![7]).toBe(`'${c}HYPERLINK("x").pdf (PDF, 1KB)`);
      expect(rows[0]![8]).toBe(`'${c}결정 근거`);
      expect(rows[0]![9]).toBe('b'.repeat(64));
    }
  });

  it("cover '조건' and a summary with a ';' before a formula character: no ';'-split piece starts with one (Excel with ';' as the list separator)", () => {
    const cover = auditCsvCover({ ...base, filters: { q: 'x;=1+1;' } });
    const summary = "주소 등록 요청: x;=cmd|' /C calc'!A0; (USDC/Ethereum)";
    const row = [8, '2026-10-21 09:00:00', '한지수', '주소 등록 요청', 'address.created', 'address_book', 'ab-99', summary, '', 'c'.repeat(64)];
    const csv = toCsvWithCover(cover, HEADER, [row]);
    expect(semicolonFormulaCells(csv)).toEqual([]);
    const { cover: back, rows } = splitAuditCsv(csv);
    expect(back.find((r) => r[0] === '조건')?.[1]).toBe("내용 검색: x;'=1+1;");
    expect(rows[0]![7]).toBe("주소 등록 요청: x;'=cmd|' /C calc'!A0; (USDC/Ethereum)");
    expect(rows[0]![9]).toBe('c'.repeat(64));
  });

  it('a real export after attaching files whose names start with formula characters and saving a payment-evidence note: no cell starts with a formula character, the note text is not exported, rows and hashes are as stored', async () => {
    const ctx = await makeApp();
    try {
      const han = await login(ctx.app, 'u-a-han');
      const names = ['＝HYPERLINK(1).pdf', '=1+1.pdf', '＠SUM(A1).pdf', '－2.pdf'];
      for (const [i, name] of names.entries()) {
        const pdf = Buffer.alloc(200 + i, 0x20);
        pdf.write('%PDF-1.4\n', 0, 'latin1');
        const res = await upload(ctx.app, han, 'wr-6', pdf, name);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
      }
      const note = '＝IMPORTXML("http://evil","//a") INV-1043';
      expect((await api(ctx.app, han).put('/api/requests/wr-6/evidence-note', { note })).status).toBe(200);

      const moon = await login(ctx.app, 'u-a-moon');
      const res = await ctx.app.inject({ method: 'GET', url: `/api/audit/export.csv?actor=${encodeURIComponent('＝한지수')}`, headers: { cookie: moon.cookie } });
      expect(res.statusCode).toBe(200);
      const all = parseCsv(res.body.slice(1));
      for (const row of all) for (const cell of row) expect(startsDangerous(cell), JSON.stringify(cell)).toBe(false);
      // 표지 '조건'의 필터 값도 작은따옴표로 시작한다
      const { cover } = splitAuditCsv(res.body);
      expect(cover.find((r) => r[0] === '조건')?.[1]).toBe("수행자: '＝한지수");
      // 메모 글은 감사 기록에 남지 않으므로(길이·SHA-256만) CSV에도 없다
      expect(res.body).not.toContain('IMPORTXML');

      // 필터 없이 내보내 첨부 행을 본다: 내용 칸은 저장된 요약 그대로(요청 번호로 시작), 해시 칸은 저장된 해시 그대로다.
      const full = await ctx.app.inject({ method: 'GET', url: '/api/audit/export.csv', headers: { cookie: moon.cookie } });
      const { header, rows } = splitAuditCsv(full.body);
      for (const row of parseCsv(full.body.slice(1))) for (const cell of row) expect(startsDangerous(cell), JSON.stringify(cell)).toBe(false);
      // 첨부·메모 행이 실제로 들어 있는 전체 내보내기에도 메모 글이 없다(A3 검토: 위 필터 내보내기는 0건이라 이 검사가 실제 근거다)
      expect(full.body).not.toContain('IMPORTXML');
      expect(full.body).not.toContain('INV-1043');
      expect(semicolonFormulaCells(full.body)).toEqual([]);
      const col = (n: string) => header.indexOf(n);
      const stored = ctx.db.prepare("SELECT summary, hash FROM audit_log WHERE org_id = 'org-a' AND action = 'request.attachment_added' ORDER BY seq").all() as { summary: string; hash: string }[];
      expect(stored).toHaveLength(names.length);
      const attached = rows.filter((r) => r[col('행동 코드')] === 'request.attachment_added');
      expect(attached.map((r) => r[col('내용')])).toEqual(stored.map((s) => s.summary));
      expect(attached.map((r) => r[col('해시')])).toEqual(stored.map((s) => s.hash));
      for (const [i, name] of names.entries()) expect(stored[i]!.summary).toContain(`지급 근거 파일 첨부: ${name} (PDF`);
      const noteRows = rows.filter((r) => r[col('행동 코드')] === 'request.evidence_note_updated');
      expect(noteRows.map((r) => r[col('내용')])).toEqual(['WR-000006 지급 근거 메모 저장']);
      // 결정 근거 열(승인·반려 행만 값이 있음)도 수식 문자로 시작하지 않는다(위 전체 검사)
      expect(rows.some((r) => r[col('결정 근거(내보낼 때 계산)')] !== '')).toBe(true);
      expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);
    } finally {
      await ctx.app.close();
      ctx.db.close();
    }
  });

  it("a real export after registering an address whose name has ';=' and with a 'q' filter 'x;=1+1;': no ';'-split piece starts with a formula character, and the stored rows and hashes are not rewritten", async () => {
    const ctx = await makeApp();
    try {
      const han = await login(ctx.app, 'u-a-han');
      const address = `MOCK-EVM-${'3c9a71e0b5d2f48a6c1e9b07d3f5a28c4e6b1d90'.toUpperCase()}`;
      const label = "x;=cmd|' /C calc'!A0;";
      const created = await api(ctx.app, han).post('/api/addresses', {
        label, counterparty: '모의 상대방', assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '',
        confirmTail: address.slice(-6), confirmMiddle: middleSegment(address).text, ackNotVerified: true, ackOutOfBandConfirmed: true,
        receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const stored = ctx.db.prepare("SELECT summary FROM audit_log WHERE org_id = 'org-a' AND action = 'address.created' AND target_id = ?").get(created.body.address.id) as { summary: string };
      expect(stored.summary).toBe(`주소 등록 요청: ${label} (USDC/Ethereum)`);

      const moon = await login(ctx.app, 'u-a-moon');
      const before = ctx.db.prepare("SELECT seq, summary, hash FROM audit_log WHERE org_id = 'org-a' ORDER BY seq").all();
      const filtered = await ctx.app.inject({ method: 'GET', url: `/api/audit/export.csv?q=${encodeURIComponent('x;=1+1;')}`, headers: { cookie: moon.cookie } });
      expect(filtered.statusCode).toBe(200);
      expect(semicolonFormulaCells(filtered.body)).toEqual([]);
      expect(splitAuditCsv(filtered.body).cover.find((r) => r[0] === '조건')?.[1]).toBe("내용 검색: x;'=1+1;");

      const full = await ctx.app.inject({ method: 'GET', url: '/api/audit/export.csv', headers: { cookie: moon.cookie } });
      expect(semicolonFormulaCells(full.body)).toEqual([]);
      for (const row of parseCsv(full.body.slice(1))) for (const cell of row) expect(startsDangerous(cell), JSON.stringify(cell)).toBe(false);
      const { header, rows } = splitAuditCsv(full.body);
      const col = (n: string) => header.indexOf(n);
      const row = rows.find((r) => r[col('행동 코드')] === 'address.created' && r[col('대상 ID')] === created.body.address.id)!;
      // 내보낸 글자에만 작은따옴표가 하나 들어가고, 해시 칸은 저장된 값 그대로다
      expect(row[col('내용')]).toBe("주소 등록 요청: x;'=cmd|' /C calc'!A0; (USDC/Ethereum)");
      // 내보내기는 기록(audit.exported)을 두 건 더할 뿐 앞의 행은 그대로다
      const after = ctx.db.prepare("SELECT seq, summary, hash FROM audit_log WHERE org_id = 'org-a' ORDER BY seq").all();
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.length - before.length).toBe(2);
      expect(rows.map((r) => r[col('해시')])).toEqual(expect.arrayContaining((before as { hash: string }[]).map((b) => b.hash)));
      expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);
    } finally {
      await ctx.app.close();
      ctx.db.close();
    }
  });
});
