import { afterAll, describe, expect, it } from 'vitest';
import { fc, test } from '@fast-check/vitest';
import { AmountError, formatGrouped, formatUnits, krwValue, parseUnits } from '../shared/decimal.ts';

// 수량 파싱 속성 테스트. 각 속성은 1,000건 이상 실행한다.
// 실패하면 fast-check가 seed와 path를 오류 메시지에 출력한다. FC_SEED=<seed>를 주면 같은 입력으로 다시 돌릴 수 있다.
const NUM_RUNS = 1000;
const RUNS = { numRuns: NUM_RUNS, ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}) };

// parseUnits의 기존 한도(정수부 30자리 초과 → AMOUNT_TOO_LARGE). 이 패키지에서 바꾸지 않는다.
const MAX_WHOLE_DIGITS = 30;
const COMMA_MESSAGE = '쉼표는 천 단위 구분(예: 1,000)에만 쓸 수 있습니다. 소수점은 마침표(.)로 입력하세요.';
const FORMAT_MESSAGE = '숫자와 소수점만 입력할 수 있습니다. 예: 1.25';

// 자릿수를 먼저 고른 뒤 값을 뽑아 [0, 10^36) 안에서 작은 값과 큰 값이 고르게 섞이게 한다.
const unitsArb = fc.integer({ min: 1, max: 36 }).chain((digits) => fc.bigInt({ min: 0n, max: 10n ** BigInt(digits) - 1n }));
const precisionArb = fc.integer({ min: 0, max: 18 });
// 원화 가격: 소수 둘째 자리까지의 쉼표 없는 10진 문자열(DB에 저장되는 형태)
const krwPriceArb = fc.bigInt({ min: 0n, max: 10n ** 15n }).map((cents) => formatUnits(cents, 2));

const wholeDigits = (decimal: string) => decimal.split('.')[0]!.length;

/** 던진 AmountError의 code. 예외가 없으면 null, AmountError가 아니면 그대로 다시 던진다. */
function errorOf(fn: () => unknown): { code: string; message: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof AmountError) return { code: e.code, message: e.message };
    throw e;
  }
}

/** 쉼표 없는 10진 문자열에서 i번째 위치가 천 단위 구분 자리인지 */
function isGroupBoundary(plain: string, i: number): boolean {
  const whole = wholeDigits(plain);
  return i > 0 && i < whole && (whole - i) % 3 === 0;
}

/** 수정 전 parseUnits(쉼표를 먼저 지우던 구현)에서 쉼표 처리만 뺀 비교 기준. 쉼표 없는 입력의 동작이 그대로인지 확인한다. */
function legacyCommaFreeParse(input: string, precision: number): bigint {
  const s = input.trim();
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(s)) throw new AmountError('AMOUNT_FORMAT', FORMAT_MESSAGE);
  const [whole, frac = ''] = s.split('.') as [string, string?];
  if (frac.length > precision) throw new AmountError('AMOUNT_PRECISION', '');
  if (whole.length > 30) throw new AmountError('AMOUNT_TOO_LARGE', '');
  return BigInt(whole) * 10n ** BigInt(precision) + BigInt(frac.padEnd(precision, '0') || '0');
}

// 속성마다 실제 실행 횟수를 세어 1,000건 미만이면 실패시킨다.
const runCounts = new Map<string, number>();
const tick = (name: string) => runCounts.set(name, (runCounts.get(name) ?? 0) + 1);
afterAll(() => {
  for (const [name, count] of runCounts) expect(count, name).toBeGreaterThanOrEqual(NUM_RUNS);
});

describe('parseUnits: 쉼표 입력 예시', () => {
  it.each([
    ['1,5', 8],
    ['1,2,3', 0],
    ['12,34.5', 2],
    ['1,0000', 0],
    [',5', 1],
    ['1.234,5', 4],
    ['0,5', 8],
    ['1,,000', 0],
    ['1,000,', 0],
    ['1000,000', 0],
    ['1,000.5,0', 2],
  ])('%s (precision %i) → AMOUNT_FORMAT, 천 단위 쉼표 안내', (input, precision) => {
    expect(errorOf(() => parseUnits(input, precision))).toEqual({ code: 'AMOUNT_FORMAT', message: COMMA_MESSAGE });
  });

  it('accepts commas only at thousands boundaries', () => {
    expect(parseUnits('1,234.5', 2)).toBe(123450n);
    expect(parseUnits('1,000', 0)).toBe(1000n);
    expect(parseUnits('  1,000  ', 0)).toBe(1000n);
    expect(parseUnits('12,345.5', 6)).toBe(12345500000n);
    expect(parseUnits('1,234,567.000001', 6)).toBe(1234567000001n);
    expect(parseUnits('999', 0)).toBe(999n);
    expect(parseUnits('1234567', 0)).toBe(1234567n);
  });

  it('keeps the comma-free messages and checks', () => {
    expect(errorOf(() => parseUnits('1 000', 0))).toEqual({ code: 'AMOUNT_FORMAT', message: FORMAT_MESSAGE });
    expect(errorOf(() => parseUnits('01', 6))).toEqual({ code: 'AMOUNT_FORMAT', message: FORMAT_MESSAGE });
    expect(errorOf(() => parseUnits('1,000.1234567', 6))?.code).toBe('AMOUNT_PRECISION');
    expect(errorOf(() => parseUnits('1' + '0'.repeat(30), 0))?.code).toBe('AMOUNT_TOO_LARGE');
  });
});

describe('parseUnits / formatUnits / formatGrouped / krwValue 속성', () => {
  test.prop([unitsArb, precisionArb], RUNS)('parseUnits(formatUnits(u, p), p) === u', (units, precision) => {
    tick('round trip');
    const text = formatUnits(units, precision);
    if (wholeDigits(text) > MAX_WHOLE_DIGITS) {
      expect(errorOf(() => parseUnits(text, precision))?.code).toBe('AMOUNT_TOO_LARGE');
    } else {
      expect(parseUnits(text, precision)).toBe(units);
    }
  });

  test.prop([unitsArb, precisionArb], RUNS)('parseUnits(formatGrouped(formatUnits(u, p)), p) === u', (units, precision) => {
    tick('grouped round trip');
    const plain = formatUnits(units, precision);
    const grouped = formatGrouped(plain);
    if (wholeDigits(plain) > MAX_WHOLE_DIGITS) {
      expect(errorOf(() => parseUnits(grouped, precision))?.code).toBe('AMOUNT_TOO_LARGE');
    } else {
      expect(parseUnits(grouped, precision)).toBe(units);
    }
  });

  test.prop([unitsArb, precisionArb, fc.nat()], RUNS)('a comma inserted off a 3-digit group boundary → AMOUNT_FORMAT', (units, precision, pick) => {
    tick('off-boundary comma');
    const plain = formatUnits(units, precision);
    const positions = [...Array(plain.length + 1).keys()].filter((i) => !isGroupBoundary(plain, i));
    const at = positions[pick % positions.length]!;
    const text = plain.slice(0, at) + ',' + plain.slice(at);
    expect(errorOf(() => parseUnits(text, precision))).toEqual({ code: 'AMOUNT_FORMAT', message: COMMA_MESSAGE });
  });

  test.prop([unitsArb, precisionArb, fc.nat()], RUNS)('an extra comma anywhere in a grouped amount → AMOUNT_FORMAT', (units, precision, pick) => {
    tick('extra comma in grouped');
    const grouped = formatGrouped(formatUnits(units, precision));
    const at = pick % (grouped.length + 1);
    const text = grouped.slice(0, at) + ',' + grouped.slice(at);
    expect(errorOf(() => parseUnits(text, precision))).toEqual({ code: 'AMOUNT_FORMAT', message: COMMA_MESSAGE });
  });

  test.prop([fc.string({ unit: fc.constantFrom('0', '1', '5', '9', '.', ' ', '-', 'e'), maxLength: 12 }), precisionArb], RUNS)(
    'comma-free input behaves exactly as before the fix',
    (input, precision) => {
      tick('comma-free unchanged');
      let expected: { ok: bigint } | { error: string };
      try {
        expected = { ok: legacyCommaFreeParse(input, precision) };
      } catch (e) {
        expected = { error: (e as AmountError).code };
      }
      const err = errorOf(() => parseUnits(input, precision));
      if ('ok' in expected) {
        expect(err).toBeNull();
        expect(parseUnits(input, precision)).toBe(expected.ok);
      } else {
        expect(err?.code).toBe(expected.error);
        if (err?.code === 'AMOUNT_FORMAT') expect(err.message).toBe(FORMAT_MESSAGE);
      }
    },
  );

  test.prop([unitsArb, unitsArb, precisionArb, krwPriceArb], RUNS)('krwValue is non-decreasing in units', (a, b, precision, krwPrice) => {
    tick('krwValue monotonic');
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    expect(krwValue(lo, precision, krwPrice) <= krwValue(hi, precision, krwPrice)).toBe(true);
  });
});
