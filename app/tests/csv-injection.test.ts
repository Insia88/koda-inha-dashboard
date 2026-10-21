// A3: CSV 수식 주입 막기. csvCell은 = + - @ 탭 CR에 더해 LF와 전각 ＝＋－＠로 시작하는 값도 글자로 남긴다(앞에 작은따옴표).
// 내보낼 때의 글자 표현만 바뀌고 저장된 감사 기록 행·해시는 그대로다. 감사 기록 CSV의 표지 행과, 지급 근거(파일 이름·메모)가 닿는 칸도 확인한다.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { csvCell, FORMULA_START, toCsv, toCsvWithCover } from '../server/csv.ts';
import { auditCsvCover, type AuditCsvCoverInput } from '../server/domain/readmodels.ts';
import { verifyChain } from '../server/audit.ts';
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

describe('csvCell', () => {
  it('neutralises values starting with LF and with full-width ＝＋－＠, and keeps the existing =,+,-,@,TAB,CR handling', () => {
    expect(csvCell('\n=1+1')).toBe(`"'\n=1+1"`);
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
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
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

  it('for any text, the cell reads back as one cell that does not start with a formula character, and is the original text after an added quote', () => {
    const unit = fc.constantFrom(...DANGEROUS, 'a', '가', '"', ',', "'", ' ', '1', 'Ａ');
    fc.assert(fc.property(fc.oneof(fc.string({ unit, maxLength: 12 }), fc.string({ maxLength: 12 })), (text) => {
      const back = readCell(csvCell(text));
      expect(startsDangerous(back)).toBe(false);
      expect(back).toBe(startsDangerous(text) ? `'${text}` : text);
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
});
