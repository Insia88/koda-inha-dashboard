import { afterEach, describe, expect, it } from 'vitest';
import { api, login, makeApp, type TestCtx } from './helpers.ts';
import { middleSegment } from '../shared/address-rules.ts';
import { addressCreateSchema, addressReviewSchema, addressStopSchema, cleanText, reasonError, requestDraftSchema, requestRejectSchema } from '../shared/schemas.ts';
import { stopReasonError } from '../src/pages/AddressDetail.tsx';

// 주소 오염 경로의 필수 사유(유사 주소 등록 사유, 확인 메모, 거절 사유, 사용 대기 중 정지 사유)와 출금 요청 반려 사유:
// 보이지 않는 서식 문자(폭 없는 공백 U+200B, 방향 제어 문자 U+202E 등 \p{Cf})를 지운 값으로 세고 저장하며,
// 문장부호·공백만으로는 채울 수 없다(글자·숫자 5자 이상). 출금 전 점검의 진행 사유(checks.ts)와 같은 기준이다.

const ZW5 = '​'.repeat(5); // 폭 없는 공백 다섯 개: 화면에는 아무것도 보이지 않는다
const DOTS = '.....';
const PUNCT = '- . , !'; // 문장부호·공백만
const RLO = '‮'; // 오른쪽에서 왼쪽으로 뒤집어 보이게 하는 방향 제어 문자
const GOOD = '거래처 재무팀 대표번호로 전화해 전체 주소를 확인했습니다';

const ctxs: TestCtx[] = [];
afterEach(async () => {
  while (ctxs.length) { const c = ctxs.pop()!; await c.app.close(); c.db.close(); }
});
async function app(opts: Parameters<typeof makeApp>[0] = {}) {
  const c = await makeApp(opts);
  ctxs.push(c);
  return c;
}

const tail = (a: string) => a.slice(-6);
const middle = (a: string) => middleSegment(a).text;
const flip = (c: string) => ((parseInt(c, 16) + 1) % 16).toString(16).toUpperCase();
/** 기존 EVM 모의 주소의 앞 4자·뒤 6자는 그대로 두고 가운데를 바꾼 유사 주소 */
function lookalikeOf(address: string, shift = 1) {
  const body = address.replace(/^MOCK-EVM-/, '');
  const mid = [...body.slice(4, body.length - 6)].map((c) => { let x = c; for (let i = 0; i < shift; i++) x = flip(x); return x; }).join('');
  return `MOCK-EVM-${body.slice(0, 4)}${mid}${body.slice(-6)}`;
}
function createBody(address: string, extra: Record<string, unknown> = {}) {
  return {
    label: '사유 점검 주소', counterparty: '모의 상대방', assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '',
    confirmTail: tail(address), confirmMiddle: middle(address), ackNotVerified: true, ackOutOfBandConfirmed: true,
    receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호', ...extra,
  };
}
const auditCount = (c: TestCtx) => (c.db.prepare('SELECT COUNT(*) c FROM audit_log').get() as { c: number }).c;
const hasCf = (s: string) => /\p{Cf}/u.test(s);

describe('shared: cleanText·reasonError', () => {
  it('strips format characters, then requires 5 characters and 5 letters or digits', () => {
    expect(cleanText(`  ${RLO}가나다​라마 `)).toBe('가나다라마');
    const opts = { label: '정지 사유', short: '정지 사유를 5자 이상 입력하세요.' };
    expect(reasonError(cleanText(ZW5), opts)).toBe('정지 사유를 5자 이상 입력하세요.');
    expect(reasonError(cleanText(DOTS), opts)).toBe('정지 사유에 글자·숫자를 5자 이상 넣어 주세요.');
    expect(reasonError(cleanText(PUNCT), opts)).toBe('정지 사유에 글자·숫자를 5자 이상 넣어 주세요.');
    expect(reasonError(cleanText('가. 나. 다. 라.'), opts)).toBe('정지 사유에 글자·숫자를 5자 이상 넣어 주세요.'); // 글자 4개
    expect(reasonError(cleanText(`${RLO}가나다라마`), opts)).toBeNull();
    expect(reasonError(cleanText('abc12'), opts)).toBeNull();
  });

  it('treats Hangul filler and blank characters (letters that render as nothing) as invisible', () => {
    const opts = { label: '정지 사유', short: '정지 사유를 5자 이상 입력하세요.' };
    for (const ch of ['ㅤ', 'ᅟ', 'ᅠ', 'ﾠ', '⠀']) {
      expect(cleanText(ch.repeat(5)), `U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`).toBe('');
      expect(reasonError(cleanText(ch.repeat(5)), opts)).toBe('정지 사유를 5자 이상 입력하세요.');
    }
    expect(cleanText('가ㅤ나ㅤ다ㅤ라ㅤ마')).toBe('가나다라마');
    expect(addressStopSchema.safeParse({ version: 1, reason: 'ㅤ'.repeat(8) }).success).toBe(false);
  });

  it('stop and reject schemas reject zero-width-only, bidi-only and punctuation-only reasons, and pass on the cleaned value', () => {
    for (const [schema, field, short] of [
      [addressStopSchema, '정지 사유', '정지 사유를 5자 이상 입력하세요.'],
      [requestRejectSchema, '반려 사유', '반려 사유를 5자 이상 입력하세요.'],
    ] as const) {
      const zw = schema.safeParse({ version: 1, reason: ZW5 });
      expect(zw.success).toBe(false);
      expect(zw.error!.issues.map((i) => i.message)).toEqual([short]);
      const bidi = schema.safeParse({ version: 1, reason: RLO.repeat(6) });
      expect(bidi.error!.issues.map((i) => i.message)).toEqual([short]);
      const dots = schema.safeParse({ version: 1, reason: DOTS });
      expect(dots.error!.issues.map((i) => i.message)).toEqual([`${field}에 글자·숫자를 5자 이상 넣어 주세요.`]);
      const ok = schema.parse({ version: 1, reason: `  ${RLO}${GOOD}​ ` });
      expect(ok.reason).toBe(GOOD);
    }
    // 길이 상한·깨진 문자 문구는 그대로다.
    expect(requestRejectSchema.safeParse({ version: 1, reason: '가'.repeat(501) }).error!.issues[0]!.message).toBe('반려 사유는 500자 이내로 입력하세요.');
    expect(addressStopSchema.safeParse({ version: 1, reason: `정지합니다 사유\ud800` }).error!.issues.map((i) => i.message)).toEqual(['정지 사유에 깨진 문자(잘린 이모지 등)가 들어 있습니다. 그 부분을 지우고 다시 입력하세요.']);
  });

  it('address and request text fields drop format characters; a name made only of them is empty', () => {
    const base = createBody('MOCK-EVM-1234567890ABCDEF1234567890ABCDEF12345678');
    const parsed = addressCreateSchema.parse({ ...base, label: `${RLO}모의 거래처​`, counterparty: `모의⁦ 상대방`, verifiedWith: `﻿재무팀 대표번호`, lookalikeReason: ` ${RLO}${GOOD} ` });
    expect(parsed).toMatchObject({ label: '모의 거래처', counterparty: '모의 상대방', verifiedWith: '재무팀 대표번호', lookalikeReason: GOOD });
    expect(addressCreateSchema.safeParse({ ...base, label: ZW5 }).error!.issues[0]!.message).toBe('주소 이름을(를) 입력하세요.');
    expect(requestDraftSchema.parse({ assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '1', purpose: `${RLO}정산 대금` }).purpose).toBe('정산 대금');
    expect(addressReviewSchema.parse({ decision: 'approve', version: 1, note: ` ${ZW5} ` }).note).toBe('');
  });

  it('the address detail screen checks the stop reason with the same rule before opening the dialog', () => {
    expect(stopReasonError('')).toBe('정지 사유를 5자 이상 입력하세요.');
    expect(stopReasonError(ZW5)).toBe('정지 사유를 5자 이상 입력하세요.');
    expect(stopReasonError(DOTS)).toBe('정지 사유에 글자·숫자를 5자 이상 넣어 주세요.');
    expect(stopReasonError(`${RLO}요청하지 않은 등록`)).toBeUndefined();
    // 한글 채움 문자·점자 빈칸은 글자로 분류되지만 화면에 보이지 않는다. 화면 점검도 서버처럼 지운 뒤 센다(비어 보이는 사유로 정지 확인 대화상자를 열지 않는다).
    expect(stopReasonError('ㅤ'.repeat(5))).toBe('정지 사유를 5자 이상 입력하세요.');
    expect(stopReasonError('⠀'.repeat(6))).toBe('정지 사유를 5자 이상 입력하세요.');
    expect(stopReasonError(`가나${'ᅠ'.repeat(4)}다`)).toBe('정지 사유를 5자 이상 입력하세요.');
    expect(stopReasonError('가ㅤ나ㅤ다ㅤ라ㅤ마')).toBeUndefined();
  });

  it('the screen stop-reason check accepts exactly what the server stop schema accepts, with the same message', () => {
    const samples = [
      '', ' ', ZW5, DOTS, PUNCT, RLO.repeat(6), '가. 나. 다. 라.', `${RLO}요청하지 않은 등록`, GOOD, 'abc12', '12345', '가나다라',
      'ㅤ'.repeat(5), 'ᅟ'.repeat(5), 'ᅠ'.repeat(5), 'ﾠ'.repeat(5), '⠀'.repeat(6), `ㅤ${'.'.repeat(6)}`, '가ㅤ나ㅤ다ㅤ라ㅤ마', `  ${'⠀'.repeat(3)}가나다라마${'​'.repeat(2)}  `,
    ];
    for (const s of samples) {
      const server = addressStopSchema.safeParse({ version: 1, reason: s });
      const screen = stopReasonError(s);
      expect(screen === undefined, JSON.stringify(s)).toBe(server.success);
      if (!server.success) expect([screen], JSON.stringify(s)).toEqual(server.error.issues.map((i) => i.message));
    }
  });
});

describe('유사 주소 등록 사유(POST /api/addresses)', () => {
  it('refuses zero-width, bidi-only and punctuation-only reasons for a look-alike (422 REASON_REQUIRED, nothing stored)', async () => {
    const c = await app();
    const han = api(c.app, await login(c.app, 'u-a-han'));
    const ab01 = (await han.get('/api/addresses/ab-01')).body.address as string;
    const look = lookalikeOf(ab01);
    const books = (c.db.prepare('SELECT COUNT(*) c FROM address_book').get() as { c: number }).c;
    const audits = auditCount(c);
    const cases: [string, string][] = [
      [ZW5, '등록 사유를 5자 이상 입력하세요.'],
      [RLO.repeat(8), '등록 사유를 5자 이상 입력하세요.'],
      [DOTS, '등록 사유에 글자·숫자를 5자 이상 넣어 주세요.'],
      [PUNCT, '등록 사유에 글자·숫자를 5자 이상 넣어 주세요.'],
    ];
    for (const [reason, message] of cases) {
      const r = await han.post('/api/addresses', createBody(look, { lookalikeReason: reason }));
      expect(r.status, JSON.stringify(reason)).toBe(422);
      expect(r.body.error.code).toBe('REASON_REQUIRED');
      expect(r.body.error.fields).toEqual([{ field: 'lookalikeReason', message }]);
      expect(r.body.error.action).toContain('글자·숫자 5자 이상');
    }
    expect((c.db.prepare('SELECT COUNT(*) c FROM address_book').get() as { c: number }).c).toBe(books);
    expect(auditCount(c)).toBe(audits);
  });

  it('stores and audits the reason, label, counterparty and contact without the bidi override or zero-width characters', async () => {
    const c = await app();
    const han = api(c.app, await login(c.app, 'u-a-han'));
    const ab01 = (await han.get('/api/addresses/ab-01')).body.address as string;
    const r = await han.post('/api/addresses', createBody(lookalikeOf(ab01), {
      lookalikeReason: `${RLO}${GOOD}​`, label: `​사유 점검 주소${RLO}`, counterparty: `모의‍ 상대방`, verifiedWith: `${RLO}모의 상대방 재무팀 대표번호`,
    }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const row = c.db.prepare('SELECT label, counterparty, lookalike_reason, verified_with FROM address_book WHERE id = ?').get(r.body.address.id) as any;
    expect(row).toEqual({ label: '사유 점검 주소', counterparty: '모의 상대방', lookalike_reason: GOOD, verified_with: '모의 상대방 재무팀 대표번호' });
    const audit = c.db.prepare("SELECT summary, detail FROM audit_log WHERE action = 'address.created' AND target_id = ?").get(r.body.address.id) as any;
    expect(hasCf(audit.summary)).toBe(false);
    expect(JSON.parse(audit.detail).lookalikeReason).toBe(GOOD);
  });
});

describe('주소 확인 메모·거절 사유(POST /api/addresses/:id/review)', () => {
  async function pendingLookalike(c: TestCtx) {
    const han = api(c.app, await login(c.app, 'u-a-han'));
    const ab01 = (await han.get('/api/addresses/ab-01')).body.address as string;
    const address = lookalikeOf(ab01, 2);
    const r = await han.post('/api/addresses', createBody(address, { lookalikeReason: GOOD }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: r.body.address.id as string, address, version: r.body.address.version as number };
  }

  it('refuses an approval note made of zero-width, bidi or punctuation characters for a look-alike (422 NOTE_REQUIRED); the address stays pending', async () => {
    const c = await app();
    const p = await pendingLookalike(c);
    const oh = api(c.app, await login(c.app, 'u-a-oh'));
    const audits = auditCount(c);
    for (const [note, message] of [
      [ZW5, '확인한 방법을 5자 이상 입력하세요.'],
      [`${RLO}${RLO}${RLO}${RLO}${RLO}`, '확인한 방법을 5자 이상 입력하세요.'],
      [DOTS, '확인 메모에 글자·숫자를 5자 이상 넣어 주세요.'],
    ]) {
      const r = await oh.post(`/api/addresses/${p.id}/review`, { decision: 'approve', version: p.version, confirmTail: tail(p.address), confirmMiddle: middle(p.address), note });
      expect(r.status, JSON.stringify(note)).toBe(422);
      expect(r.body.error.code).toBe('NOTE_REQUIRED');
      expect(r.body.error.fields).toEqual([{ field: 'note', message }]);
    }
    expect((await oh.get(`/api/addresses/${p.id}`)).body.status).toBe('PENDING_REVIEW');
    expect(auditCount(c)).toBe(audits);
  });

  it('stores and audits the cleaned approval note', async () => {
    const c = await app();
    const p = await pendingLookalike(c);
    const oh = api(c.app, await login(c.app, 'u-a-oh'));
    const r = await oh.post(`/api/addresses/${p.id}/review`, { decision: 'approve', version: p.version, confirmTail: tail(p.address), confirmMiddle: middle(p.address), note: `${RLO}${GOOD}${ZW5}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.reviewNote).toBe(GOOD);
    const audit = c.db.prepare("SELECT detail FROM audit_log WHERE action = 'address.approved' AND target_id = ?").get(p.id) as any;
    expect(JSON.parse(audit.detail).note).toBe(GOOD);
  });

  it('refuses a rejection reason made of zero-width or punctuation characters (422 VALIDATION on note)', async () => {
    const c = await app();
    const p = await pendingLookalike(c);
    const oh = api(c.app, await login(c.app, 'u-a-oh'));
    for (const [note, message] of [[ZW5, '거절 사유를 5자 이상 입력하세요.'], [DOTS, '거절 사유에 글자·숫자를 5자 이상 넣어 주세요.']]) {
      const r = await oh.post(`/api/addresses/${p.id}/review`, { decision: 'reject', version: p.version, note });
      expect(r.status, JSON.stringify(note)).toBe(422);
      expect(r.body.error).toMatchObject({ code: 'VALIDATION', message, fields: [{ field: 'note', message }] });
    }
    const ok = await oh.post(`/api/addresses/${p.id}/review`, { decision: 'reject', version: p.version, note: `${RLO}가운데가 원본과 달라 거절합니다` });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'REJECTED', reviewNote: '가운데가 원본과 달라 거절합니다' });
  });
});

describe('사용 대기 중 정지 사유(POST /api/addresses/:id/stop)', () => {
  it('refuses zero-width, bidi-only and punctuation-only reasons, and stores the cleaned reason', async () => {
    const c = await app({ cooldownHours: 24 });
    const han = api(c.app, await login(c.app, 'u-a-han'));
    const version = (await han.get('/api/addresses/ab-14')).body.version as number;
    for (const [reason, message] of [
      [ZW5, '정지 사유를 5자 이상 입력하세요.'],
      [RLO.repeat(6), '정지 사유를 5자 이상 입력하세요.'],
      [DOTS, '정지 사유에 글자·숫자를 5자 이상 넣어 주세요.'],
      [PUNCT, '정지 사유에 글자·숫자를 5자 이상 넣어 주세요.'],
    ]) {
      const r = await han.post('/api/addresses/ab-14/stop', { version, reason });
      expect(r.status, JSON.stringify(reason)).toBe(422);
      expect(r.body.error.fields).toEqual([{ field: 'reason', message }]);
    }
    expect((await han.get('/api/addresses/ab-14')).body.status).toBe('COOLING_DOWN');
    const ok = await han.post('/api/addresses/ab-14/stop', { version, reason: `${RLO}요청하지 않은 등록이라 정지합니다${ZW5}` });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.disabled.reason).toBe('요청하지 않은 등록이라 정지합니다');
    const audit = c.db.prepare("SELECT detail FROM audit_log WHERE action = 'address.cooldown_stopped' AND target_id = 'ab-14'").get() as any;
    expect(JSON.parse(audit.detail).reason).toBe('요청하지 않은 등록이라 정지합니다');
  });
});

describe('출금 요청 반려 사유(POST /api/requests/:id/reject)', () => {
  it('refuses zero-width and punctuation-only reasons (wr-3 stays pending) and stores the cleaned reason', async () => {
    const c = await app();
    const oh = api(c.app, await login(c.app, 'u-a-oh'));
    const p = (await oh.get('/api/requests/wr-3')).body;
    expect(p.status).toBe('PENDING_APPROVAL');
    for (const [reason, message] of [[ZW5, '반려 사유를 5자 이상 입력하세요.'], [DOTS, '반려 사유에 글자·숫자를 5자 이상 넣어 주세요.']]) {
      const r = await oh.post('/api/requests/wr-3/reject', { version: p.version, reason, intentHash: p.intentHash });
      expect(r.status, JSON.stringify(reason)).toBe(422);
      expect(r.body.error.fields).toEqual([{ field: 'reason', message }]);
    }
    expect((await oh.get('/api/requests/wr-3')).body.status).toBe('PENDING_APPROVAL');
    const ok = await oh.post('/api/requests/wr-3/reject', { version: p.version, reason: `${RLO}정산서와 수량이 달라 반려합니다​`, intentHash: p.intentHash });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'REJECTED', rejectReason: '정산서와 수량이 달라 반려합니다' });
  });
});
