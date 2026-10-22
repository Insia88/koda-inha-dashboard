// 금액·수량은 자산별 최소 단위(정수)를 bigint로 계산하고 문자열로 저장한다.
// 부동소수점(Number)으로 금액을 계산하지 않는다. 표시용 포맷은 formatGrouped에서만 만든다.

// 입력 형식: 쉼표 없는 10진수, 또는 정수부에 천 단위 쉼표가 모두 바른 자리에 있는 10진수.
// 쉼표는 이 검사를 통과한 뒤에만 지운다. 먼저 지우면 "1,5"가 15로 읽힌다.
const AMOUNT_INPUT_RE = /^(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d+)?$/;
const FORMAT_MESSAGE = '숫자와 소수점만 입력할 수 있습니다. 예: 1.25';
const COMMA_MESSAGE = '쉼표는 천 단위 구분(예: 1,000)에만 쓸 수 있습니다. 소수점은 마침표(.)로 입력하세요.';

export class AmountError extends Error {
  constructor(public code: 'AMOUNT_FORMAT' | 'AMOUNT_PRECISION' | 'AMOUNT_NOT_POSITIVE' | 'AMOUNT_TOO_LARGE', message: string) {
    super(message);
  }
}

/** "1.5" + precision 8 → 150000000n, "1,234.5" + precision 2 → 123450n. "1,5"·"1,2,3"은 AMOUNT_FORMAT */
export function parseUnits(input: string, precision: number): bigint {
  const trimmed = input.trim();
  if (!AMOUNT_INPUT_RE.test(trimmed)) {
    throw new AmountError('AMOUNT_FORMAT', trimmed.includes(',') ? COMMA_MESSAGE : FORMAT_MESSAGE);
  }
  const s = trimmed.replace(/,/g, '');
  const [whole, frac = ''] = s.split('.') as [string, string?];
  const fraction = frac.startsWith('.') ? frac.slice(1) : frac;
  if (fraction.length > precision) {
    throw new AmountError('AMOUNT_PRECISION', `이 자산은 소수점 아래 ${precision}자리까지만 입력할 수 있습니다.`);
  }
  if (whole.length > 30) throw new AmountError('AMOUNT_TOO_LARGE', '입력한 수량이 너무 큽니다.');
  const units = BigInt(whole) * 10n ** BigInt(precision) + BigInt((fraction || '').padEnd(precision, '0') || '0');
  return units;
}

export function parsePositiveUnits(input: string, precision: number): bigint {
  const u = parseUnits(input, precision);
  if (u <= 0n) throw new AmountError('AMOUNT_NOT_POSITIVE', '0보다 큰 수량을 입력하세요.');
  return u;
}

/** 150000000n + 8 → "1.5" (불필요한 0 제거, 그룹 구분 없음) */
export function formatUnits(units: bigint | string, precision: number): string {
  let u = typeof units === 'string' ? BigInt(units) : units;
  const neg = u < 0n;
  if (neg) u = -u;
  const base = 10n ** BigInt(precision);
  const whole = u / base;
  const frac = (u % base).toString().padStart(precision, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole.toString()}${frac ? '.' + frac : ''}`;
}

/** 표시용: "1234567.5" → "1,234,567.5" */
export function formatGrouped(decimal: string): string {
  const neg = decimal.startsWith('-');
  const body = neg ? decimal.slice(1) : decimal;
  const [w, f] = body.split('.');
  const grouped = (w ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${f ? '.' + f : ''}`;
}

/** 수량(최소 단위) × 원화 가격(문자열 소수, 소수 둘째 자리까지) → 원 단위 정수(내림) */
export function krwValue(units: bigint | string, precision: number, krwPrice: string): bigint {
  const u = typeof units === 'string' ? BigInt(units) : units;
  const priceCents = parseUnits(krwPrice, 2);
  return (u * priceCents) / (10n ** BigInt(precision) * 100n);
}
