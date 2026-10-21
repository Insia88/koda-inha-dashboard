// A2-4: 감사 기록 CSV 표지(기간·조건·내보낸 사람·내보낸 시각(KST)·해시 연결 확인 결과). 해시된 행은 그대로이고 표지는 저장하지 않는다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, login, makeApp, parseCsv, splitAuditCsv, type TestCtx } from './helpers.ts';
import { verifyChain } from '../server/audit.ts';
import { kstDateTime } from '../server/csv.ts';
import { auditCsvCover, type AuditCsvCoverInput } from '../server/domain/readmodels.ts';

let ctx: TestCtx;
beforeEach(async () => { ctx = await makeApp(); });
afterEach(async () => { await ctx.app.close(); ctx.db.close(); });

const coverMap = (cover: string[][]) => new Map(cover.slice(2).map((r) => [r[0]!, r[1]!]));
const KST_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(한국 시간\)$/;

async function exportAs(userId: string, query = '') {
  const s = await login(ctx.app, userId);
  const verify = (await api(ctx.app, s).get('/api/audit/verify')).body;
  const res = await ctx.app.inject({ method: 'GET', url: `/api/audit/export.csv${query}`, headers: { cookie: s.cookie } });
  return { res, verify, s };
}

describe('감사 기록 CSV 표지', () => {
  it('puts a cover above the table: period, conditions (Korean name + code), exporter with role, KST time, and the same chain count/head as /verify', async () => {
    const { res, verify } = await exportAs('u-a-moon', '?from=2026-09-01&to=2026-09-30&action=request.approved');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.startsWith('﻿')).toBe(true);
    const firstLine = res.body.slice(1).split('\r\n')[0]!;
    expect(firstLine).toBe('KODA 감사 기록 내보내기 표지 — 내보낼 때 만든 설명이며 감사 기록이 아닙니다(해시 대상 아님)');
    const { cover, header } = splitAuditCsv(res.body);
    expect(cover[1]).toEqual(['항목', '값']);
    const m = coverMap(cover);
    expect(m.get('기간')).toBe('2026-09-01 ~ 2026-09-30 (한국 시간 날짜)');
    expect(m.get('조건')).toBe('행동: 승인(request.approved)');
    expect(m.get('내보낸 사람')).toBe('문태호 (감사 담당자)');
    expect(m.get('내보낸 시각')).toMatch(KST_TIME);
    expect(m.get('내보낸 행')).toMatch(/^\d+건 · 조건에 맞는 기록 \d+건$/);
    expect(verify.ok).toBe(true);
    expect(m.get('해시 연결 확인(조직 전체)')).toBe(`기록 ${verify.count}건이 각각 바로 앞 기록과 끊김 없이 이어져 있습니다(해시 연결 확인).`);
    expect(m.get('보관용 값')).toBe(`기록 ${verify.count}건 · 마지막 기록 해시 ${verify.headHash}`);
    expect(m.get('확인 범위')).toContain('가장 최근 기록을 지웠거나');
    expect(m.get('안내')).toBe('표지와 결정 근거 열은 내보낼 때 계산한 값입니다. 아래 표의 각 행과 해시 열은 저장된 기록 그대로입니다.');
    for (const [k, v] of m) expect(`${k} ${v}`).not.toMatch(/빠짐없이|변조 없음|안전합니다|보장/);
    // 빈 줄 다음 첫 줄이 '순번'으로 시작하는 머리글
    const lines = res.body.slice(1).split('\r\n');
    const blank = lines.indexOf('');
    expect(lines[blank + 1]!.startsWith('순번,')).toBe(true);
    expect(header[0]).toBe('순번');
    // 파일 이름의 날짜는 한국 시간(표지의 내보낸 시각과 같은 날짜)
    expect(String(res.headers['content-disposition'])).toBe(`attachment; filename="koda-audit-${m.get('내보낸 시각')!.slice(0, 10)}.csv"`);
  });

  it('writes 전체 기간·조건 없음 without filters, counts every row, keeps table rows and hashes as stored, and records rowCount·matchedCount·chain in audit.exported', async () => {
    const { res, verify } = await exportAs('u-a-moon');
    const { cover, rows } = splitAuditCsv(res.body);
    const m = coverMap(cover);
    expect(m.get('기간')).toBe('전체 기간');
    expect(m.get('조건')).toBe('조건 없음');
    // 내보내기 직전 체인(로그인 포함)의 건수와 같다. audit.exported 행은 표에 들어가지 않는다.
    expect(rows).toHaveLength(verify.count);
    expect(m.get('내보낸 행')).toBe(`${verify.count}건 · 조건에 맞는 기록 ${verify.count}건`);
    const stored = ctx.db.prepare("SELECT hash FROM audit_log WHERE org_id = 'org-a' ORDER BY seq").all() as { hash: string }[];
    rows.forEach((r, i) => { expect(Number(r[0])).toBe(i + 1); expect(r[r.length - 1]).toBe(stored[i]!.hash); });
    expect(verifyChain(ctx.db, 'org-a')).toMatchObject({ ok: true, count: verify.count + 1 });
    const exported = ctx.db.prepare("SELECT detail, created_at FROM audit_log WHERE org_id = 'org-a' AND action = 'audit.exported'").all() as { detail: string; created_at: string }[];
    expect(exported).toHaveLength(1);
    const d = JSON.parse(exported[0]!.detail);
    expect(d).toEqual({ filters: {}, rowCount: verify.count, matchedCount: verify.count, truncated: false, chain: { ok: true, count: verify.count, brokenAtNo: null, headHash: verify.headHash } });
    expect(d).not.toHaveProperty('chain.brokenAtSeq');
    // 표지의 내보낸 시각 = audit.exported 기록 시각(KST)
    expect(m.get('내보낸 시각')).toBe(`${kstDateTime(exported[0]!.created_at, { seconds: true })} (한국 시간)`);
  });

  it('neutralises a formula typed into the actor filter: the cover keeps it as text starting with a single quote', async () => {
    const evil = '=HYPERLINK("http://evil")';
    const { res } = await exportAs('u-a-moon', `?actor=${encodeURIComponent(evil)}&q=${encodeURIComponent('+cmd')}`);
    expect(res.statusCode).toBe(200);
    const m = coverMap(splitAuditCsv(res.body).cover);
    expect(m.get('조건')).toBe(`수행자: '${evil} · 내용 검색: '+cmd`);
    expect(res.body).not.toMatch(/(^|,)=HYPERLINK/m);
    // 어느 표지 셀도 수식 문자로 시작하지 않는다
    for (const row of parseCsv(res.body.slice(1))) for (const c of row) expect(c).not.toMatch(/^[=+\-@]/);
    // 줄바꿈을 넣어도 표지 줄 수가 늘지 않는다(머리글을 찾는 규칙이 흔들리지 않음)
    const nl = await exportAs('u-a-moon', `?q=${encodeURIComponent('a\r\n\r\n순번,x')}`);
    const split = splitAuditCsv(nl.res.body);
    expect(coverMap(split.cover).get('조건')).toBe('내용 검색: a 순번,x');
    expect(split.header[0]).toBe('순번');
  });

  it('auditCsvCover says the export was cut at the limit (limit is an argument)', () => {
    const base: AuditCsvCoverInput = {
      filters: {}, rowCount: 3, matchedCount: 3, limit: 3, exporter: { name: '문태호', roleLabels: ['감사 담당자'] }, exportedAt: '2026-10-21T00:00:00.000Z',
      chain: { ok: true, count: 10, brokenAtNo: null, headHash: 'a'.repeat(64) },
    };
    const get = (rows: string[][], k: string) => rows.find((r) => r[0] === k)?.[1];
    expect(get(auditCsvCover(base), '내보낸 행')).toBe('3건 · 조건에 맞는 기록 3건');
    expect(get(auditCsvCover({ ...base, matchedCount: 60000, rowCount: 3 }), '내보낸 행')).toBe('3건까지만 내보냈습니다 · 조건에 맞는 기록 60,000건');
    expect(get(auditCsvCover({ ...base, limit: 50000, rowCount: 50000, matchedCount: 50001 }), '내보낸 행')).toBe('50,000건까지만 내보냈습니다 · 조건에 맞는 기록 50,001건');
    expect(get(auditCsvCover(base), '내보낸 시각')).toBe('2026-10-21 09:00:00 (한국 시간)');
    // 기간이 형식에 맞지 않으면 걸지 않으므로(auditWhere와 같음) 표지도 전체 기간
    expect(get(auditCsvCover({ ...base, filters: { from: 'yesterday' } }), '기간')).toBe('전체 기간');
    expect(get(auditCsvCover({ ...base, filters: { from: '2026-09-01' } }), '기간')).toBe('2026-09-01 ~ 지금 (한국 시간 날짜)');
  });

  it('reports the first broken record by its in-org number and drops the anchor line when the chain is broken', async () => {
    // audit-chain.test.ts와 같은 방식: 테스트 DB에서 수정 금지 트리거를 지우고 기록 하나를 바꾼다.
    ctx.db.exec('DROP TRIGGER audit_no_update');
    const target = ctx.db.prepare("SELECT seq FROM audit_log WHERE org_id = 'org-a' ORDER BY seq LIMIT 1 OFFSET 4").get() as { seq: number };
    ctx.db.prepare("UPDATE audit_log SET summary = summary || ' (변조)' WHERE seq = ?").run(target.seq);
    const { res, verify } = await exportAs('u-a-moon');
    expect(verify).toMatchObject({ ok: false, brokenAtNo: 5 });
    const m = coverMap(splitAuditCsv(res.body).cover);
    expect(m.get('해시 연결 확인(조직 전체)')).toBe('5번 기록에서 해시가 맞지 않습니다. 보안 담당자에게 알리세요.');
    expect(m.has('보관용 값')).toBe(false);
    if (target.seq !== 5) expect(res.body).not.toContain(`${target.seq}번 기록`); // 전체 공용 순번은 쓰지 않는다
    const d = JSON.parse((ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'audit.exported' ORDER BY seq DESC LIMIT 1").get() as { detail: string }).detail);
    expect(d.chain).toEqual({ ok: false, count: verify.count, brokenAtNo: 5, headHash: null });
  });

  it('keeps permissions (admin and requester 403) and gives org B its own chain values', async () => {
    for (const user of ['u-a-yoon', 'u-a-han']) {
      const s = await login(ctx.app, user);
      const res = await ctx.app.inject({ method: 'GET', url: '/api/audit/export.csv', headers: { cookie: s.cookie } });
      expect(res.statusCode, user).toBe(403);
    }
    const { res, verify } = await exportAs('u-b-jo');
    const m = coverMap(splitAuditCsv(res.body).cover);
    expect(m.get('내보낸 사람')).toBe('조은비 (조직 관리자, 감사 담당자)');
    expect(m.get('해시 연결 확인(조직 전체)')).toBe(`기록 ${verify.count}건이 각각 바로 앞 기록과 끊김 없이 이어져 있습니다(해시 연결 확인).`);
    expect(m.get('보관용 값')).toBe(`기록 ${verify.count}건 · 마지막 기록 해시 ${verify.headHash}`);
    expect(verify.count).toBe((ctx.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE org_id = 'org-b'").get() as { c: number }).c - 1);
    expect(verify.headHash).not.toBe(verifyChain(ctx.db, 'org-a').headHash);
  });
});
