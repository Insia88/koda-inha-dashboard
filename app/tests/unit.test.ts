import { describe, expect, it } from 'vitest';
import { AmountError, formatGrouped, formatUnits, krwValue, parsePositiveUnits, parseUnits } from '../shared/decimal.ts';
import { checkAddressFormat, chunkAddress, isLookalike, lookalikeMatch, middleSegment, XRPL_TAG_PATTERN, type NetworkRule } from '../shared/address-rules.ts';
import { csvCell, toCsv } from '../server/csv.ts';
import { migrate, openDb } from '../server/db.ts';
import { seed } from '../server/seed.ts';

describe('decimal', () => {
  it('parses and formats with asset precision without floating point error', () => {
    expect(parseUnits('0.1', 18) + parseUnits('0.2', 18)).toBe(parseUnits('0.3', 18));
    expect(formatUnits(parseUnits('1234567.000001', 6), 6)).toBe('1234567.000001');
    expect(formatUnits(parseUnits('12.50', 8), 8)).toBe('12.5');
    expect(formatGrouped('1234567.5')).toBe('1,234,567.5');
    expect(formatUnits(-150000000n, 8)).toBe('-1.5');
  });
  it('rejects too many fractional digits, invalid input and non-positive', () => {
    expect(() => parseUnits('1.1234567', 6)).toThrow(AmountError);
    expect(() => parseUnits('1e5', 6)).toThrow(AmountError);
    expect(() => parseUnits('-1', 6)).toThrow(AmountError);
    expect(() => parseUnits('01', 6)).toThrow(AmountError);
    expect(() => parsePositiveUnits('0.000', 6)).toThrow(/0보다 큰/);
  });
  it('computes KRW value by flooring', () => {
    expect(krwValue(parseUnits('0.5', 8), 8, '100000000')).toBe(50000000n);
    expect(krwValue(parseUnits('0.333333', 6), 6, '1400.50')).toBe(466n);
  });
});

const nets: NetworkRule[] = [
  { code: 'BITCOIN', name: 'Bitcoin', family: 'MOCK_BTC', memoRequired: false, memoLabel: null, memoPattern: null },
  { code: 'ETHEREUM', name: 'Ethereum', family: 'MOCK_EVM', memoRequired: false, memoLabel: null, memoPattern: null },
  { code: 'KAIA', name: 'Kaia', family: 'MOCK_EVM', memoRequired: false, memoLabel: null, memoPattern: null },
  { code: 'XRPL', name: 'XRP Ledger', family: 'MOCK_XRP', memoRequired: true, memoLabel: '데스티네이션 태그', memoPattern: /^\d{1,10}$/ },
];
const evm = 'MOCK-EVM-' + 'A'.repeat(40);

describe('address rules', () => {
  it('detects network mismatch and names the probable network', () => {
    const f = checkAddressFormat({ address: 'MOCK-BTC-ABCDEFGHJKLMNPQRSTUV' }, nets[1]!, nets);
    expect(f[0]!.code).toBe('ADDRESS_NETWORK_MISMATCH');
    expect(f[0]!.message).toContain('Bitcoin');
  });
  it('warns that EVM networks share a format and never claims safety', () => {
    const f = checkAddressFormat({ address: evm }, nets[1]!, nets);
    expect(f.map((x) => x.code)).toEqual(['ADDRESS_SHARED_FORMAT', 'NOT_OWNERSHIP_VERIFIED']);
    expect(f.some((x) => /안전합니다|검증되었습니다/.test(x.message))).toBe(false);
  });
  it('requires memo on XRPL and warns about unused memo elsewhere', () => {
    expect(checkAddressFormat({ address: 'MOCK-XRP-ABCDEFGHJKLMNPQRSTUV' }, nets[3]!, nets).map((x) => x.code)).toContain('MEMO_REQUIRED');
    expect(checkAddressFormat({ address: 'MOCK-XRP-ABCDEFGHJKLMNPQRSTUV', memo: 'abc' }, nets[3]!, nets).map((x) => x.code)).toContain('MEMO_FORMAT');
    expect(checkAddressFormat({ address: evm, memo: '1' }, nets[1]!, nets).map((x) => x.code)).toContain('MEMO_NOT_USED');
  });
  it('rejects whitespace inside address', () => {
    expect(checkAddressFormat({ address: 'MOCK-EVM-AAAA AAAA' }, nets[1]!, nets)[0]!.code).toBe('ADDRESS_WHITESPACE');
  });
  it('flags look-alike addresses (same head and tail)', () => {
    const a = 'MOCK-EVM-ABCDEF' + '1'.repeat(30) + 'WXYZ'.replace(/[WXYZ]/g, 'F');
    const b = 'MOCK-EVM-ABCDEF' + '2'.repeat(30) + 'FFFF';
    expect(isLookalike(a, b)).toBe(true);
    expect(isLookalike(a, a)).toBe(false);
    expect(chunkAddress('MOCK-EVM-ABCDEFGH')).toEqual(['MOCK-EVM', 'ABCD', 'EFGH']);
  });
});

/** 고유부 40자 EVM 모의 주소: 앞 head자, 뒤 tail자는 base와 같고 나머지는 모두 다른 글자 */
const BASE40 = '0123456789ABCDEF0123456789ABCDEF01234567';
const flip = (c: string) => ((parseInt(c, 16) + 1) % 16).toString(16).toUpperCase();
function variant(base: string, head: number, tail: number) {
  return base.slice(0, head) + [...base.slice(head, base.length - tail)].map(flip).join('') + base.slice(base.length - tail);
}
const evmOf = (body: string) => `MOCK-EVM-${body}`;

describe('look-alike rule (lookalike-v2)', () => {
  it('matches 4/5, 4/6, 6/4 and any prefix+suffix of 8 or more', () => {
    for (const [h, t] of [[4, 5], [4, 6], [6, 4], [8, 0], [0, 8], [7, 1], [2, 6]] as const) {
      expect(lookalikeMatch(evmOf(BASE40), evmOf(variant(BASE40, h, t))), `${h}/${t}`).toEqual({ prefix: h, suffix: t });
    }
  });
  it('does not match 3/3, 3/4 or identical bodies', () => {
    expect(lookalikeMatch(evmOf(BASE40), evmOf(variant(BASE40, 3, 3)))).toBeNull();
    expect(lookalikeMatch(evmOf(BASE40), evmOf(variant(BASE40, 3, 4)))).toBeNull();
    expect(lookalikeMatch(evmOf(BASE40), evmOf(BASE40))).toBeNull();
    expect(isLookalike(evmOf(BASE40), evmOf(variant(BASE40, 3, 3)))).toBe(false);
  });
  it('compares EVM bodies case-insensitively and ignores the MOCK prefix', () => {
    const lower = evmOf(variant(BASE40, 4, 6).toLowerCase());
    expect(lookalikeMatch(evmOf(BASE40), lower)).toEqual({ prefix: 4, suffix: 6 });
    expect(lookalikeMatch(evmOf(BASE40), evmOf(BASE40.toLowerCase()))).toBeNull(); // 대소문자만 다르면 같은 주소
  });
  it('keeps the old 6/4 rule as a subset (isLookalike wrapper)', () => {
    expect(isLookalike(evmOf(BASE40), evmOf(variant(BASE40, 6, 4)))).toBe(true);
    expect(isLookalike(evmOf(BASE40), evmOf(variant(BASE40, 4, 5)))).toBe(true); // 이전 규칙으로는 놓치던 경우
  });
  it('does not double-count overlapping head and tail on bodies of different length', () => {
    const x = 'MOCK-BTC-ABCDEFGHIJKLMNOPQRST';
    const y = 'MOCK-BTC-ABCDEFGHIJKLMNOPQRSTUV';
    const m = lookalikeMatch(x, y)!;
    expect(m.prefix + m.suffix).toBeLessThanOrEqual(20);
  });
});

describe('middle segment', () => {
  it('returns the centre 8 body characters with 1-based positions', () => {
    expect(middleSegment(evmOf(BASE40))).toEqual({ text: BASE40.slice(16, 24), start: 17, end: 24 });
    const b28 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23';
    expect(middleSegment(`MOCK-BTC-${b28}`)).toEqual({ text: b28.slice(10, 18), start: 11, end: 18 });
    const b24 = 'ABCDEFGHIJKLMNOPQRSTUVWX';
    expect(middleSegment(`MOCK-XRP-${b24}`)).toEqual({ text: b24.slice(8, 16), start: 9, end: 16 });
  });
  it('flags the WBTC-style pair copying ab-01 head 4 and tail 6, and their middles differ', () => {
    const db = openDb(':memory:');
    migrate(db);
    seed(db);
    const ab01 = (db.prepare("SELECT address FROM address_book WHERE id = 'ab-01'").get() as { address: string }).address;
    db.close();
    const body = ab01.replace('MOCK-EVM-', '');
    const poison = evmOf(variant(body, 4, 6));
    expect(poison.slice(0, 13)).toBe(ab01.slice(0, 13));
    expect(poison.slice(-6)).toBe(ab01.slice(-6)); // 끝 6자리 재입력만으로는 구분되지 않는다
    expect(lookalikeMatch(ab01, poison)).toEqual({ prefix: 4, suffix: 6 });
    expect(middleSegment(poison).text).not.toBe(middleSegment(ab01).text);
    expect(middleSegment(poison)).toMatchObject({ start: 17, end: 24 });
  });
});

describe('XRPL destination tag', () => {
  it('accepts exactly the uint32 range on client and server (shared pattern)', () => {
    for (const ok of ['0', '1', '1234567', '999999999', '1000000000', '4294967295', '4294967290', '4199999999']) expect(XRPL_TAG_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['', '4294967296', '4294967300', '4300000000', '5000000000', '9999999999', '42949672950', '-1', '1.5', ' 1', 'abc']) expect(XRPL_TAG_PATTERN.test(bad), bad).toBe(false);
  });
  it('reports MEMO_FORMAT for 4294967296 with the shared rule', () => {
    const xrpl = { ...nets[3]!, memoPattern: XRPL_TAG_PATTERN };
    const addr = 'MOCK-XRP-ABCDEFGHJKLMNPQRSTUV';
    expect(checkAddressFormat({ address: addr, memo: '4294967296' }, xrpl, nets).map((x) => x.code)).toContain('MEMO_FORMAT');
    expect(checkAddressFormat({ address: addr, memo: '4294967295' }, xrpl, nets).map((x) => x.code)).not.toContain('MEMO_FORMAT');
  });
});

describe('csv', () => {
  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('-2')).toBe(`"'-2"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('정상 값')).toBe('정상 값');
    expect(toCsv(['a'], [['b,c']])).toBe('\uFEFFa\r\n"b,c"\r\n');
  });
});