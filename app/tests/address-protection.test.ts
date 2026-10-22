import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, key, login, makeApp, type Session, type TestCtx } from './helpers.ts';
import { middleSegment } from '../shared/address-rules.ts';

// 주소 오염(앞·뒤만 같은 가짜 주소) 대응: 유사 주소 판정 확대, 등록 사유·확인 메모 필수, 가운데 8자리 재입력, 진행 중 요청 수.

let ctx: TestCtx;
beforeEach(async () => { ctx = await makeApp(); });
afterEach(async () => { await ctx.app.close(); ctx.db.close(); });

const tail = (addr: string) => addr.slice(-6);
const middle = (addr: string) => middleSegment(addr).text;
const flip = (c: string) => ((parseInt(c, 16) + 1) % 16).toString(16).toUpperCase();
/** 기존 EVM 모의 주소의 앞 head자·뒤 tailLen자는 그대로 두고 나머지 글자를 모두 바꾼 주소 */
function poisonOf(address: string, head: number, tailLen: number, shift = 1) {
  const body = address.replace(/^MOCK-EVM-/, '');
  const mid = [...body.slice(head, body.length - tailLen)].map((c) => { let x = c; for (let i = 0; i < shift; i++) x = flip(x); return x; }).join('');
  return `MOCK-EVM-${body.slice(0, head)}${mid}${body.slice(body.length - tailLen)}`;
}

async function addressOf(s: Session, id: string): Promise<string> {
  return (await api(ctx.app, s).get(`/api/addresses/${id}`)).body.address;
}

function createBody(address: string, extra: Record<string, unknown> = {}) {
  return {
    label: '유사 주소 테스트', counterparty: '모의 상대방', assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '',
    confirmTail: tail(address), confirmMiddle: middle(address), ackNotVerified: true, ackOutOfBandConfirmed: true, receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호', ...extra,
  };
}

const REASON = '받는 곳 재무팀에 전화로 전체 주소를 확인했습니다';

describe('유사 주소 판정 (lookalike-v2)', () => {
  it('flags head-4/tail-5 and head-4/tail-6 copies of ab-01, not 3/3, and leaves identical addresses to the duplicate check', async () => {
    const hanS = await login(ctx.app, 'u-a-han');
    const han = api(ctx.app, hanS);
    const ab01 = await addressOf(hanS, 'ab-01');
    for (const [h, t] of [[4, 5], [4, 6]] as const) {
      const r = await han.post('/api/addresses/check', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: poisonOf(ab01, h, t), memo: '' });
      expect(r.status).toBe(200);
      const f = r.body.findings.find((x: any) => x.code === 'ADDRESS_LOOKALIKE');
      expect(f, `${h}/${t}`).toBeTruthy();
      expect(f.level).toBe('warning');
      expect(f.message).toBe(`기존 주소 '모의 거래소 A 입금 (USDC)'(사용 가능)와 앞 ${h}자·뒤 ${t}자가 같지만 가운데가 다릅니다.`);
      expect(f.data.matches[0]).toMatchObject({ id: 'ab-01', label: '모의 거래소 A 입금 (USDC)', status: 'ACTIVE', address: ab01, prefix: h, suffix: t });
      expect(JSON.stringify(r.body)).not.toMatch(/안전합니다|안전한 주소|검증되었습니다/);
    }
    const three = await han.post('/api/addresses/check', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: poisonOf(ab01, 3, 3), memo: '' });
    expect(three.body.findings.map((x: any) => x.code)).not.toContain('ADDRESS_LOOKALIKE');
    const same = await han.post('/api/addresses/check', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: ab01.toLowerCase().replace('mock-evm-', 'MOCK-EVM-'), memo: '' });
    expect(same.body.findings.map((x: any) => x.code)).toEqual(expect.arrayContaining(['ADDRESS_DUPLICATE']));
    expect(same.body.findings.map((x: any) => x.code)).not.toContain('ADDRESS_LOOKALIKE');
  });

  it('also compares against DISABLED entries (ab-11)', async () => {
    const hanS = await login(ctx.app, 'u-a-han');
    const ab11 = await addressOf(hanS, 'ab-11');
    const r = await api(ctx.app, hanS).post('/api/addresses/check', { assetCode: 'ETH', networkCode: 'ETHEREUM', address: poisonOf(ab11, 4, 6), memo: '' });
    const f = r.body.findings.find((x: any) => x.code === 'ADDRESS_LOOKALIKE');
    expect(f).toBeTruthy();
    expect(f.message).toContain("'종료된 거래처 I'(사용 중지)");
    expect(f.data.matches[0]).toMatchObject({ id: 'ab-11', status: 'DISABLED' });
  });

  it('keeps at most 3 matches, strongest first', async () => {
    const hanS = await login(ctx.app, 'u-a-han');
    const han = api(ctx.app, hanS);
    const ab01 = await addressOf(hanS, 'ab-01');
    // ab-01과 앞 4·뒤 6이 같은 주소를 3개 더 등록(서로도 비슷하므로 사유가 필요)
    for (const shift of [1, 2, 3]) {
      const addr = poisonOf(ab01, 4, 6, shift);
      const cr = await han.post('/api/addresses', createBody(addr, { label: `유사 ${shift}`, lookalikeReason: REASON }));
      expect(cr.status, JSON.stringify(cr.body)).toBe(201);
    }
    const r = await han.post('/api/addresses/check', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: poisonOf(ab01, 6, 6, 4), memo: '' });
    const f = r.body.findings.find((x: any) => x.code === 'ADDRESS_LOOKALIKE');
    expect(f.data.matches).toHaveLength(3);
    expect(f.data.matches[0].id).toBe('ab-01'); // 앞 6·뒤 6으로 가장 많이 같음
    expect(f.data.matches[0].prefix + f.data.matches[0].suffix).toBe(12);
    const scores = f.data.matches.map((m: any) => m.prefix + m.suffix);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // 4건이 비슷하다(ab-01 + 등록한 3건). 메시지는 잘라내기 전 전체 건수로 '외 3건'을 말한다.
    expect(f.message).toContain('이 주소 외에 비슷한 기존 주소가 3건 더 있습니다.');
  });
});

describe('유사 주소 등록 사유', () => {
  it('requires a reason (422 REASON_REQUIRED) and stores findings and reason, returned on GET', async () => {
    const hanS = await login(ctx.app, 'u-a-han');
    const han = api(ctx.app, hanS);
    const poison = poisonOf(await addressOf(hanS, 'ab-01'), 4, 6);
    const none = await han.post('/api/addresses', createBody(poison));
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('REASON_REQUIRED');
    expect(none.body.error.fields[0].field).toBe('lookalikeReason');
    expect(none.body.error.findings.map((f: any) => f.code)).toContain('ADDRESS_LOOKALIKE');
    const short = await han.post('/api/addresses', createBody(poison, { lookalikeReason: '확인함' }));
    expect(short.body.error.code).toBe('REASON_REQUIRED');
    // 가운데가 틀리면 사유보다 먼저 가운데 재입력 오류
    const wrongMid = await han.post('/api/addresses', createBody(poison, { confirmMiddle: middle(await addressOf(hanS, 'ab-01')), lookalikeReason: REASON }));
    expect(wrongMid.body.error.code).toBe('CONFIRM_MIDDLE_MISMATCH');
    const ok = await han.post('/api/addresses', createBody(poison, { lookalikeReason: `  ${REASON}  ` }));
    expect(ok.status).toBe(201);
    const id = ok.body.address.id;
    const row = ctx.db.prepare('SELECT check_findings, lookalike_reason FROM address_book WHERE id = ?').get(id) as any;
    expect(row.lookalike_reason).toBe(REASON);
    expect(JSON.parse(row.check_findings).map((f: any) => f.code)).toContain('ADDRESS_LOOKALIKE');
    const got = (await han.get(`/api/addresses/${id}`)).body;
    expect(got.lookalikeReason).toBe(REASON);
    expect(got.middle).toEqual({ start: 17, end: 24 });
    expect(got.findings.find((f: any) => f.code === 'ADDRESS_LOOKALIKE').data.matches[0]).toMatchObject({ id: 'ab-01', prefix: 4, suffix: 6 });
    expect(got).not.toHaveProperty('middleText');
  });

  it('records ruleVersion, the matches and the reason in the create audit detail', async () => {
    const hanS = await login(ctx.app, 'u-a-han');
    const poison = poisonOf(await addressOf(hanS, 'ab-01'), 4, 5);
    const cr = await api(ctx.app, hanS).post('/api/addresses', createBody(poison, { lookalikeReason: REASON }));
    expect(cr.status).toBe(201);
    const row = ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'address.created' AND target_id = ?").get(cr.body.address.id) as any;
    const detail = JSON.parse(row.detail);
    expect(detail.ruleVersion).toBe('lookalike-v2');
    expect(detail.lookalike).toEqual([{ id: 'ab-01', label: '모의 거래소 A 입금 (USDC)', status: 'ACTIVE', prefix: 4, suffix: 5 }]);
    expect(detail.lookalikeReason).toBe(REASON);
    expect(detail.warnings).toContain('ADDRESS_LOOKALIKE');
    expect(row.detail).not.toContain(poison); // 감사 기록에는 전체 주소를 남기지 않는다(끝 6자리만)
  });

  it('stores no reason and an empty look-alike list for an unrelated address', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const addr = 'MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678';
    const cr = await han.post('/api/addresses', createBody(addr, { lookalikeReason: '사유가 필요 없는 주소입니다' }));
    expect(cr.status).toBe(201);
    expect(cr.body.address.lookalikeReason).toBeNull();
    expect(cr.body.address.findings.map((f: any) => f.code)).not.toContain('ADDRESS_LOOKALIKE');
    const row = ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'address.created' AND target_id = ?").get(cr.body.address.id) as any;
    expect(JSON.parse(row.detail)).toMatchObject({ ruleVersion: 'lookalike-v2', lookalike: [], lookalikeReason: null });
  });
});

describe('확인 담당자: 유사 주소가 있으면 메모 필수', () => {
  async function registerPoison() {
    const hanS = await login(ctx.app, 'u-a-han');
    const poison = poisonOf(await addressOf(hanS, 'ab-01'), 4, 6);
    const cr = await api(ctx.app, hanS).post('/api/addresses', createBody(poison, { lookalikeReason: REASON }));
    expect(cr.status).toBe(201);
    return { id: cr.body.address.id as string, poison };
  }

  it('shows the findings to the reviewer, requires a note of 5+ characters, then activates', async () => {
    const { id, poison } = await registerPoison();
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const view = (await oh.get(`/api/addresses/${id}`)).body;
    expect(view.allowedActions).toContain('review');
    const look = view.findings.find((f: any) => f.code === 'ADDRESS_LOOKALIKE');
    expect(look.data.matches.map((m: any) => m.label)).toContain('모의 거래소 A 입금 (USDC)');
    const base = { decision: 'approve', version: view.version, confirmTail: tail(poison), confirmMiddle: middle(poison) };
    const noNote = await oh.post(`/api/addresses/${id}/review`, base);
    expect(noNote.status).toBe(422);
    expect(noNote.body.error.code).toBe('NOTE_REQUIRED');
    expect(noNote.body.error.fields[0].field).toBe('note');
    const shortNote = await oh.post(`/api/addresses/${id}/review`, { ...base, note: '확인함' });
    expect(shortNote.status).toBe(422);
    const wrongMid = await oh.post(`/api/addresses/${id}/review`, { ...base, confirmMiddle: middle(await addressOf(await login(ctx.app, 'u-a-oh'), 'ab-01')), note: '전화로 전체 주소 대조' });
    expect(wrongMid.body.error.code).toBe('CONFIRM_MIDDLE_MISMATCH');
    const ok = await oh.post(`/api/addresses/${id}/review`, { ...base, note: '거래처 담당자와 전화로 전체 주소를 대조했습니다' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('ACTIVE');
    const audit = ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'address.approved' AND target_id = ?").get(id) as any;
    const detail = JSON.parse(audit.detail);
    expect(detail.ruleVersion).toBe('lookalike-v2');
    expect(detail.findings).toContain('ADDRESS_LOOKALIKE');
    expect(detail.lookalike).toEqual([{ id: 'ab-01', label: '모의 거래소 A 입금 (USDC)', status: 'ACTIVE', prefix: 4, suffix: 6 }]);
    expect(detail.note).toBe('거래처 담당자와 전화로 전체 주소를 대조했습니다');
  });

  it('does not require a note when there is no look-alike (existing behaviour)', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const addr = 'MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678';
    const cr = await han.post('/api/addresses', createBody(addr));
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const ok = await oh.post(`/api/addresses/${cr.body.address.id}/review`, { decision: 'approve', version: 1, confirmTail: tail(addr), confirmMiddle: middle(addr) });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ACTIVE');
  });

  it('re-checks at approval: a look-alike registered after this address refreshes the findings and asks the reviewer to look again', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const first = 'MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678';
    const a = await han.post('/api/addresses', createBody(first, { label: '먼저 등록한 주소' }));
    expect(a.body.address.findings.map((f: any) => f.code)).not.toContain('ADDRESS_LOOKALIKE');
    const later = poisonOf(first, 4, 6);
    const b = await han.post('/api/addresses', createBody(later, { label: '나중에 등록한 비슷한 주소', lookalikeReason: REASON }));
    expect(b.status).toBe(201);
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const body = { decision: 'approve', version: 1, confirmTail: tail(first), confirmMiddle: middle(first), note: '' };
    const r1 = await oh.post(`/api/addresses/${a.body.address.id}/review`, body);
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('LOOKALIKE_UPDATED');
    expect(r1.body.error.message).toContain('나중에 등록한 비슷한 주소');
    const view = (await oh.get(`/api/addresses/${a.body.address.id}`)).body;
    expect(view.status).toBe('PENDING_REVIEW');
    expect(view.version).toBe(2);
    expect(view.findings.find((f: any) => f.code === 'ADDRESS_LOOKALIKE').data.matches[0].id).toBe(b.body.address.id);
    expect(view.findings.map((f: any) => f.code)).toContain('NOT_OWNERSHIP_VERIFIED'); // 기존 점검 결과는 유지
    const r2 = await oh.post(`/api/addresses/${a.body.address.id}/review`, { ...body, version: 2 });
    expect(r2.body.error.code).toBe('NOTE_REQUIRED');
    const r3 = await oh.post(`/api/addresses/${a.body.address.id}/review`, { ...body, version: 2, note: '두 주소를 거래처와 전화로 각각 대조했습니다' });
    expect(r3.status).toBe(200);
    expect(r3.body.status).toBe('ACTIVE');
  });

  it('still allows rejection with a reason without tail or middle input', async () => {
    const { id } = await registerPoison();
    const oh = api(ctx.app, await login(ctx.app, 'u-a-oh'));
    const r = await oh.post(`/api/addresses/${id}/review`, { decision: 'reject', version: 1, note: '거래처가 이 주소를 보낸 적이 없다고 했습니다' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('REJECTED');
    const audit = ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'address.rejected' AND target_id = ?").get(id) as any;
    expect(JSON.parse(audit.detail)).toMatchObject({ reason: '거래처가 이 주소를 보낸 적이 없다고 했습니다', ruleVersion: 'lookalike-v2', findings: expect.arrayContaining(['ADDRESS_LOOKALIKE']) });
  });
});

describe('진행 중 요청 수 (사용 중지 확인용)', () => {
  it('counts DRAFT/REVIEW/PENDING_APPROVAL requests that use the address', async () => {
    const hanS = await login(ctx.app, 'u-a-han');
    const han = api(ctx.app, hanS);
    const count = async (id: string) => (await han.get(`/api/addresses/${id}`)).body.openRequestCount;
    expect(await count('ab-01')).toBe(0); // wr-1은 처리 완료
    expect(await count('ab-02')).toBe(1); // wr-3 승인 대기
    expect(await count('ab-04')).toBe(1); // wr-5 검토 중
    expect(await count('ab-06')).toBe(1); // wr-6 작성 중
    expect(await count('ab-05')).toBe(0); // wr-2 반려
    const d = await han.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '1', purpose: '진행 중 요청 수 확인' }, { 'idempotency-key': key() });
    expect(d.status).toBe(201);
    expect(await count('ab-01')).toBe(1);
    const rv = await han.post(`/api/requests/${d.body.id}/review`, { version: d.body.version });
    expect(await count('ab-01')).toBe(1);
    await han.post(`/api/requests/${d.body.id}/cancel`, { version: rv.body.version });
    expect(await count('ab-01')).toBe(0);
    const list = (await han.get('/api/addresses')).body.items;
    expect(list.find((x: any) => x.id === 'ab-02').openRequestCount).toBe(1);
  });
});

describe('XRPL 데스티네이션 태그 (화면·서버 같은 규칙)', () => {
  it('rejects 4294967296 and accepts 4294967295 on the server', async () => {
    const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
    const address = 'MOCK-XRP-ABCDEFGHJKLMNPQRSTUV';
    const over = await han.post('/api/addresses/check', { assetCode: 'XRP', networkCode: 'XRPL', address, memo: '4294967296' });
    expect(over.body.findings.map((f: any) => f.code)).toContain('MEMO_FORMAT');
    const max = await han.post('/api/addresses/check', { assetCode: 'XRP', networkCode: 'XRPL', address, memo: '4294967295' });
    expect(max.body.findings.map((f: any) => f.code)).not.toContain('MEMO_FORMAT');
    const cr = await han.post('/api/addresses', { ...createBody(address, { assetCode: 'XRP', networkCode: 'XRPL', memo: '4294967296' }) });
    expect(cr.status).toBe(422);
    expect(cr.body.error.code).toBe('MEMO_FORMAT');
  });
});
