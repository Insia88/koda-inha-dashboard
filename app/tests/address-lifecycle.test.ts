import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { api, key, login, makeApp, type Session, type TestCtx } from './helpers.ts';
import { APP_ROOT, loadConfig } from '../server/config.ts';
import { migrate, openDb, type DB } from '../server/db.ts';
import { seed, SEED_COOLDOWN_HOURS } from '../server/seed.ts';
import { verifyChain, writeAudit } from '../server/audit.ts';
import { createRuntime } from '../server/runtime.ts';
import { ACTIVATION_ACTOR, activateDueAddresses, checkAddress, cooldownMs, findLookalikes, POISON_SUSPECTED_MESSAGE } from '../server/domain/addresses.ts';
import { addressBody, DUST_THRESHOLD, isDustAmount, lookalikeMatch, middleSegment } from '../shared/address-rules.ts';

// 주소 수명 주기 보호(WP-10): 확인 뒤 사용 대기(F7), 다른 경로 확인 기록(F15), 0원·소액 입금 주소 오염 점검(F4).
// 대기 시간·소액 기준·비교 기간은 설계 가정이며 KODA 정책이 아니다.

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
/** 이 파일에서만 쓰는 결정적 모의 주소(시드 주소와 겹치지 않음) */
const evm = (seedText: string) => `MOCK-EVM-${createHash('sha256').update(`wp10:${seedText}`).digest('hex').slice(0, 40).toUpperCase()}`;
const OOB = { receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호' };
const REASON = '받는 곳 재무팀에 등록된 대표번호로 전화해 전체 주소를 확인했습니다';

function createBody(address: string, extra: Record<string, unknown> = {}) {
  return {
    label: '수명 주기 점검 주소', counterparty: '모의 상대방', assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '',
    confirmTail: tail(address), confirmMiddle: middle(address), ackNotVerified: true, ackOutOfBandConfirmed: true,
    lookalikeReason: REASON, ...OOB, ...extra,
  };
}

async function register(c: TestCtx, address: string, extra: Record<string, unknown> = {}, by = 'u-a-han') {
  const r = await api(c.app, await login(c.app, by)).post('/api/addresses', createBody(address, extra));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.address;
}

async function approve(c: TestCtx, id: string, address: string, by = 'u-a-oh') {
  const s = await login(c.app, by);
  const cur = (await api(c.app, s).get(`/api/addresses/${id}`)).body;
  const r = await api(c.app, s).post(`/api/addresses/${id}/review`, { decision: 'approve', version: cur.version, confirmTail: tail(address), confirmMiddle: middle(address), note: REASON });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}

async function coolingAddress(c: TestCtx, label: string) {
  const address = evm(label);
  const created = await register(c, address, { label });
  const approved = await approve(c, created.id, address);
  expect(approved.status).toBe('COOLING_DOWN');
  return { id: created.id as string, address, dto: approved };
}

const auditOf = (db: DB, id: string, action: string) =>
  db.prepare('SELECT * FROM audit_log WHERE target_id = ? AND action = ? ORDER BY seq').all(id, action) as any[];

const draft = (s: Session, c: TestCtx, addressId: string) =>
  api(c.app, s).post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId, amount: '10', purpose: '사용 대기 확인용 요청' }, { 'idempotency-key': key() });

/** 대기 시간이 지난 것처럼 active_from을 과거로 옮긴다(시계를 돌리는 대신). */
const expire = (db: DB, id: string) => db.prepare("UPDATE address_book SET active_from = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), id);

describe('사용 대기(확인 뒤 대기 시간)', () => {
  it('moves an approved address to COOLING_DOWN with active_from = reviewed_at + cooldownHours, and records the wait in the audit', async () => {
    const c = await app({ cooldownHours: 24 });
    const { id, dto } = await coolingAddress(c, '대기 전환');
    expect(dto.statusLabel).toBe('사용 대기');
    expect(Date.parse(dto.activeFrom) - Date.parse(dto.reviewedAt)).toBe(24 * 3600_000);
    const row = c.db.prepare('SELECT status, active_from, reviewed_at FROM address_book WHERE id = ?').get(id) as any;
    expect(row).toMatchObject({ status: 'COOLING_DOWN', active_from: dto.activeFrom });
    const [audit] = auditOf(c.db, id, 'address.approved');
    expect(audit.summary).toContain('사용 대기 24시간');
    expect(JSON.parse(audit.detail).cooldown).toEqual({ hours: 24, activeFrom: dto.activeFrom });
  });

  it('keeps the legacy behaviour when cooldownHours is 0: approval makes the address ACTIVE at once (no active_from)', async () => {
    const c = await app(); // makeApp 기본값 0
    const address = evm('0시간');
    const created = await register(c, address);
    const approved = await approve(c, created.id, address);
    expect(approved).toMatchObject({ status: 'ACTIVE', activeFrom: null });
    expect(JSON.parse(auditOf(c.db, created.id, 'address.approved')[0].detail).cooldown).toBeNull();
    expect((await draft(await login(c.app, 'u-a-han'), c, created.id)).status).toBe(201);
  });

  it('treats an unreadable cooldown setting as the 24-hour default instead of no wait', () => {
    const p = (h: unknown) => ({ ...loadConfig({ dbPath: ':memory:', logLevel: 'silent' }).policy, addressBook: { requireSecondPersonReview: true, confirmTailLength: 6, cooldownHours: h as number } });
    expect(cooldownMs(p(0))).toBe(0);
    expect(cooldownMs(p(48))).toBe(48 * 3600_000);
    expect(cooldownMs(p(Number.NaN))).toBe(24 * 3600_000);
    expect(cooldownMs(p(-1))).toBe(24 * 3600_000);
    expect(loadConfig({ dbPath: ':memory:', logLevel: 'silent' }).policy.addressBook.cooldownHours).toBe(SEED_COOLDOWN_HOURS);
  });

  it('refuses a withdrawal request to a COOLING_DOWN address and accepts it once active_from has passed', async () => {
    const c = await app({ cooldownHours: 24 });
    const { id } = await coolingAddress(c, '요청 차단');
    const han = await login(c.app, 'u-a-han');
    const blocked = await draft(han, c, id);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('ADDRESS_NOT_ACTIVE');
    expect(blocked.body.error.fields[0].field).toBe('addressId');
    // 출금 요청 목록용 주소 조회(사용 가능만)에도 나오지 않는다.
    expect((await api(c.app, han).get('/api/addresses?status=ACTIVE&assetCode=USDC&networkCode=ETHEREUM')).body.items.map((a: any) => a.id)).not.toContain(id);

    expire(c.db, id);
    // 별도 타이머 없이도 요청 검증이 주소를 읽기 전에 사용 대기 종료를 반영한다.
    const ok = await draft(han, c, id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.address.status).toBe('ACTIVE');
    const act = auditOf(c.db, id, 'address.activated');
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ actor_id: null, actor_name: ACTIVATION_ACTOR, org_id: 'org-a' });
    expect(JSON.parse(act[0].detail).activeFrom).toBeTruthy();
    expect(verifyChain(c.db, 'org-a').ok).toBe(true);
  });

  it('activates due rows on list and detail reads, once per row, and activateDueAddresses is idempotent', async () => {
    const c = await app({ cooldownHours: 24 });
    const a = await coolingAddress(c, '목록 전환');
    const b = await coolingAddress(c, '상세 전환');
    const han = api(c.app, await login(c.app, 'u-a-han'));
    expect((await han.get(`/api/addresses/${a.id}`)).body.status).toBe('COOLING_DOWN');

    expire(c.db, a.id);
    const list = (await han.get('/api/addresses?status=COOLING_DOWN')).body.items.map((x: any) => x.id);
    expect(list).not.toContain(a.id); // 목록 조회 전에 사용 가능으로 바뀐다
    expect(list).toContain(b.id);
    const detail = (await han.get(`/api/addresses/${a.id}`)).body;
    expect(detail.status).toBe('ACTIVE');
    expect(detail.history.map((h: any) => h.action)).toEqual(['address.created', 'address.approved', 'address.activated']);
    expect(detail.history.at(-1).actorName).toBe(ACTIVATION_ACTOR);

    expire(c.db, b.id);
    expect((await han.get(`/api/addresses/${b.id}`)).body.status).toBe('ACTIVE');
    expect(activateDueAddresses(c.db)).toBe(0);
    expect(auditOf(c.db, a.id, 'address.activated')).toHaveLength(1);
    expect(auditOf(c.db, b.id, 'address.activated')).toHaveLength(1);

    // 직접 호출: 시각을 넘기면 그때까지 끝난 대기만 바꾼다(seed의 ab-14는 22시간 뒤).
    expect(activateDueAddresses(c.db, new Date(Date.now() + 3600_000).toISOString())).toBe(0);
    expect(activateDueAddresses(c.db, new Date(Date.now() + 23 * 3600_000).toISOString())).toBe(1);
    expect((c.db.prepare("SELECT status FROM address_book WHERE id = 'ab-14'").get() as any).status).toBe('ACTIVE');
    expect(verifyChain(c.db, 'org-a').ok).toBe(true);
  });

  it('is called from the runtime tick and the activation helper of the local runtime', async () => {
    const rt = await createRuntime(loadConfig({ dbPath: ':memory:', logLevel: 'silent' }));
    try {
      expect((rt.db.prepare("SELECT status FROM address_book WHERE id = 'ab-14'").get() as any).status).toBe('COOLING_DOWN');
      expire(rt.db, 'ab-14');
      rt.tick();
      expect((rt.db.prepare("SELECT status FROM address_book WHERE id = 'ab-14'").get() as any).status).toBe('ACTIVE');
      expect(auditOf(rt.db, 'ab-14', 'address.activated')).toHaveLength(1);
      rt.activateAddresses();
      expect(auditOf(rt.db, 'ab-14', 'address.activated')).toHaveLength(1);
    } finally {
      await rt.close();
    }
  });

  it('counts COOLING_DOWN rows as live for duplicates and the unique index', async () => {
    const c = await app({ cooldownHours: 24 });
    const { address } = await coolingAddress(c, '중복 기준');
    const dup = await api(c.app, await login(c.app, 'u-a-kang')).post('/api/addresses', createBody(address, { label: '같은 주소 다시' }));
    expect(dup.status).toBe(422);
    expect(dup.body.error.code).toBe('ADDRESS_DUPLICATE');
  });
});

describe('사용 대기 중 정지', () => {
  it('lets the registrant (address-add role), an approver and an org admin stop a COOLING_DOWN address at once, with the reason recorded', async () => {
    const c = await app({ cooldownHours: 24 });
    const targets = [
      { user: 'u-a-han', role: 'requester' }, // 등록자 본인
      { user: 'u-a-oh', role: 'approver' }, // 확인한 승인자
      { user: 'u-a-yoon', role: 'admin' },
    ];
    for (const [i, t] of targets.entries()) {
      const { id } = await coolingAddress(c, `정지 ${i}`);
      const s = api(c.app, await login(c.app, t.user));
      const cur = (await s.get(`/api/addresses/${id}`)).body;
      expect(cur.allowedActions, t.user).toContain('stop');
      const reason = `요청하지 않은 등록으로 보여 정지합니다 (${t.role})`;
      const r = await s.post(`/api/addresses/${id}/stop`, { version: cur.version, reason: `  ${reason}  ` });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ status: 'DISABLED', disabled: { reason, by: { id: t.user } } });
      expect(r.body.allowedActions).not.toContain('stop');
      const [audit] = auditOf(c.db, id, 'address.cooldown_stopped');
      expect(audit.actor_id).toBe(t.user);
      expect(JSON.parse(audit.detail)).toMatchObject({ reason, roles: [t.role] });
      // 정지한 주소는 출금 요청에 쓸 수 없고, 대기 시간이 지나도 사용 가능이 되지 않는다.
      expire(c.db, id);
      expect(activateDueAddresses(c.db)).toBe(0);
      expect((await draft(await login(c.app, 'u-a-han'), c, id)).body.error.code).toBe('ADDRESS_NOT_ACTIVE');
    }
    expect(verifyChain(c.db, 'org-a').ok).toBe(true);
  });

  it('refuses auditors (403), other organisations (404), short reasons (422), stale versions (409) and non-cooling addresses (409)', async () => {
    const c = await app({ cooldownHours: 24 });
    const { id } = await coolingAddress(c, '정지 거부');
    const moon = api(c.app, await login(c.app, 'u-a-moon'));
    const cur = (await moon.get(`/api/addresses/${id}`)).body;
    expect(cur.allowedActions).not.toContain('stop');
    const forbidden = await moon.post(`/api/addresses/${id}/stop`, { version: cur.version, reason: '감사 담당자가 정지 시도' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');

    const otherOrg = await api(c.app, await login(c.app, 'u-b-bae')).post(`/api/addresses/${id}/stop`, { version: cur.version, reason: '다른 조직에서 정지 시도' });
    expect(otherOrg.status).toBe(404);

    const han = api(c.app, await login(c.app, 'u-a-han'));
    const short = await han.post(`/api/addresses/${id}/stop`, { version: cur.version, reason: '짧음' });
    expect(short.status).toBe(422);
    expect(short.body.error.fields.map((f: any) => f.field)).toContain('reason');
    const blank = await han.post(`/api/addresses/${id}/stop`, { version: cur.version, reason: '        ' });
    expect(blank.status).toBe(422);
    const stale = await han.post(`/api/addresses/${id}/stop`, { version: cur.version + 5, reason: '요청하지 않은 등록입니다' });
    expect(stale.status).toBe(409);

    // 관리자 사용 중지 경로로는 사용 대기 주소를 멈추지 않는다(사유를 남기는 정지로 안내).
    const yoon = api(c.app, await login(c.app, 'u-a-yoon'));
    const viaDisable = await yoon.post(`/api/addresses/${id}/disable`, { version: cur.version });
    expect(viaDisable.status).toBe(409);
    expect(viaDisable.body.error.code).toBe('USE_COOLDOWN_STOP');

    expect((await han.get(`/api/addresses/${id}`)).body.status).toBe('COOLING_DOWN');
    expect(auditOf(c.db, id, 'address.cooldown_stopped')).toHaveLength(0);

    // 대기 시간이 끝난 주소(사용 가능)·확인 대기 주소에는 쓰지 않는다.
    expire(c.db, id);
    const active = (await han.get(`/api/addresses/${id}`)).body;
    expect(active.status).toBe('ACTIVE');
    const late = await han.post(`/api/addresses/${id}/stop`, { version: active.version, reason: '대기 시간이 끝난 뒤 정지 시도' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('NOT_COOLING_DOWN');
    const pending = (await han.get('/api/addresses/ab-08')).body;
    expect((await han.post('/api/addresses/ab-08/stop', { version: pending.version, reason: '확인 대기 주소 정지 시도' })).body.error.code).toBe('NOT_COOLING_DOWN');
  });

  it('refuses a user who was deactivated after logging in', async () => {
    const c = await app({ cooldownHours: 24 });
    const s = await login(c.app, 'u-a-kang');
    c.db.prepare("UPDATE users SET is_active = 0 WHERE id = 'u-a-kang'").run();
    const r = await api(c.app, s).post('/api/addresses/ab-14/stop', { version: 2, reason: '비활성 사용자의 정지 시도' });
    expect(r.status).toBe(401);
    expect((c.db.prepare("SELECT status FROM address_book WHERE id = 'ab-14'").get() as any).status).toBe('COOLING_DOWN');
  });
});

describe('홈의 사용 대기 알림', () => {
  it('shows a warning task to every org user with the address-add, approver or admin role while an address is cooling down', async () => {
    const c = await app({ cooldownHours: 24 });
    const task = async (user: string) => (await api(c.app, await login(c.app, user)).get('/api/dashboard')).body.tasks.find((t: any) => t.kind === 'cooling_addresses');
    for (const user of ['u-a-han', 'u-a-kang', 'u-a-oh', 'u-a-seo', 'u-a-yoon']) {
      const t = await task(user);
      expect(t, user).toMatchObject({ count: 1, tone: 'warning', href: '/addresses?status=COOLING_DOWN' });
      expect(t.title).toBe('새 받는 주소 1건이 사용 대기 중입니다 — 요청하지 않은 등록이면 정지하세요');
    }
    expect(await task('u-a-moon')).toBeUndefined(); // 감사 담당자: 정지 권한 없음
    expect((await task('u-b-bae')).count).toBe(0); // 다른 조직의 대기 주소는 세지 않는다
    await coolingAddress(c, '알림 2건째');
    expect((await task('u-a-han')).count).toBe(2);
    expire(c.db, 'ab-14');
    expect((await task('u-a-han')).count).toBe(1); // 조회 전에 사용 대기 종료를 반영한다
  });
});

describe('다른 경로 확인 기록', () => {
  it('requires receivedVia, verifiedVia and verifiedWith (422 VALIDATION with field errors)', async () => {
    const c = await app();
    const han = api(c.app, await login(c.app, 'u-a-han'));
    const { receivedVia: _r, verifiedVia: _v, verifiedWith: _w, ...noOob } = createBody(evm('필수'));
    const r = await han.post('/api/addresses', noOob);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('VALIDATION');
    expect(r.body.error.fields.map((f: any) => f.field)).toEqual(expect.arrayContaining(['receivedVia', 'verifiedVia', 'verifiedWith']));
    for (const bad of [{ receivedVia: 'fax' }, { verifiedVia: 'email' }, { verifiedWith: '   ' }, { verifiedWith: 'x'.repeat(101) }, { verifiedWith: '연락처\ud800' }]) {
      const res = await han.post('/api/addresses', createBody(evm('필수'), bad));
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect(res.body.error.code, JSON.stringify(bad)).toBe('VALIDATION');
    }
    expect((c.db.prepare("SELECT COUNT(*) c FROM address_book WHERE label = '수명 주기 점검 주소'").get() as any).c).toBe(0);
  });

  it('rejects the same channel for receiving and re-confirming (422 OUT_OF_BAND_SAME_CHANNEL on verifiedVia)', async () => {
    const c = await app();
    const han = api(c.app, await login(c.app, 'u-a-han'));
    for (const same of ['in_person', 'other']) {
      const r = await han.post('/api/addresses', createBody(evm(`같은 경로 ${same}`), { receivedVia: same, verifiedVia: same }));
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('OUT_OF_BAND_SAME_CHANNEL');
      expect(r.body.error.fields).toEqual([{ field: 'verifiedVia', message: '받은 경로와 다른 경로를 고르세요.' }]);
    }
    // 저장 계층에서도 같은 경로 기록을 막는다.
    expect(() => c.db.prepare("UPDATE address_book SET received_via = 'in_person', verified_via = 'in_person' WHERE id = 'ab-08'").run()).toThrow(/CHECK constraint failed/);
  });

  it('stores the record, returns it with labels, shows it to the reviewer and writes it to the audit detail', async () => {
    const c = await app();
    const address = evm('기록 저장');
    const created = await register(c, address, { receivedVia: 'messenger', verifiedVia: 'video_call', verifiedWith: '  모의 상대방 자금팀장(영상 통화)  ' });
    expect(created.outOfBand).toEqual({ receivedVia: 'messenger', receivedViaLabel: '메신저', verifiedVia: 'video_call', verifiedViaLabel: '영상 통화', verifiedWith: '모의 상대방 자금팀장(영상 통화)' });
    const reviewer = (await api(c.app, await login(c.app, 'u-a-oh')).get(`/api/addresses/${created.id}`)).body;
    expect(reviewer.allowedActions).toContain('review');
    expect(reviewer.outOfBand.verifiedWith).toBe('모의 상대방 자금팀장(영상 통화)');
    const [audit] = auditOf(c.db, created.id, 'address.created');
    expect(JSON.parse(audit.detail).outOfBand).toEqual({ receivedVia: 'messenger', verifiedVia: 'video_call', verifiedWith: '모의 상대방 자금팀장(영상 통화)' });
    // 이 기록 방식 도입 전 등록분은 기록 없음(null)
    expect((await api(c.app, await login(c.app, 'u-a-han')).get('/api/addresses/ab-01')).body.outOfBand).toBeNull();
  });
});

describe('0원·소액 입금 주소 오염 점검', () => {
  const dustRow = (db: DB) => db.prepare("SELECT * FROM transactions WHERE counterparty_address IS NOT NULL").all() as any[];
  const addressOf = (db: DB, id: string) => (db.prepare('SELECT address FROM address_book WHERE id = ?').get(id) as any).address as string;
  const insertDeposit = (db: DB, id: string, from: string, amountUnits: string, daysAgo: number, type = 'deposit') =>
    db.prepare("INSERT INTO transactions (id, org_id, wallet_id, type, asset_code, network_code, amount_units, counterparty, status, occurred_at, request_id, tx_ref, counterparty_address) VALUES (?, 'org-a', 'w-a-eth', ?, 'USDC', 'ETHEREUM', ?, '시험 입금', 'completed', ?, NULL, ?, ?)")
      .run(id, type, amountUnits, new Date(Date.now() - daysAgo * 86400_000).toISOString(), `MOCK-TX-${id}`, from);

  it('seeds one zero-amount USDC/Ethereum deposit, 3 days ago, from a MOCK address that shares head 4 / tail 6 with ACTIVE ab-07 but differs in the middle', async () => {
    const c = await app();
    const rows = dustRow(c.db);
    expect(rows).toHaveLength(1);
    const d = rows[0];
    expect(d).toMatchObject({ org_id: 'org-a', type: 'deposit', asset_code: 'USDC', network_code: 'ETHEREUM', amount_units: '0', status: 'completed' });
    expect(d.counterparty_address).toMatch(/^MOCK-EVM-[0-9A-F]{40}$/);
    expect(Math.round((Date.now() - Date.parse(d.occurred_at)) / 86400_000)).toBe(3);
    const ab07 = c.db.prepare("SELECT address, status FROM address_book WHERE id = 'ab-07'").get() as any;
    expect(ab07.status).toBe('ACTIVE');
    expect(lookalikeMatch(ab07.address, d.counterparty_address)).toEqual({ prefix: 4, suffix: 6 });
    expect(middleSegment(d.counterparty_address).text).not.toBe(middleSegment(ab07.address).text);
    // 주소록에서는 ab-07 하나와만 비슷하다(다른 검사의 ab-01·ab-02 유사 주소와 겹치지 않음).
    expect(findLookalikes(c.db, 'org-a', d.counterparty_address).matches.map((m) => m.id)).toEqual(['ab-07']);
  });

  it('blocks registering the exact dust sender with ADDRESS_POISON_SUSPECTED (check and create)', async () => {
    const c = await app();
    const from = dustRow(c.db)[0].counterparty_address as string;
    const han = api(c.app, await login(c.app, 'u-a-han'));
    for (const typed of [from, from.toLowerCase().replace(/^mock-evm-/, 'MOCK-EVM-')]) {
      const chk = await han.post('/api/addresses/check', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: typed, memo: '' });
      const f = chk.body.findings[0];
      expect(f).toMatchObject({ code: 'ADDRESS_POISON_SUSPECTED', level: 'error', message: POISON_SUSPECTED_MESSAGE });
      expect(f.message).toBe('최근 0원·소액 입금을 보낸 주소와 같습니다. 주소 오염 공격에서 자주 보이는 패턴이라 등록할 수 없습니다.');
      expect(f.data.dust[0]).toMatchObject({ txRef: 'MOCK-TX-DUST01', amount: '0', assetCode: 'USDC' });
      expect(JSON.stringify(f)).not.toContain(addressBody(from)); // 점검 결과에 보낸 주소 전체를 담지 않는다
    }
    const before = (c.db.prepare('SELECT COUNT(*) c FROM address_book').get() as any).c;
    const cr = await han.post('/api/addresses', createBody(from, { label: '거래 내역에서 복사한 주소' }));
    expect(cr.status).toBe(422);
    expect(cr.body.error.code).toBe('ADDRESS_POISON_SUSPECTED');
    expect(cr.body.error.fields).toEqual([{ field: 'address', message: POISON_SUSPECTED_MESSAGE }]);
    expect((c.db.prepare('SELECT COUNT(*) c FROM address_book').get() as any).c).toBe(before);
    // 다른 네트워크(같은 형식)로 등록해도 같은 주소이므로 막는다.
    const kaia = await han.post('/api/addresses', createBody(from, { label: 'Kaia로 등록', networkCode: 'KAIA' }));
    expect(kaia.body.error.code).toBe('ADDRESS_POISON_SUSPECTED');
  });

  it('warns (ADDRESS_POISON_LOOKALIKE) for a look-alike of the dust sender, including the genuine address it imitates', async () => {
    const c = await app();
    const from = dustRow(c.db)[0].counterparty_address as string;
    const body = addressBody(from);
    const flip = (ch: string) => ((parseInt(ch, 16) + 5) % 16).toString(16).toUpperCase();
    const look = `MOCK-EVM-${body.slice(0, 4)}${[...body.slice(4, -6)].map(flip).join('')}${body.slice(-6)}`;
    const han = api(c.app, await login(c.app, 'u-a-han'));
    const chk = (await han.post('/api/addresses/check', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: look, memo: '' })).body.findings;
    const w = chk.find((f: any) => f.code === 'ADDRESS_POISON_LOOKALIKE');
    expect(w).toMatchObject({ level: 'warning' });
    expect(w.message).toMatch(/^최근 0원·소액 입금을 보낸 주소와 앞 \d+자·뒤 \d+자가 같지만 가운데가 다릅니다\./);
    expect(chk.some((f: any) => f.level === 'error')).toBe(false);
    // 경고만 하고 등록은 막지 않는다(주소록 유사 주소 ab-07 때문에 사유는 필요).
    const cr = await han.post('/api/addresses', createBody(look, { label: '오염 주소와 비슷한 주소' }));
    expect(cr.status, JSON.stringify(cr.body)).toBe(201);
    expect(JSON.parse(auditOf(c.db, cr.body.address.id, 'address.created')[0].detail).warnings).toEqual(expect.arrayContaining(['ADDRESS_POISON_LOOKALIKE', 'ADDRESS_LOOKALIKE']));

    // 흉내 낸 원래 주소(ab-07) 자체도 오염 주소와 비슷하다는 경고를 받는다(중복 오류와 함께).
    const genuine = checkAddress(c.db, 'org-a', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: addressOf(c.db, 'ab-07'), memo: '' }).findings.map((f) => f.code);
    expect(genuine).toEqual(expect.arrayContaining(['ADDRESS_POISON_LOOKALIKE', 'ADDRESS_DUPLICATE']));
    expect(genuine).not.toContain('ADDRESS_POISON_SUSPECTED');
  });

  it('uses the per-asset dust threshold and the 90-day window, and only looks at deposits', async () => {
    const c = await app();
    const cases: [string, string, number, string, boolean][] = [
      // id, amount_units(USDC 6자리), 며칠 전, 종류, 등록이 막혀야 하는가
      ['under', '9999', 10, 'deposit', true], // 0.009999 USDC < 0.01
      ['at', '10000', 10, 'deposit', false], // 0.01 USDC: 기준 이상
      ['old', '0', 91, 'deposit', false], // 90일보다 오래됨
      ['out', '0', 1, 'withdrawal', false], // 출금 상대방은 보지 않는다
    ];
    for (const [id, units, days, type, blocked] of cases) {
      const from = evm(`소액 ${id}`);
      insertDeposit(c.db, `T-${id}`, from, units, days, type);
      const codes = checkAddress(c.db, 'org-a', { assetCode: 'USDC', networkCode: 'ETHEREUM', address: from, memo: '' }).findings.map((f) => f.code);
      expect(codes.includes('ADDRESS_POISON_SUSPECTED'), id).toBe(blocked);
    }
    expect(DUST_THRESHOLD.USDC).toBe('0.01');
    expect(isDustAmount('0', 6, 'USDC')).toBe(true);
    expect(isDustAmount('9999', 6, 'USDC')).toBe(true);
    expect(isDustAmount('10000', 6, 'USDC')).toBe(false);
    expect(isDustAmount('999', 8, 'BTC')).toBe(true); // 0.00000999 BTC < 0.00001
    expect(isDustAmount('1000', 8, 'BTC')).toBe(false);
    expect(isDustAmount('1', 6, 'UNKNOWN')).toBe(false); // 기준이 없는 자산은 0만 해당
    expect(isDustAmount('0', 6, 'UNKNOWN')).toBe(true);
  });

  it('refuses to confirm a pending address that matches a dust sender seen after registration', async () => {
    const c = await app();
    const address = evm('등록 뒤 소액 입금');
    const created = await register(c, address);
    insertDeposit(c.db, 'T-after', address, '0', 0);
    const oh = api(c.app, await login(c.app, 'u-a-oh'));
    const r = await oh.post(`/api/addresses/${created.id}/review`, { decision: 'approve', version: created.version, confirmTail: tail(address), confirmMiddle: middle(address), note: REASON });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ADDRESS_POISON_SUSPECTED');
    expect((await oh.get(`/api/addresses/${created.id}`)).body.status).toBe('PENDING_REVIEW');
    const rej = await oh.post(`/api/addresses/${created.id}/review`, { decision: 'reject', version: created.version, note: '최근 소액 입금을 보낸 주소와 같아 거절합니다' });
    expect(rej.body.status).toBe('REJECTED');
  });

  it('marks the dust deposit on the activity list (with the look-alike book entry) and leaves other rows unmarked', async () => {
    const c = await app();
    const a = api(c.app, await login(c.app, 'u-a-han'));
    const all = (await a.get('/api/activity?type=deposit&pageSize=100')).body.items;
    const marked = all.filter((t: any) => t.poison);
    expect(marked.map((t: any) => t.id)).toEqual(['tx-dust-a1']);
    expect(marked[0]).toMatchObject({ amount: '0', assetCode: 'USDC', poison: { reason: 'dust', lookalike: { id: 'ab-07', prefix: 4, suffix: 6, status: 'ACTIVE' } } });
    expect(marked[0].counterpartyAddress).toBe(dustRow(c.db)[0].counterparty_address);
    expect(all.filter((t: any) => !t.poison).every((t: any) => t.counterpartyAddress === null)).toBe(true);
    // 다른 조직에는 보이지 않는다.
    const b = (await api(c.app, await login(c.app, 'u-b-bae')).get('/api/activity?pageSize=100')).body.items;
    expect(b.some((t: any) => t.poison)).toBe(false);
  });
});

describe('마이그레이션 005', () => {
  const MIGRATIONS = path.join(APP_ROOT, 'server', 'migrations');
  /** 005 이전 상태(001~004)의 DB와 기존 행 */
  function legacyDb(): DB {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const f of ['001_init.sql', '002_request_integrity.sql', '003_address_protection.sql', '004_audit_hash_v2.sql']) {
      db.exec('BEGIN IMMEDIATE');
      db.exec(readFileSync(path.join(MIGRATIONS, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
      db.exec('COMMIT');
    }
    const t = '2026-10-01T00:00:00.000Z';
    db.exec(`
      INSERT INTO organizations VALUES ('o1', '모의 조직', 'customer', 1, '${t}');
      INSERT INTO users (id, org_id, name, email, title, created_at) VALUES ('u1', 'o1', '등록자', 'u1@mock.example', '담당', '${t}'), ('u2', 'o1', '확인자', 'u2@mock.example', '승인', '${t}');
      INSERT INTO assets VALUES ('USDC', 'USD 코인', 6);
      INSERT INTO networks VALUES ('ETHEREUM', 'Ethereum', 'MOCK_EVM', 0, NULL);
      INSERT INTO wallets VALUES ('w1', 'o1', '지갑', 'ETHEREUM', 'MOCK-EVM-0000000000000000000000000000000000000001', NULL, '${t}');
      INSERT INTO address_book (id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at, reviewed_by, reviewed_at, review_note, version, check_findings, lookalike_reason) VALUES
        ('a1', 'o1', '사용 가능', '상대 1', 'USDC', 'ETHEREUM', 'MOCK-EVM-1111111111111111111111111111111111111111', '', 'ACTIVE', 'u1', '${t}', 'u2', '${t}', NULL, 2, '[]', NULL),
        ('a2', 'o1', '확인 대기', '상대 2', 'USDC', 'ETHEREUM', 'MOCK-EVM-2222222222222222222222222222222222222222', '', 'PENDING_REVIEW', 'u1', '${t}', NULL, NULL, NULL, 1, '[{"code":"ADDRESS_LOOKALIKE"}]', '사유가 있는 등록'),
        ('a3', 'o1', '거절', '상대 3', 'USDC', 'ETHEREUM', 'MOCK-EVM-3333333333333333333333333333333333333333', '', 'REJECTED', 'u1', '${t}', 'u2', '${t}', '거절 사유입니다', 2, NULL, NULL),
        ('a4', 'o1', '중지', '상대 4', 'USDC', 'ETHEREUM', 'MOCK-EVM-1111111111111111111111111111111111111111', '', 'DISABLED', 'u1', '${t}', 'u2', '${t}', NULL, 3, NULL, NULL);
      INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, created_by, created_at, updated_at) VALUES
        ('r1', 'o1', 'WR-1', 'w1', 'USDC', 'ETHEREUM', '1', 'a1', '기존 요청', 'DRAFT', 'u1', '${t}', '${t}'),
        ('r2', 'o1', 'WR-2', 'w1', 'USDC', 'ETHEREUM', '1', 'a4', '기존 요청', 'CANCELLED', 'u1', '${t}', '${t}');
      INSERT INTO transactions (id, org_id, wallet_id, type, asset_code, network_code, amount_units, counterparty, status, occurred_at, request_id, tx_ref) VALUES
        ('t1', 'o1', 'w1', 'deposit', 'USDC', 'ETHEREUM', '5', '외부 입금', 'completed', '${t}', NULL, 'MOCK-TX-1');
    `);
    writeAudit(db, { orgId: 'o1', actorId: 'u1', actorName: '등록자', action: 'address.created', targetType: 'address', targetId: 'a1', summary: '기존 기록' });
    return db;
  }
  const OLD_COLUMNS = 'id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at, reviewed_by, reviewed_at, review_note, version, check_findings, lookalike_reason';

  it('keeps every existing row, foreign key and the live-address unique index, and adds the new columns as NULL', () => {
    const db = legacyDb();
    try {
      const before = JSON.stringify(db.prepare(`SELECT ${OLD_COLUMNS} FROM address_book ORDER BY id`).all());
      const reqBefore = JSON.stringify(db.prepare('SELECT * FROM withdrawal_requests ORDER BY id').all());
      const txBefore = db.prepare('SELECT * FROM transactions').all() as any[];
      const ran = migrate(db);
      expect(ran[0]).toBe('005_address_lifecycle.sql'); // 001~004는 다시 실행하지 않는다(뒤에 다른 마이그레이션이 붙을 수 있다)
      expect(JSON.stringify(db.prepare(`SELECT ${OLD_COLUMNS} FROM address_book ORDER BY id`).all())).toBe(before);
      expect(JSON.stringify(db.prepare('SELECT * FROM withdrawal_requests ORDER BY id').all())).toBe(reqBefore);
      const extra = db.prepare('SELECT active_from, received_via, verified_via, verified_with, disabled_by, disabled_at, disabled_reason FROM address_book').all() as any[];
      expect(extra.every((r) => Object.values(r).every((v) => v === null))).toBe(true);
      expect(db.prepare('SELECT * FROM transactions').all()).toEqual(txBefore.map((t) => ({ ...t, counterparty_address: null })));
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect((db.prepare('PRAGMA defer_foreign_keys').get() as any).defer_foreign_keys).toBe(0);
      expect((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys).toBe(1);
      expect(verifyChain(db, 'o1').ok).toBe(true);

      // 외래 키: 참조된 주소를 지우거나 없는 주소를 참조할 수 없다.
      expect(() => db.prepare("DELETE FROM address_book WHERE id = 'a1'").run()).toThrow(/FOREIGN KEY/);
      expect(() => db.prepare("INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, created_by, created_at, updated_at) VALUES ('r3', 'o1', 'WR-3', 'w1', 'USDC', 'ETHEREUM', '1', 'nope', 'x', 'DRAFT', 'u1', 't', 't')").run()).toThrow(/FOREIGN KEY/);
      expect(() => db.prepare("UPDATE address_book SET created_by = 'ghost' WHERE id = 'a3'").run()).toThrow(/FOREIGN KEY/);

      // 제약: 상태 목록, 자기 확인 금지, 사용 대기의 필수 값
      expect(() => db.prepare("UPDATE address_book SET status = 'UNKNOWN' WHERE id = 'a1'").run()).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare("UPDATE address_book SET reviewed_by = 'u1' WHERE id = 'a1'").run()).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare("UPDATE address_book SET status = 'COOLING_DOWN' WHERE id = 'a2'").run()).toThrow(/CHECK constraint failed/);
      expect(() => db.prepare("UPDATE address_book SET status = 'COOLING_DOWN', active_from = '2026-10-02T00:00:00.000Z' WHERE id = 'a2'").run()).toThrow(/CHECK constraint failed/); // 확인자 없음
      db.prepare("UPDATE address_book SET status = 'COOLING_DOWN', active_from = '2099-01-01T00:00:00.000Z' WHERE id = 'a3'").run();

      // 고유 인덱스: 쓰는 중인 주소(확인 대기·사용 대기·사용 가능)끼리는 같은 주소를 둘 수 없다. 사용 중지된 a4는 a1과 같아도 된다.
      const idx = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'address_book_unique_live'").get() as any;
      expect(idx.sql).toContain("'PENDING_REVIEW','COOLING_DOWN','ACTIVE'");
      expect(() => db.prepare("INSERT INTO address_book (id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at) VALUES ('a5', 'o1', '중복', '상대', 'USDC', 'ETHEREUM', 'MOCK-EVM-3333333333333333333333333333333333333333', '', 'PENDING_REVIEW', 'u1', 't')").run()).toThrow(/UNIQUE/);

      // 다른 표의 트리거는 그대로다.
      const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as any[]).map((r) => r.name);
      expect(triggers).toEqual(expect.arrayContaining(['approvals_no_delete', 'approvals_no_self', 'approvals_no_update', 'audit_no_delete', 'audit_no_update']));
      expect(() => db.prepare("UPDATE audit_log SET summary = 'x'").run()).toThrow(/AUDIT_LOG_APPEND_ONLY/);
      expect(migrate(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('applies on a fresh database and the seed passes the foreign key check with a valid audit chain', () => {
    const db = openDb(':memory:');
    try {
      migrate(db);
      seed(db);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      for (const org of ['org-a', 'org-b', 'org-koda']) expect(verifyChain(db, org).ok, org).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('사용 대기 시드(ab-14)', () => {
  it('is a COOLING_DOWN entry confirmed about 2 hours ago that becomes usable 24 hours after confirmation, with matching audit rows', async () => {
    const c = await app();
    const r = c.db.prepare("SELECT * FROM address_book WHERE id = 'ab-14'").get() as any;
    expect(r).toMatchObject({ org_id: 'org-a', status: 'COOLING_DOWN', created_by: 'u-a-han', reviewed_by: 'u-a-seo', asset_code: 'USDC', network_code: 'ETHEREUM', received_via: 'email', verified_via: 'registered_phone' });
    expect(Date.parse(r.active_from) - Date.parse(r.reviewed_at)).toBe(SEED_COOLDOWN_HOURS * 3600_000);
    expect(Math.round((Date.now() - Date.parse(r.reviewed_at)) / 3600_000)).toBe(2);
    expect(Math.round((Date.parse(r.active_from) - Date.now()) / 3600_000)).toBe(22);
    expect(r.created_at < r.reviewed_at).toBe(true);
    const history = (c.db.prepare("SELECT action, actor_id, created_at, detail FROM audit_log WHERE target_id = 'ab-14' ORDER BY seq").all() as any[]);
    expect(history.map((h) => h.action)).toEqual(['address.created', 'address.approved']);
    expect(history.map((h) => h.created_at)).toEqual([r.created_at, r.reviewed_at]);
    expect(history[1].actor_id).toBe('u-a-seo');
    expect(JSON.parse(history[1].detail).cooldown).toEqual({ hours: SEED_COOLDOWN_HOURS, activeFrom: r.active_from });
    expect(JSON.parse(history[0].detail).outOfBand).toMatchObject({ receivedVia: 'email', verifiedVia: 'registered_phone' });
    expect(findLookalikes(c.db, 'org-a', r.address, 'ab-14').total).toBe(0);
    const dto = (await api(c.app, await login(c.app, 'u-a-moon')).get('/api/addresses/ab-14')).body;
    expect(dto).toMatchObject({ status: 'COOLING_DOWN', statusLabel: '사용 대기', activeFrom: r.active_from });
    expect(dto.allowedActions).toEqual([]); // 감사 담당자는 정지할 수 없다
  });
});
