import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from '../server/config.ts';
import { migrate, openDb, type DB } from '../server/db.ts';
import { seed } from '../server/seed.ts';
import { AUDIT_GENESIS_HASH, hashRowV1, hashRowV2, verifyChain, writeAudit, type AuditInput } from '../server/audit.ts';
import { api, login, makeApp } from './helpers.ts';
import { middleSegment } from '../shared/address-rules.ts';
import { brokenTextMessage } from '../shared/schemas.ts';

// 감사 기록 해시 체인 v2 검증. 저장소 수준 변조는 추가 전용 트리거를 지운 테스트 DB에서만 재현한다.

interface Row {
  seq: number; id: string; org_id: string; actor_id: string | null; actor_name: string; action: string;
  target_type: string; target_id: string; summary: string; detail: string; created_at: string;
  prev_hash: string; hash: string; hash_version: number;
}

const rowsOf = (db: DB, orgId: string) => db.prepare('SELECT * FROM audit_log WHERE org_id = ? ORDER BY seq ASC').all(orgId) as unknown as Row[];
const head = (db: DB, orgId: string) => db.prepare('SELECT * FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1').get(orgId) as unknown as Row;
const dropUpdateGuard = (db: DB) => db.exec('DROP TRIGGER audit_no_update');
const dropDeleteGuard = (db: DB) => db.exec('DROP TRIGGER audit_no_delete');

let n = 0;
const event = (orgId: string, over: Partial<AuditInput> = {}): AuditInput => {
  n += 1;
  return { orgId, actorId: 'u-a-moon', actorName: '문태호', action: 'audit.exported', targetType: 'audit', targetId: orgId, summary: `테스트 기록 ${n}`, at: new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString(), ...over };
};

/** 구 방식(v1) 기록을 남긴다. hash_version 열이 없을 때(004 이전)는 열을 빼고 넣는다. */
function writeLegacyV1(db: DB, e: AuditInput, opts: { withVersionColumn: boolean }) {
  const last = db.prepare('SELECT hash FROM audit_log WHERE org_id = ? ORDER BY seq DESC LIMIT 1').get(e.orgId) as { hash: string } | undefined;
  const r = { id: randomUUID(), org_id: e.orgId, actor_id: e.actorId, action: e.action, target_type: e.targetType, target_id: e.targetId, summary: e.summary, detail: JSON.stringify(e.detail ?? {}), created_at: e.at!, prev_hash: last?.hash ?? AUDIT_GENESIS_HASH };
  const hash = hashRowV1(r);
  const cols = 'id, org_id, actor_id, actor_name, action, target_type, target_id, summary, detail, created_at, prev_hash, hash';
  const vals = [r.id, r.org_id, r.actor_id, e.actorName, r.action, r.target_type, r.target_id, r.summary, r.detail, r.created_at, r.prev_hash, hash];
  if (opts.withVersionColumn) db.prepare(`INSERT INTO audit_log (${cols}, hash_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(...vals);
  else db.prepare(`INSERT INTO audit_log (${cols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals);
  return hash;
}

describe('해시 방식 고정값', () => {
  const fx = { prev_hash: AUDIT_GENESIS_HASH, id: '00000000-0000-4000-8000-000000000001', org_id: 'org-a', actor_id: null, actor_name: '시스템(초기 설정)', action: 'member.roles_changed', target_type: 'user', target_id: 'u-a-han', summary: '한지수 초기 역할 부여: requester', detail: '{}', created_at: '2026-10-01T00:00:00.000Z' };

  it('keeps the v1 hash byte-for-byte (values computed with the pre-v2 implementation)', () => {
    expect(hashRowV1(fx)).toBe('7bfba99bb23d71935b95465054e4fb7be7b3553dfd0be15b32368deeec09979e');
    expect(hashRowV1({ ...fx, actor_id: 'u-a-moon', detail: '{"filters":{}}' })).toBe('5e37c48c799a536124ea49f606166fd04bbab2edb72c4a2eee7367712d698baa');
  });

  it('computes v2 as sha256 of the fixed-order JSON array led by the version 2', () => {
    const json = '[2,"' + '0'.repeat(64) + '","00000000-0000-4000-8000-000000000001","org-a",null,"시스템(초기 설정)","member.roles_changed","user","u-a-han","한지수 초기 역할 부여: requester","{}","2026-10-01T00:00:00.000Z"]';
    expect(hashRowV2(fx)).toBe(createHash('sha256').update(json, 'utf8').digest('hex'));
    expect(hashRowV2(fx)).toBe('c76f26ad432c128bd23b44401b0415a8a09f2ef068a9a211abde1816538d34b1');
  });

  it('v2 covers actor_name and tells a missing actor_id apart from an empty one', () => {
    expect(hashRowV1({ ...fx })).toBe(hashRowV1({ ...fx, actor_name: '다른 사람' } as typeof fx));
    expect(hashRowV2({ ...fx, actor_name: '다른 사람' })).not.toBe(hashRowV2(fx));
    expect(hashRowV1({ ...fx, actor_id: '' })).toBe(hashRowV1(fx));
    expect(hashRowV2({ ...fx, actor_id: '' })).not.toBe(hashRowV2(fx));
  });

  it('hashes text as the database stores it: a lone surrogate counts as U+FFFD, well-formed text is unchanged', () => {
    for (const lone of ['\ud800', '\udbff', '\udc00', '\udfff']) {
      expect(hashRowV2({ ...fx, summary: `거래처${lone}` })).toBe(hashRowV2({ ...fx, summary: '거래처�' }));
      expect(hashRowV2({ ...fx, actor_name: `${lone}x` })).toBe(hashRowV2({ ...fx, actor_name: '�x' }));
      expect(hashRowV2({ ...fx, actor_id: `u-${lone}` })).toBe(hashRowV2({ ...fx, actor_id: 'u-�' }));
      // v1은 UTF-8로 바꿔 해시하므로 처음부터 같은 결과였다(사실 확인용).
      expect(hashRowV1({ ...fx, summary: `거래처${lone}` })).toBe(hashRowV1({ ...fx, summary: '거래처�' }));
    }
    // 순서가 뒤집힌 쌍(낮은 쪽이 먼저)은 둘 다 짝이 없다.
    expect(hashRowV2({ ...fx, summary: '\ude00\ud83d' })).toBe(hashRowV2({ ...fx, summary: '��' }));
    // 올바른 서로게이트 쌍(이모지 등)은 바꾸지 않고 그대로 해시한다.
    const pair = { ...fx, summary: '메모 😀' };
    const json = JSON.stringify([2, pair.prev_hash, pair.id, pair.org_id, pair.actor_id, pair.actor_name, pair.action, pair.target_type, pair.target_id, pair.summary, pair.detail, pair.created_at]);
    expect(hashRowV2(pair)).toBe(createHash('sha256').update(json, 'utf8').digest('hex'));
    expect(hashRowV2(pair)).not.toBe(hashRowV2({ ...fx, summary: '메모 ��' }));
  });
});

describe('감사 체인 v2 (모의 데이터)', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); migrate(db); seed(db); });
  afterEach(() => { db.close(); });

  it('writes every new record as v2 and the seeded chains verify', () => {
    const versions = db.prepare('SELECT DISTINCT hash_version v FROM audit_log').all() as { v: number }[];
    expect(versions).toEqual([{ v: 2 }]);
    for (const org of ['org-a', 'org-b']) {
      const v = verifyChain(db, org);
      expect(v).toMatchObject({ ok: true, brokenAtSeq: null, brokenAtNo: null });
      expect(v.count).toBeGreaterThan(0);
    }
    for (const r of rowsOf(db, 'org-a')) expect(r.hash).toBe(hashRowV2(r));
  });

  it('reports headHash as the newest row hash and count as the org row count, and both move on append', () => {
    const before = verifyChain(db, 'org-a');
    const total = (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE org_id = 'org-a'").get() as { c: number }).c;
    expect(before.count).toBe(total);
    expect(before.headHash).toBe(head(db, 'org-a').hash);
    expect(before.headHash).toMatch(/^[0-9a-f]{64}$/);

    writeAudit(db, event('org-a'));
    const after = verifyChain(db, 'org-a');
    expect(after.ok).toBe(true);
    expect(after.count).toBe(total + 1);
    expect(after.headHash).toBe(head(db, 'org-a').hash);
    expect(after.headHash).not.toBe(before.headHash);
    expect(head(db, 'org-a').prev_hash).toBe(before.headHash);

    // 다른 조직 체인은 영향을 받지 않는다.
    const b = verifyChain(db, 'org-b');
    expect(b.ok).toBe(true);
    expect(b.headHash).toBe(head(db, 'org-b').hash);
  });

  it('an org with no records verifies empty with no head hash', () => {
    expect(verifyChain(db, 'org-none')).toEqual({ ok: true, count: 0, brokenAtSeq: null, brokenAtNo: null, headHash: null });
  });

  it('detects an actor_name change on a system record (actor_id is null) and reports its position', () => {
    const rows = rowsOf(db, 'org-a');
    const idx = rows.findIndex((r) => r.actor_id === null);
    expect(idx).toBeGreaterThanOrEqual(0);
    const target = rows[idx]!;
    dropUpdateGuard(db);
    db.prepare('UPDATE audit_log SET actor_name = ? WHERE seq = ?').run('다른 사람', target.seq);
    expect(verifyChain(db, 'org-a')).toEqual({ ok: false, count: rows.length, brokenAtSeq: target.seq, brokenAtNo: idx + 1, headHash: null });
    expect(verifyChain(db, 'org-b').ok).toBe(true);
  });

  it('detects an actor_name change in the middle of the chain and on the newest record', () => {
    const before = rowsOf(db, 'org-a');
    for (let i = 0; i < 3; i++) writeAudit(db, event('org-a', { actorName: '문태호' }));
    const rows = rowsOf(db, 'org-a');
    expect(rows.length).toBe(before.length + 3);
    dropUpdateGuard(db);

    const mid = rows[rows.length - 2]!;
    db.prepare('UPDATE audit_log SET actor_name = ? WHERE seq = ?').run('서예린', mid.seq);
    expect(verifyChain(db, 'org-a')).toMatchObject({ ok: false, brokenAtSeq: mid.seq, brokenAtNo: rows.length - 1 });
    db.prepare('UPDATE audit_log SET actor_name = ? WHERE seq = ?').run(mid.actor_name, mid.seq);
    expect(verifyChain(db, 'org-a').ok).toBe(true);

    // 가장 최근 기록은 뒤따르는 기록이 없어 행 해시만으로 잡아야 한다.
    const last = rows[rows.length - 1]!;
    db.prepare('UPDATE audit_log SET actor_name = ? WHERE seq = ?').run('서예린', last.seq);
    expect(verifyChain(db, 'org-a')).toMatchObject({ ok: false, brokenAtSeq: last.seq, brokenAtNo: rows.length, headHash: null });
  });

  it('still detects a summary edit (regression)', () => {
    const rows = rowsOf(db, 'org-a');
    const target = rows[4]!;
    dropUpdateGuard(db);
    db.prepare('UPDATE audit_log SET summary = ? WHERE seq = ?').run(target.summary + ' (수정)', target.seq);
    expect(verifyChain(db, 'org-a')).toEqual({ ok: false, count: rows.length, brokenAtSeq: target.seq, brokenAtNo: 5, headHash: null });
  });

  it('detects edits to every hashed field and to the stored hash or link', () => {
    writeAudit(db, event('org-a', { detail: { k: 1 } }));
    const rows = rowsOf(db, 'org-a');
    const target = rows[2]!;
    dropUpdateGuard(db);
    const edits: [string, string][] = [
      ['id', randomUUID()], ['actor_id', 'u-test-other'], ['action', 'test.tampered'], ['target_type', 'tampered'], ['target_id', 'tampered-id'],
      ['detail', '{"tampered":true}'], ['created_at', '1999-01-01T00:00:00.000Z'], ['prev_hash', 'f'.repeat(64)], ['hash', 'e'.repeat(64)],
    ];
    for (const [col, value] of edits) {
      const original = (target as unknown as Record<string, unknown>)[col];
      db.prepare(`UPDATE audit_log SET ${col} = ? WHERE seq = ?`).run(value, target.seq);
      expect(verifyChain(db, 'org-a'), col).toMatchObject({ ok: false, brokenAtSeq: target.seq, brokenAtNo: 3 });
      db.prepare(`UPDATE audit_log SET ${col} = ? WHERE seq = ?`).run(original as string | null, target.seq);
      expect(verifyChain(db, 'org-a').ok, `${col} restored`).toBe(true);
    }
  });

  it('a value containing U+001F can no longer collide with a field-shifted row', () => {
    // 주소 이름 등 사용자가 넣은 값에 U+001F가 들어간 경우. v1이라면 필드 경계를 옮긴 행과 해시가 같아진다.
    writeAudit(db, event('org-a', { targetType: 'address', targetId: 'ab-x', summary: '주소 등록 요청: 거래처\u001f입금 주소' }));
    const original = head(db, 'org-a');
    const shifted = { ...original, target_id: 'ab-x\u001f주소 등록 요청: 거래처', summary: '입금 주소' };
    expect(hashRowV1(shifted)).toBe(hashRowV1(original));
    expect(hashRowV2(shifted)).not.toBe(hashRowV2(original));

    dropUpdateGuard(db);
    db.prepare('UPDATE audit_log SET target_id = ?, summary = ? WHERE seq = ?').run(shifted.target_id, shifted.summary, original.seq);
    const v = verifyChain(db, 'org-a');
    expect(v).toMatchObject({ ok: false, brokenAtSeq: original.seq, brokenAtNo: v.count, headHash: null });
  });

  it('treats a v1-labelled record after a v2 record as broken (no downgrade)', () => {
    const count = verifyChain(db, 'org-a').count;
    // 올바른 v1 해시와 연결을 갖춘 기록이라도 v2 뒤에는 받지 않는다.
    writeLegacyV1(db, event('org-a'), { withVersionColumn: true });
    const r = head(db, 'org-a');
    expect(r.hash_version).toBe(1);
    expect(r.hash).toBe(hashRowV1(r));
    expect(verifyChain(db, 'org-a')).toEqual({ ok: false, count: count + 1, brokenAtSeq: r.seq, brokenAtNo: count + 1, headHash: null });
  });

  it('catches relabelling the newest v2 record as v1 to hide an actor_name change', () => {
    const last = head(db, 'org-a');
    dropUpdateGuard(db);
    const forged = { ...last, actor_name: '다른 사람' };
    db.prepare('UPDATE audit_log SET actor_name = ?, hash_version = 1, hash = ? WHERE seq = ?').run(forged.actor_name, hashRowV1(forged), last.seq);
    const v = verifyChain(db, 'org-a');
    expect(v).toMatchObject({ ok: false, brokenAtSeq: last.seq, brokenAtNo: v.count, headHash: null });
  });

  it('treats an unknown hash version as broken', () => {
    const rows = rowsOf(db, 'org-a');
    const target = rows[1]!;
    dropUpdateGuard(db);
    for (const version of [0, 3]) {
      db.prepare('UPDATE audit_log SET hash_version = ? WHERE seq = ?').run(version, target.seq);
      expect(verifyChain(db, 'org-a'), String(version)).toMatchObject({ ok: false, brokenAtSeq: target.seq, brokenAtNo: 2 });
    }
  });

  it('detects deleting a record inside the chain', () => {
    for (let i = 0; i < 3; i++) writeAudit(db, event('org-a'));
    const rows = rowsOf(db, 'org-a');
    dropDeleteGuard(db);

    // 체인 중간 삭제: 다음 기록의 이전 해시가 맞지 않는다. 지운 기록 자리(같은 순번)에서 어긋남이 보고된다.
    const mid = rows[rows.length - 2]!;
    db.prepare('DELETE FROM audit_log WHERE seq = ?').run(mid.seq);
    expect(verifyChain(db, 'org-a')).toMatchObject({ ok: false, brokenAtSeq: rows[rows.length - 1]!.seq, brokenAtNo: rows.length - 1 });
  });

  it('removing the newest record keeps the chain consistent, but the kept headHash and count expose it', () => {
    for (let i = 0; i < 2; i++) writeAudit(db, event('org-a'));
    const kept = verifyChain(db, 'org-a');
    dropDeleteGuard(db);
    db.prepare('DELETE FROM audit_log WHERE seq = ?').run(head(db, 'org-a').seq);
    const later = verifyChain(db, 'org-a');
    // 저장소 안의 체인만으로는 끝부분 삭제를 알 수 없다(앵커 없이 검증 범위 밖). 보관한 값과 대조해야 드러난다.
    expect(later.ok).toBe(true);
    expect(later.count).toBe(kept.count - 1);
    expect(later.headHash).not.toBe(kept.headHash);
  });
});

/** 데이터베이스가 문자열을 UTF-8로 저장하면서 일어나는 변환(짝 없는 서로게이트 → U+FFFD). 구현과 별도로 쓰는 기준값이다. */
const asStored = (s: string) => Buffer.from(s, 'utf8').toString('utf8');

describe('짝 없는 서로게이트가 든 값 (모의 데이터)', () => {
  // 주소 이름·리서치 제목 같은 사용자 입력에 짝 없는 UTF-16 서로게이트가 들어가도, 저장된 행으로 다시 계산한 해시가 같아야 한다.
  // 다르면 평범한 입력 하나로 체인이 영구히 어긋남이 되고(추가 전용이라 고칠 수 없다), 그 뒤의 실제 변조가 가려진다.
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); migrate(db); seed(db); });
  afterEach(() => { db.close(); });

  it('a lone surrogate in summary, actor_name or target_id keeps the chain verifiable', () => {
    writeAudit(db, event('org-a', { actorName: '\udc00문태호', targetId: 'ab-\ud800', summary: '주소 등록 요청: 거래처\ud800', detail: { label: '거래처\ud800' } }));
    const r = head(db, 'org-a');
    expect(r.hash_version).toBe(2);
    expect(r.summary).toBe('주소 등록 요청: 거래처�');
    expect(r.actor_name).toBe('�문태호');
    expect(r.target_id).toBe('ab-�');
    // detail은 JSON 이스케이프로 원래 값을 그대로 담는다.
    expect(JSON.parse(r.detail)).toEqual({ label: '거래처\ud800' });
    expect(r.hash).toBe(hashRowV2(r));
    expect(verifyChain(db, 'org-a')).toEqual({ ok: true, count: rowsOf(db, 'org-a').length, brokenAtSeq: null, brokenAtNo: null, headHash: r.hash });
  });

  it('real tampering after such a record is still reported at the tampered row', () => {
    writeAudit(db, event('org-a', { summary: '주소 등록 요청: 거래처\ud800' }));
    writeAudit(db, event('org-a'));
    const rows = rowsOf(db, 'org-a');
    expect(verifyChain(db, 'org-a').ok).toBe(true);
    dropUpdateGuard(db);
    const last = rows[rows.length - 1]!;
    db.prepare('UPDATE audit_log SET summary = ? WHERE seq = ?').run('바뀐 요약', last.seq);
    expect(verifyChain(db, 'org-a')).toEqual({ ok: false, count: rows.length, brokenAtSeq: last.seq, brokenAtNo: rows.length, headHash: null });
    // 서로게이트가 들어갔던 기록 자체를 바꿔도 찾는다.
    db.prepare('UPDATE audit_log SET summary = ? WHERE seq = ?').run(last.summary, last.seq);
    const marked = rows[rows.length - 2]!;
    db.prepare('UPDATE audit_log SET summary = ? WHERE seq = ?').run('주소 등록 요청: 거래처?', marked.seq);
    expect(verifyChain(db, 'org-a')).toMatchObject({ ok: false, brokenAtSeq: marked.seq, brokenAtNo: rows.length - 1 });
  });

  it('any UTF-16 input re-verifies from the stored row (property)', () => {
    const unit = fc.oneof(
      fc.integer({ min: 0xd800, max: 0xdfff }).map((c) => String.fromCharCode(c)),
      fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)),
      fc.constantFrom('가', '😀', '\u001f', '\u0000', '"', '\\'),
    );
    const text = fc.string({ unit, maxLength: 16 });
    fc.assert(
      fc.property(text, text, text, text, (actorName, targetId, summary, note) => {
        writeAudit(db, event('org-b', { actorName, targetId, summary, detail: { note } }));
        const r = head(db, 'org-b');
        expect(r.actor_name).toBe(asStored(actorName));
        expect(r.target_id).toBe(asStored(targetId));
        expect(r.summary).toBe(asStored(summary));
        expect(JSON.parse(r.detail)).toEqual({ note });
        expect(r.hash).toBe(hashRowV2(r));
        const v = verifyChain(db, 'org-b');
        expect(v.ok).toBe(true);
        expect(v.headHash).toBe(r.hash);
      }),
      { numRuns: 150 },
    );
  });
});

describe('GET /api/audit/verify', () => {
  it('rejects an address label with a lone surrogate before it reaches the chain (POST /api/addresses)', async () => {
    const ctx = await makeApp();
    try {
      const han = api(ctx.app, await login(ctx.app, 'u-a-han'));
      const address = 'MOCK-EVM-' + '1234567890ABCDEF1234567890ABCDEF12345678';
      const cr = await han.post('/api/addresses', { label: '거래처\ud800', counterparty: '테스트 상대방', assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '', confirmTail: address.slice(-6), confirmMiddle: middleSegment(address).text, ackNotVerified: true, ackOutOfBandConfirmed: true, receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 상대방 재무팀 대표번호' });
      // 깨진 문자열은 입력 검증에서 거부되어 업무 표와 감사 요약에 닿지 않는다(마지막 기록은 로그인 그대로).
      expect(cr.status).toBe(422);
      expect(cr.body.error.fields).toContainEqual({ field: 'label', message: brokenTextMessage('주소 이름') });
      expect(head(ctx.db, 'org-a').action).toBe('auth.login');

      const v = await api(ctx.app, await login(ctx.app, 'u-a-moon')).get('/api/audit/verify');
      expect(v.status).toBe(200);
      // 로그인 등으로 뒤에 기록이 더 붙을 수 있으므로 응답 이후의 최신 행과 비교한다.
      expect(v.body).toEqual({ ok: true, count: rowsOf(ctx.db, 'org-a').length, brokenAtNo: null, headHash: head(ctx.db, 'org-a').hash });
    } finally {
      await ctx.app.close();
      ctx.db.close();
    }
  });

  it('rejects an insight title with a lone surrogate and the publisher org chain still verifies (POST /api/insights)', async () => {
    const ctx = await makeApp();
    try {
      const op = api(ctx.app, await login(ctx.app, 'u-k-op'));
      const r = await op.post('/api/insights', { title: '모의 자료\udc00', summary: '요약', language: 'ko', publishedAt: '2026-10-19', url: 'https://example.com/x', providerId: 'prov-a' });
      expect(r.status).toBe(422);
      expect(r.body.error.fields).toContainEqual({ field: 'title', message: brokenTextMessage('제목') });
      expect(head(ctx.db, 'org-koda').action).toBe('auth.login');
      expect(verifyChain(ctx.db, 'org-koda')).toMatchObject({ ok: true, brokenAtSeq: null, headHash: head(ctx.db, 'org-koda').hash });
    } finally {
      await ctx.app.close();
      ctx.db.close();
    }
  });

  it('passes the verification result through, including brokenAtNo and headHash', async () => {
    const ctx = await makeApp();
    try {
      const aud = api(ctx.app, await login(ctx.app, 'u-a-moon'));
      const ok = await aud.get('/api/audit/verify');
      expect(ok.status).toBe(200);
      const newest = head(ctx.db, 'org-a');
      expect(ok.body).toEqual({ ok: true, count: rowsOf(ctx.db, 'org-a').length, brokenAtNo: null, headHash: newest.hash });

      dropUpdateGuard(ctx.db);
      const rows = rowsOf(ctx.db, 'org-a');
      ctx.db.prepare('UPDATE audit_log SET actor_name = ? WHERE seq = ?').run('다른 사람', rows[2]!.seq);
      const broken = await aud.get('/api/audit/verify');
      expect(broken.body).toEqual({ ok: false, count: rows.length, brokenAtNo: 3, headHash: null });
      expect(broken.body).not.toHaveProperty('brokenAtSeq');
    } finally {
      await ctx.app.close();
      ctx.db.close();
    }
  });
});

describe('기존 v1 체인에서 v2로 전환', () => {
  let db: DB;
  beforeEach(() => {
    // 004 이전 상태의 DB: 001만 적용하고, 당시 방식으로 기록을 남긴다.
    db = openDb(':memory:');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.exec(readFileSync(path.join(APP_ROOT, 'server', 'migrations', '001_init.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run('001_init.sql', new Date().toISOString());
  });
  afterEach(() => { db.close(); });

  it('keeps legacy rows untouched, verifies them as v1, then accepts v2 rows after them', () => {
    const legacyHashes: string[] = [];
    for (let i = 0; i < 4; i++) legacyHashes.push(writeLegacyV1(db, event('org-a', { actorId: i % 2 ? null : 'u-a-han', actorName: i % 2 ? '시스템(초기 설정)' : '한지수' }), { withVersionColumn: false }));
    writeLegacyV1(db, event('org-b'), { withVersionColumn: false });
    const snapshot = JSON.stringify(db.prepare('SELECT * FROM audit_log ORDER BY seq').all());

    const ran = migrate(db);
    expect(ran).toContain('004_audit_hash_v2.sql');
    expect(ran).not.toContain('001_init.sql');

    // 마이그레이션은 기존 행을 다시 쓰지 않는다. 새 열만 기본값 1로 붙는다.
    const legacy = rowsOf(db, 'org-a');
    expect(legacy.map((r) => r.hash_version)).toEqual([1, 1, 1, 1]);
    expect(legacy.map((r) => r.hash)).toEqual(legacyHashes);
    const strip = (rows: unknown[]) => JSON.stringify((rows as Record<string, unknown>[]).map(({ hash_version: _v, ...rest }) => rest));
    expect(strip(db.prepare('SELECT * FROM audit_log ORDER BY seq').all())).toBe(snapshot);

    expect(verifyChain(db, 'org-a')).toEqual({ ok: true, count: 4, brokenAtSeq: null, brokenAtNo: null, headHash: legacyHashes[3] });

    // 이후 기록은 v2로 이어진다. v1 끝 해시를 이전 해시로 삼는다.
    writeAudit(db, event('org-a'));
    writeAudit(db, event('org-a', { actorId: null, actorName: '모의 커스터디' }));
    const mixed = rowsOf(db, 'org-a');
    expect(mixed.map((r) => r.hash_version)).toEqual([1, 1, 1, 1, 2, 2]);
    expect(mixed[4]!.prev_hash).toBe(legacyHashes[3]);
    const v = verifyChain(db, 'org-a');
    expect(v).toEqual({ ok: true, count: 6, brokenAtSeq: null, brokenAtNo: null, headHash: mixed[5]!.hash });
    expect(verifyChain(db, 'org-b')).toMatchObject({ ok: true, count: 1 });

    // 섞인 체인에서도 v2 행의 수행자 이름 변경과 v1 행의 요약 변경을 찾는다.
    db.exec('DROP TRIGGER audit_no_update');
    db.prepare('UPDATE audit_log SET actor_name = ? WHERE seq = ?').run('다른 커스터디', mixed[5]!.seq);
    expect(verifyChain(db, 'org-a')).toMatchObject({ ok: false, brokenAtSeq: mixed[5]!.seq, brokenAtNo: 6 });
    db.prepare('UPDATE audit_log SET actor_name = ? WHERE seq = ?').run('모의 커스터디', mixed[5]!.seq);
    db.prepare('UPDATE audit_log SET summary = ? WHERE seq = ?').run('바뀐 요약', mixed[1]!.seq);
    expect(verifyChain(db, 'org-a')).toMatchObject({ ok: false, brokenAtSeq: mixed[1]!.seq, brokenAtNo: 2 });
  });

  it('a v1 row after a v2 row in a migrated chain fails at that row', () => {
    writeLegacyV1(db, event('org-a'), { withVersionColumn: false });
    migrate(db);
    writeAudit(db, event('org-a'));
    writeLegacyV1(db, event('org-a'), { withVersionColumn: true });
    writeAudit(db, event('org-a'));
    const rows = rowsOf(db, 'org-a');
    expect(rows.map((r) => r.hash_version)).toEqual([1, 2, 1, 2]);
    expect(verifyChain(db, 'org-a')).toEqual({ ok: false, count: 4, brokenAtSeq: rows[2]!.seq, brokenAtNo: 3, headHash: null });
  });

  it('legacy v1 rows keep their original coverage: actor_name was never part of the v1 hash', () => {
    // 사실 확인용: v2 이전에 남은 기록의 수행자 이름은 체인으로 보호되지 않는다. 새 기록(v2)부터 보호된다.
    writeLegacyV1(db, event('org-a'), { withVersionColumn: false });
    migrate(db);
    db.exec('DROP TRIGGER audit_no_update');
    db.prepare("UPDATE audit_log SET actor_name = '다른 사람' WHERE org_id = 'org-a'").run();
    expect(verifyChain(db, 'org-a').ok).toBe(true);
  });

  it('the append-only triggers survive the migration', () => {
    writeLegacyV1(db, event('org-a'), { withVersionColumn: false });
    migrate(db);
    writeAudit(db, event('org-a'));
    expect(() => db.prepare("UPDATE audit_log SET actor_name = 'x'").run()).toThrow(/AUDIT_LOG_APPEND_ONLY/);
    expect(() => db.prepare('UPDATE audit_log SET hash_version = 1').run()).toThrow(/AUDIT_LOG_APPEND_ONLY/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/AUDIT_LOG_APPEND_ONLY/);
  });
});
