import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, key, login, makeApp, type TestCtx } from './helpers.ts';

// 출금 요청 수량의 쉼표 처리(서버 기준). "1,5"가 15로 저장되면 안 된다.
let ctx: TestCtx;
beforeEach(async () => { ctx = await makeApp(); });
afterEach(async () => { await ctx.app.close(); ctx.db.close(); });

const COMMA_MESSAGE = '쉼표는 천 단위 구분(예: 1,000)에만 쓸 수 있습니다. 소수점은 마침표(.)로 입력하세요.';

async function postDraft(amount: string, purpose: string) {
  const s = await login(ctx.app, 'u-a-han');
  const a = api(ctx.app, s);
  const r = await a.post('/api/requests', { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount, purpose }, { 'idempotency-key': key() });
  return { a, r };
}

const draftsWithPurpose = (purpose: string) =>
  (ctx.db.prepare('SELECT COUNT(*) c FROM withdrawal_requests WHERE purpose = ?').get(purpose) as { c: number }).c;

describe('수량 입력의 쉼표 처리 (POST /api/requests)', () => {
  it.each(['1,5', '1,2,3', '12,34.5', '1,0000', ',5', '1.234,5', '0,5', '1,000,'])(
    "rejects '%s' with 422 on field amount and stores nothing",
    async (amount) => {
      const purpose = `쉼표 거부 확인 ${amount}`;
      const { r } = await postDraft(amount, purpose);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('AMOUNT_FORMAT');
      expect(r.body.error.message).toBe(COMMA_MESSAGE);
      expect(r.body.error.fields[0].field).toBe('amount');
      expect(r.body.error.fields[0].message).toBe(COMMA_MESSAGE);
      expect(draftsWithPurpose(purpose)).toBe(0);
    },
  );

  it("accepts '1,000' as 1000", async () => {
    const { r } = await postDraft('1,000', '천 단위 쉼표 1,000');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.amount).toBe('1000');
    expect(r.body.amountUnits).toBe('1000000000');
  });

  it("accepts '12,345.5' as 12345.5", async () => {
    const { r } = await postDraft('12,345.5', '천 단위 쉼표 12,345.5');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.amount).toBe('12345.5');
    expect(r.body.amountUnits).toBe('12345500000');
  });

  it("rejects '1,5' when editing a draft and keeps the stored amount", async () => {
    const { a, r } = await postDraft('1.5', '수정 시 쉼표 거부');
    expect(r.status).toBe(201);
    const put = await a.put(`/api/requests/${r.body.id}`, { assetCode: 'USDC', networkCode: 'ETHEREUM', addressId: 'ab-01', amount: '1,5', purpose: '수정 시 쉼표 거부', version: r.body.version });
    expect(put.status).toBe(422);
    expect(put.body.error.code).toBe('AMOUNT_FORMAT');
    expect(put.body.error.fields[0].field).toBe('amount');
    const after = await a.get(`/api/requests/${r.body.id}`);
    expect(after.body.amount).toBe('1.5');
    expect(after.body.version).toBe(r.body.version);
  });
});
