import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { api, key, login, makeApp, type Session, type TestCtx } from './helpers.ts';
import { LOOKALIKE_MAX_MATCHES, lookalikeMatch, middleSegment, type LookalikeFindingMatch } from '../shared/address-rules.ts';
import { addressCreateSchema, brokenTextMessage, insightCreateSchema, isWellFormedText } from '../shared/schemas.ts';
import { lookalikeFinding } from '../server/domain/addresses.ts';
import { verifyChain } from '../server/audit.ts';

// 1차 검토 후속(WP-09): 유사 주소 '외 N건' 건수, 확인 시 점검 결과 갱신의 감사 기록, 깨진 문자(짝 없는 서로게이트) 입력 거절.

let ctx: TestCtx;
beforeEach(async () => { ctx = await makeApp(); });
afterEach(async () => { await ctx.app.close(); ctx.db.close(); });

const tail = (addr: string) => addr.slice(-6);
const middle = (addr: string) => middleSegment(addr).text;
const flip = (c: string) => ((parseInt(c, 16) + 1) % 16).toString(16).toUpperCase();
/** 기존 EVM 모의 주소의 앞 head자·뒤 tailLen자는 그대로 두고 나머지 글자를 shift만큼 바꾼 주소 */
function poisonOf(address: string, head: number, tailLen: number, shift = 1) {
  const body = address.replace(/^MOCK-EVM-/, '');
  const mid = [...body.slice(head, body.length - tailLen)].map((c) => { let x = c; for (let i = 0; i < shift; i++) x = flip(x); return x; }).join('');
  return `MOCK-EVM-${body.slice(0, head)}${mid}${body.slice(body.length - tailLen)}`;
}

function createBody(address: string, extra: Record<string, unknown> = {}) {
  return {
    label: '후속 점검 주소', counterparty: '모의 상대방', assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '',
    confirmTail: tail(address), confirmMiddle: middle(address), ackNotVerified: true, ackOutOfBandConfirmed: true, receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호', ...extra,
  };
}

const REASON = '받는 곳 재무팀에 전화로 전체 주소를 확인했습니다';
const LOOKALIKE_NOTE = '거래처 담당자와 전화로 전체 주소를 각각 대조했습니다';

async function addressOf(s: Session, id: string): Promise<string> {
  return (await api(ctx.app, s).get(`/api/addresses/${id}`)).body.address;
}

/** 구현과 별도로 세는 기준값: 같은 조직 주소록 전체(상태와 무관)에서 유사 주소로 판정되는 행 수 */
function oracleTotal(orgId: string, address: string, excludeId?: string): number {
  const rows = ctx.db.prepare('SELECT id, address FROM address_book WHERE org_id = ?').all(orgId) as { id: string; address: string }[];
  return rows.filter((r) => r.id !== excludeId && lookalikeMatch(r.address, address)).length;
}

const auditCount = (orgId: string) => (ctx.db.prepare('SELECT COUNT(*) c FROM audit_log WHERE org_id = ?').get(orgId) as { c: number }).c;

describe("유사 주소 경고: '외 N건'은 자르기 전 전체 건수로 센다", () => {
  it('says the real number of other look-alikes when there are 4 or more, and keeps data.matches at 3', async () => {
    const hanS = await login(ctx.app, 'u-a-han');
    const han = api(ctx.app, hanS);
    const ab01 = await addressOf(hanS, 'ab-01');
    // ab-01과 앞 4·뒤 6이 같은 주소를 5개 더 등록한다(서로도 비슷하므로 사유가 필요).
    for (const shift of [1, 2, 3, 4, 5]) {
      const cr = await han.post('/api/addresses', createBody(poisonOf(ab01, 4, 6, shift), { label: `유사 ${shift}`, lookalikeReason: REASON }));
      expect(cr.status, JSON.stringify(cr.body)).toBe(201);
    }
    const probe = poisonOf(ab01, 6, 6, 6);
    const total = oracleTotal('org-a', probe);
    expect(total).toBeGreaterThanOrEqual(6); // ab-01 + 방금 등록한 5건
    const r = await han.post('/api/addresses/check', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: probe, memo: '' });
    expect(r.status).toBe(200);
    const f = r.body.findings.find((x: any) => x.code === 'ADDRESS_LOOKALIKE');
    expect(f.data.matches).toHaveLength(LOOKALIKE_MAX_MATCHES);
    expect(f.data.matches[0].id).toBe('ab-01');
    expect(f.message).toBe(
      `기존 주소 '모의 거래소 A 입금 (USDC)'(사용 가능)와 앞 6자·뒤 6자가 같지만 가운데가 다릅니다. 이 주소 외에 비슷한 기존 주소가 ${total - 1}건 더 있습니다. 글자 비교는 가장 비슷한 3건까지 보여 줍니다.`,
    );
    expect(f.message).not.toContain('2건 더');
  });

  it('stores the accurate count in the findings saved at registration', async () => {
    const hanS = await login(ctx.app, 'u-a-han');
    const han = api(ctx.app, hanS);
    const ab01 = await addressOf(hanS, 'ab-01');
    for (const shift of [1, 2, 3]) {
      expect((await han.post('/api/addresses', createBody(poisonOf(ab01, 4, 6, shift), { label: `유사 ${shift}`, lookalikeReason: REASON }))).status).toBe(201);
    }
    const addr = poisonOf(ab01, 4, 6, 4);
    const total = oracleTotal('org-a', addr);
    expect(total).toBeGreaterThanOrEqual(4);
    const cr = await han.post('/api/addresses', createBody(addr, { label: '네 번째 유사 주소', lookalikeReason: REASON }));
    expect(cr.status).toBe(201);
    const stored = JSON.parse((ctx.db.prepare('SELECT check_findings FROM address_book WHERE id = ?').get(cr.body.address.id) as any).check_findings);
    const f = stored.find((x: any) => x.code === 'ADDRESS_LOOKALIKE');
    expect(f.data.matches).toHaveLength(3);
    expect(f.message).toContain(`이 주소 외에 비슷한 기존 주소가 ${total - 1}건 더 있습니다.`);
    expect(f.message).toContain('글자 비교는 가장 비슷한 3건까지 보여 줍니다.');
  });

  it('formats 1, 2, 3 and 7 total matches correctly (unit)', () => {
    const m = (id: string, prefix = 4, suffix = 6): LookalikeFindingMatch => ({ id, label: `주소 ${id}`, status: 'ACTIVE', address: `MOCK-EVM-${id}`, prefix, suffix });
    const one = lookalikeFinding([m('a')], 1);
    expect(one.message).toBe("기존 주소 '주소 a'(사용 가능)와 앞 4자·뒤 6자가 같지만 가운데가 다릅니다.");
    expect(lookalikeFinding([m('a'), m('b')], 2).message).toMatch(/가운데가 다릅니다\. 이 주소 외에 비슷한 기존 주소가 1건 더 있습니다\.$/);
    const three = lookalikeFinding([m('a'), m('b'), m('c')], 3);
    expect(three.message).toMatch(/2건 더 있습니다\.$/);
    expect(three.message).not.toContain('글자 비교는');
    const seven = lookalikeFinding([m('a'), m('b'), m('c')], 7);
    expect(seven.message).toMatch(/이 주소 외에 비슷한 기존 주소가 6건 더 있습니다\. 글자 비교는 가장 비슷한 3건까지 보여 줍니다\.$/);
    expect(seven.data?.matches).toHaveLength(3);
    // total이 목록보다 작게 들어와도 목록 수보다 적게 말하지 않는다.
    expect(lookalikeFinding([m('a'), m('b')], 0).message).toContain('1건 더 있습니다.');
    expect(JSON.stringify([one, three, seven])).not.toMatch(/안전합니다|안전한 주소|검증되었습니다/);
  });
});

describe('확인 시 점검 결과 갱신(409 LOOKALIKE_UPDATED)은 감사 기록을 남긴다', () => {
  /** 먼저 등록한 주소 A 뒤에 A와 비슷한 주소 count개를 등록한다. */
  async function setup(count: number) {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const first = 'MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678';
    const a = await han.post('/api/addresses', createBody(first, { label: '먼저 등록한 주소' }));
    expect(a.status).toBe(201);
    expect(a.body.address.findings.map((f: any) => f.code)).not.toContain('ADDRESS_LOOKALIKE');
    const later: { id: string; label: string; address: string }[] = [];
    for (let i = 1; i <= count; i++) {
      const address = poisonOf(first, 4, 6, i);
      const label = `나중에 등록한 비슷한 주소 ${i}`;
      const b = await han.post('/api/addresses', createBody(address, { label, lookalikeReason: REASON }));
      expect(b.status, JSON.stringify(b.body)).toBe(201);
      later.push({ id: b.body.address.id, label, address });
    }
    return { id: a.body.address.id as string, first, later };
  }

  it('writes address.findings_updated with the new matches in the same commit, and the 409 says the screen shows the update', async () => {
    const { id, first, later } = await setup(4);
    const ohS = await login(ctx.app, 'u-a-oh');
    const oh = api(ctx.app, ohS);
    const before = auditCount('org-a');
    const body = { decision: 'approve', version: 1, confirmTail: tail(first), confirmMiddle: middle(first), note: '' };
    const r1 = await oh.post(`/api/addresses/${id}/review`, body);
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('LOOKALIKE_UPDATED');
    expect(r1.body.error.action).not.toContain('새로 고쳐');
    expect(r1.body.error.action).toContain('화면에 다시 표시됩니다');
    expect(r1.body.error.action).not.toMatch(/서버/);

    // 감사 기록 1건 추가(로그인 기록은 위 before 이전에 남았다)
    expect(auditCount('org-a')).toBe(before + 1);
    const rows = ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'address.findings_updated' AND target_id = ?").all(id) as any[];
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.org_id).toBe('org-a');
    expect(row.actor_id).toBe('u-a-oh');
    expect(row.actor_name).toBe('오민재');
    expect(row.target_type).toBe('address');
    expect(row.summary).toBe('주소 점검 결과 갱신: 먼저 등록한 주소 (비슷한 주소 3건 새로 확인, 확인 보류)');

    const view = (await oh.get(`/api/addresses/${id}`)).body;
    expect(view.version).toBe(2);
    expect(view.status).toBe('PENDING_REVIEW');
    const shown = view.findings.find((f: any) => f.code === 'ADDRESS_LOOKALIKE');
    expect(shown.data.matches).toHaveLength(3);
    const total = oracleTotal('org-a', first, id);
    expect(total).toBe(4);
    expect(shown.message).toContain(`이 주소 외에 비슷한 기존 주소가 ${total - 1}건 더 있습니다.`);

    // 감사 상세: 새로 찾은 유사 주소, 갱신 후 보여 줄 목록, 전체 건수. 화면에 보인 목록과 같다. 전체 주소는 남기지 않는다.
    const detail = JSON.parse(row.detail);
    const asAudit = (ms: any[]) => ms.map((m) => ({ id: m.id, label: m.label, status: m.status, prefix: m.prefix, suffix: m.suffix }));
    expect(detail.ruleVersion).toBe('lookalike-v2');
    expect(detail.attempted).toBe('approve');
    expect(detail.previous).toEqual([]);
    expect(detail.added).toEqual(asAudit(shown.data.matches));
    expect(detail.lookalike).toEqual(asAudit(shown.data.matches));
    expect(detail.lookalikeTotal).toBe(total);
    expect(detail.findings).toEqual(view.findings.map((f: any) => f.code));
    expect(detail.version).toBe(2);
    for (const m of detail.added) expect(later.map((l) => l.id)).toContain(m.id);
    for (const l of later) expect(row.detail).not.toContain(l.address);
    expect(row.detail).not.toContain(first);

    // 주소 변경 이력에도 보이고, 체인은 그대로 맞다.
    expect(view.history.map((h: any) => h.summary)).toContain(row.summary);
    expect(verifyChain(ctx.db, 'org-a').ok).toBe(true);

    // 갱신된 결과를 본 뒤 메모를 남기면 확인된다. 새 유사 주소가 없으면 갱신 기록을 더 남기지 않는다.
    const r2 = await oh.post(`/api/addresses/${id}/review`, { ...body, version: 2 });
    expect(r2.body.error.code).toBe('NOTE_REQUIRED');
    const r3 = await oh.post(`/api/addresses/${id}/review`, { ...body, version: 2, note: LOOKALIKE_NOTE });
    expect(r3.status, JSON.stringify(r3.body)).toBe(200);
    expect(r3.body.status).toBe('ACTIVE');
    expect((ctx.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'address.findings_updated' AND target_id = ?").get(id) as any).c).toBe(1);
    const approved = JSON.parse((ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'address.approved' AND target_id = ?").get(id) as any).detail);
    expect(approved.lookalike).toEqual(detail.lookalike);
  });

  it('records the previously shown list and only the newly added match when the top 3 changes', async () => {
    const hanS = await login(ctx.app, 'u-a-han');
    const han = api(ctx.app, hanS);
    const ab01 = await addressOf(hanS, 'ab-01');
    // ab-01과 앞 4·뒤 6이 같은 주소 X를 등록(유사 주소 1건: ab-01)
    const x = poisonOf(ab01, 4, 6, 1);
    const cx = await han.post('/api/addresses', createBody(x, { label: '확인 대기 주소 X', lookalikeReason: REASON }));
    expect(cx.status).toBe(201);
    // X와 앞 6·뒤 6이 같은 주소 Y를 나중에 등록 → X 기준으로 새 유사 주소
    const y = poisonOf(x, 6, 6, 1);
    const cy = await han.post('/api/addresses', createBody(y, { label: '나중에 등록한 주소 Y', lookalikeReason: REASON }));
    expect(cy.status).toBe(201);
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const r = await oh.post(`/api/addresses/${cx.body.address.id}/review`, { decision: 'approve', version: 1, confirmTail: tail(x), confirmMiddle: middle(x), note: LOOKALIKE_NOTE });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('LOOKALIKE_UPDATED');
    expect(r.body.error.message).toContain('나중에 등록한 주소 Y');
    const detail = JSON.parse((ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'address.findings_updated' AND target_id = ?").get(cx.body.address.id) as any).detail);
    expect(detail.previous.map((m: any) => m.id)).toEqual(['ab-01']);
    expect(detail.added.map((m: any) => m.id)).toEqual([cy.body.address.id]);
    expect(detail.lookalike.map((m: any) => m.id)).toEqual(expect.arrayContaining(['ab-01', cy.body.address.id]));
    expect(detail.lookalikeTotal).toBe(oracleTotal('org-a', x, cx.body.address.id));
  });

  it('rolls the findings update back if the audit record cannot be written (same transaction)', async () => {
    const { id, first } = await setup(1);
    const beforeRow = ctx.db.prepare('SELECT check_findings, version FROM address_book WHERE id = ?').get(id) as any;
    ctx.db.exec("CREATE TEMP TRIGGER fail_findings_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'address.findings_updated' BEGIN SELECT RAISE(ABORT, 'audit write failed (test)'); END;");
    try {
      const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
      const r = await oh.post(`/api/addresses/${id}/review`, { decision: 'approve', version: 1, confirmTail: tail(first), confirmMiddle: middle(first), note: '' });
      expect(r.status).toBeGreaterThanOrEqual(500);
      const afterRow = ctx.db.prepare('SELECT check_findings, version, status FROM address_book WHERE id = ?').get(id) as any;
      expect(afterRow.version).toBe(beforeRow.version);
      expect(afterRow.check_findings).toBe(beforeRow.check_findings);
      expect(afterRow.status).toBe('PENDING_REVIEW');
    } finally {
      ctx.db.exec('DROP TRIGGER IF EXISTS temp.fail_findings_audit');
    }
  });
});

describe('깨진 문자(짝 없는 서로게이트) 입력 거절', () => {
  const lone = ['\ud800', '\udbff', '\udc00', '\udfff'];

  it('isWellFormedText matches String.prototype.isWellFormed and the UTF-8 round trip', () => {
    for (const s of ['', 'abc', '가나다', '😀', '😀', '모의 거래처 😀 A', '\u0000\u001f']) expect(isWellFormedText(s), JSON.stringify(s)).toBe(true);
    for (const s of [...lone, 'a\ud800b', '\ude00\ud83d', '😀\ud83d', '\ud83d😀', '\ude00😀']) expect(isWellFormedText(s), JSON.stringify(s)).toBe(false);
    const unit = fc.oneof(
      fc.integer({ min: 0xd800, max: 0xdfff }).map((c) => String.fromCharCode(c)),
      fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)),
      fc.constantFrom('가', '😀', ' '),
    );
    fc.assert(fc.property(fc.string({ unit, maxLength: 24 }), (s) => {
      const native = (s as unknown as { isWellFormed?: () => boolean }).isWellFormed;
      if (typeof native === 'function') expect(isWellFormedText(s)).toBe(native.call(s));
      expect(isWellFormedText(s)).toBe(Buffer.from(s, 'utf8').toString('utf8') === s);
    }), { numRuns: 500 });
  });

  it('schema: a label is rejected for broken text exactly when it is ill-formed; trimming and length rules are unchanged', () => {
    const base = createBody('MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678');
    const unit = fc.oneof(
      fc.integer({ min: 0xd800, max: 0xdfff }).map((c) => String.fromCharCode(c)),
      fc.constantFrom('가', '나', 'A', '😀', ' ', '-'),
    );
    fc.assert(fc.property(fc.string({ unit, minLength: 1, maxLength: 20 }), (label) => {
      const r = addressCreateSchema.safeParse({ ...base, label });
      const broken = r.success ? false : r.error.issues.some((i) => i.path.join('.') === 'label' && i.message === brokenTextMessage('주소 이름'));
      expect(broken).toBe(!isWellFormedText(label.trim()));
    }), { numRuns: 300 });
    const ok = addressCreateSchema.parse({ ...base, label: '  모의 거래처 😀  ' });
    expect(ok.label).toBe('모의 거래처 😀');
    const long = addressCreateSchema.safeParse({ ...base, label: '가'.repeat(61) });
    expect(long.success).toBe(false);
    expect(long.error!.issues[0]!.message).toBe('주소 이름은(는) 60자 이내로 입력하세요.');
    const empty = addressCreateSchema.safeParse({ ...base, label: '   ' });
    expect(empty.error!.issues[0]!.message).toBe('주소 이름을(를) 입력하세요.');
    const insight = { providerId: 'prov-a', title: '제목', summary: '요약', language: 'ko', publishedAt: '2026-10-19', url: 'https://example.com/x' };
    expect(insightCreateSchema.safeParse({ ...insight, title: '모의 자료\udc00' }).error!.issues.map((i) => i.path.join('.'))).toEqual(['title']);
    expect(insightCreateSchema.safeParse({ ...insight, assetTags: ['BTC', 'E\ud800'] }).error!.issues.map((i) => i.path.join('.'))).toEqual(['assetTags.1']);
  });

  it('POST /api/addresses: 422 with a Korean field error for a lone surrogate in label, counterparty or reason; nothing is stored or audited', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const address = 'MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678';
    const addrCount = () => (ctx.db.prepare('SELECT COUNT(*) c FROM address_book').get() as { c: number }).c;
    const books = addrCount();
    const audits = auditCount('org-a');
    const cases: [Record<string, unknown>, string, string][] = [
      ...lone.map((ch): [Record<string, unknown>, string, string] => [{ label: `거래처${ch}` }, 'label', '주소 이름']),
      [{ counterparty: '모의 상대방\udc00' }, 'counterparty', '받는 곳'],
      [{ lookalikeReason: `${REASON}\ud800` }, 'lookalikeReason', '등록 사유'],
      [{ memo: '\ud800' }, 'memo', '메모'],
    ];
    for (const [over, field, label] of cases) {
      const r = await han.post('/api/addresses', createBody(address, over));
      expect(r.status, JSON.stringify(over)).toBe(422);
      expect(r.body.error.code).toBe('VALIDATION');
      expect(r.body.error.fields).toContainEqual({ field, message: brokenTextMessage(label) });
      expect(r.body.error.message).toBe(brokenTextMessage(label));
      expect(r.body.error.message).not.toMatch(/서버|surrogate|UTF/i);
    }
    expect(addrCount()).toBe(books);
    expect(auditCount('org-a')).toBe(audits);
    // /check도 같은 규칙(메모)
    const chk = await han.post('/api/addresses/check', { assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: 'x\udfff' });
    expect(chk.status).toBe(422);
    expect(chk.body.error.fields).toContainEqual({ field: 'memo', message: brokenTextMessage('메모') });
  });

  it('still accepts well-formed Korean text (with an emoji pair) and stores it unchanged', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const address = 'MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678';
    const label = '모의 거래처 한글 이름 😀';
    const counterparty = '모의 상대방 (주) — 정산팀';
    const cr = await han.post('/api/addresses', createBody(address, { label: `  ${label}  `, counterparty }));
    expect(cr.status, JSON.stringify(cr.body)).toBe(201);
    const row = ctx.db.prepare('SELECT label, counterparty FROM address_book WHERE id = ?').get(cr.body.address.id) as any;
    expect(row.label).toBe(label);
    expect(row.counterparty).toBe(counterparty);
    const audit = ctx.db.prepare("SELECT summary FROM audit_log WHERE action = 'address.created' AND target_id = ?").get(cr.body.address.id) as any;
    expect(audit.summary).toBe(`주소 등록 요청: ${label} (USDC/ETHEREUM)`);
    expect(audit.summary).not.toContain('�');

    const op = api(ctx.app, await login(ctx.app, 'u-k-op'));
    const title = '모의 자료: 원화 스테이블코인 동향 😀';
    const ins = await op.post('/api/insights', { title, summary: '요약입니다', language: 'ko', publishedAt: '2026-10-19', url: 'https://example.com/x', providerId: 'prov-a', assetTags: ['USDC'] });
    expect(ins.status, JSON.stringify(ins.body)).toBe(201);
    expect((ctx.db.prepare('SELECT title FROM insights WHERE id = ?').get(ins.body.id) as any).title).toBe(title);
  });

  it('address review note: 422 field note for approve and reject; the address stays pending', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const address = 'MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678';
    const cr = await han.post('/api/addresses', createBody(address));
    const id = cr.body.address.id;
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    for (const decision of ['approve', 'reject']) {
      const r = await oh.post(`/api/addresses/${id}/review`, { decision, version: 1, confirmTail: tail(address), confirmMiddle: middle(address), note: `전화로 확인했습니다\ud800` });
      expect(r.status).toBe(422);
      expect(r.body.error.fields).toContainEqual({ field: 'note', message: brokenTextMessage('메모') });
    }
    const row = ctx.db.prepare('SELECT status, version, review_note FROM address_book WHERE id = ?').get(id) as any;
    expect(row).toEqual({ status: 'PENDING_REVIEW', version: 1, review_note: null });
  });

  it('requests: 422 for a lone surrogate in purpose (create and edit) and in the reject reason', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const draft = { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '1', purpose: '깨진 문자 확인\udc00' };
    const c = await han.post('/api/requests', draft, { 'idempotency-key': key() });
    expect(c.status).toBe(422);
    expect(c.body.error.fields).toContainEqual({ field: 'purpose', message: brokenTextMessage('요청 목적') });
    const wr6 = (await han.get('/api/requests/wr-6')).body;
    const u = await han.put('/api/requests/wr-6', { ...draft, assetCode: 'KAIA', networkCode: 'KAIA', addressId: 'ab-06', version: wr6.version });
    expect(u.status).toBe(422);
    expect(u.body.error.fields).toContainEqual({ field: 'purpose', message: brokenTextMessage('요청 목적') });

    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const wr3 = (await oh.get('/api/requests/wr-3')).body;
    const rj = await oh.post('/api/requests/wr-3/reject', { version: wr3.version, reason: '수량이 정산서와 다릅니다\ud800' });
    expect(rj.status).toBe(422);
    expect(rj.body.error.fields).toContainEqual({ field: 'reason', message: brokenTextMessage('반려 사유') });
    expect((await oh.get('/api/requests/wr-3')).body.status).toBe('PENDING_APPROVAL');
  });

  it('insights: 422 for a lone surrogate in title, summary, url or a tag; nothing is published', async () => {
    const op = api(ctx.app, await login(ctx.app, 'u-k-op'));
    const count = () => (ctx.db.prepare('SELECT COUNT(*) c FROM insights').get() as { c: number }).c;
    const before = count();
    const base = { title: '모의 자료', summary: '요약', language: 'ko', publishedAt: '2026-10-19', url: 'https://example.com/x', providerId: 'prov-a' };
    const cases: [Record<string, unknown>, string, string][] = [
      [{ title: '모의 자료\udc00' }, 'title', '제목'],
      [{ title: '\ud800' }, 'title', '제목'],
      [{ summary: '요약\ud800' }, 'summary', '요약'],
      [{ url: 'https://example.com/\ud800' }, 'url', '원문 주소(URL)'],
      [{ assetTags: ['USDC\udfff'] }, 'assetTags.0', '자산 태그'],
    ];
    for (const [over, field, label] of cases) {
      const r = await op.post('/api/insights', { ...base, ...over });
      expect(r.status, JSON.stringify(over)).toBe(422);
      expect(r.body.error.fields).toContainEqual({ field, message: brokenTextMessage(label) });
    }
    expect(count()).toBe(before);
  });

  it('no lone surrogate reaches an audit summary or a business table through these routes; every chain still verifies', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const op = api(ctx.app, await login(ctx.app, 'u-k-op'));
    const address = 'MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678';
    // 1차 구현의 audit-chain 테스트가 쓰던 입력 그대로
    const a = await han.post('/api/addresses', createBody(address, { label: '거래처\ud800', counterparty: '테스트 상대방' }));
    const b = await op.post('/api/insights', { title: '모의 자료\udc00', summary: '요약', language: 'ko', publishedAt: '2026-10-19', url: 'https://example.com/x', providerId: 'prov-a' });
    expect([a.status, b.status]).toEqual([422, 422]);
    const fffd = '%�%';
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM audit_log WHERE summary LIKE ? OR actor_name LIKE ? OR target_id LIKE ?').get(fffd, fffd, fffd) as any).c).toBe(0);
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM address_book WHERE label LIKE ? OR counterparty LIKE ? OR memo LIKE ? OR IFNULL(lookalike_reason, \'\') LIKE ? OR IFNULL(review_note, \'\') LIKE ?').get(fffd, fffd, fffd, fffd, fffd) as any).c).toBe(0);
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM insights WHERE title LIKE ? OR summary LIKE ? OR url LIKE ? OR asset_tags LIKE ?').get(fffd, fffd, fffd, fffd) as any).c).toBe(0);
    const orgs = ctx.db.prepare('SELECT DISTINCT org_id FROM audit_log').all() as { org_id: string }[];
    for (const { org_id } of orgs) expect(verifyChain(ctx.db, org_id).ok, org_id).toBe(true);
  });
});
