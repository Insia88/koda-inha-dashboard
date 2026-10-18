import { describe, expect, it } from 'vitest';
import { AmountError, formatGrouped, formatUnits, krwValue, parsePositiveUnits, parseUnits } from '../shared/decimal.ts';
import { checkAddressFormat, chunkAddress, isLookalike, type NetworkRule } from '../shared/address-rules.ts';
import { csvCell, toCsv } from '../server/csv.ts';

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