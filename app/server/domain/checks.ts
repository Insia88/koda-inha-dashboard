// 출금 전 점검(F8 쉬운 말 검토, F13 금액·패턴 이상, F14 첫 거래 시험 전송 안내)과 승인 대상 지문(F10).
// 근거: .research/security-incidents-UX.md 6장 8·10·13·14번. 문구는 같은 문서 5장 표현 원칙을 따른다.
// 점검은 보내도 되는지 판정하지 않는다. 무엇을 어떤 기준으로 보았는지만 알리고, 확인할 수 없으면 '확인 불가'로 둔다(기준 이내로 보이지 않게).
// 기준값(배수·비율·기간·건수)은 config/policy.json withdrawalChecks의 설계 가정이며 KODA 정책이 아니다(docs/assumptions.md A-27·A-28).
import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import { now } from '../db.ts';
import { AppError } from '../errors.ts';
import { kstDateTime } from '../csv.ts';
import type { Policy, WithdrawalChecksPolicy } from '../config.ts';
import { formatGrouped, formatUnits, krwValue } from '../../shared/decimal.ts';
import { FAMILY_RULES } from '../../shared/address-rules.ts';
import { CHECK_REASON_MIN_LENGTH, type CheckId, type RequestCheck } from '../../shared/terms.ts';
import { letterDigitCount, stripFormatChars } from '../../shared/schemas.ts';

// ---------------------------------------------------------------------------
// 승인 대상 지문(F10)
// ---------------------------------------------------------------------------

/** 지문 계산 방식 버전. 묶는 항목이나 정규화 규칙이 바뀌면 올린다(이전 지문은 이전 방식으로만 다시 계산된다). */
export const INTENT_VERSION = 1;

/** 지문에 묶는 항목. 승인 요청(제출) 때 정해지고 그 뒤에는 바뀌지 않아야 하는 값만 넣는다. */
export interface IntentFields {
  v: number;
  requestId: string;
  orgId: string;
  assetCode: string;
  networkCode: string;
  /** 최소 단위 정수 문자열 */
  amountUnits: string;
  addressId: string;
  /** 네트워크 계열 규칙으로 정규화한 받는 주소 */
  address: string;
  memo: string;
  requiredApprovals: number;
}

/** 요청 행(requests.ts SELECT)에서 지문에 필요한 열 */
export interface IntentRow {
  id: string;
  org_id: string;
  asset_code: string;
  network_code: string;
  amount_units: string;
  address_id: string;
  address_value: string;
  address_memo: string | null;
  required_approvals: number;
  network_family: string;
}

/** 주소 정규화: 앞뒤 공백 제거, 대소문자를 구분하지 않는 계열은 대문자. 알 수 없는 계열은 공백만 지운다. */
export function normalizeIntentAddress(address: string, family: string): string {
  const t = String(address ?? '').trim();
  const rule = (FAMILY_RULES as Record<string, { caseInsensitive: boolean } | undefined>)[family];
  return rule?.caseInsensitive ? t.toUpperCase() : t;
}

/**
 * 정규화 JSON: 객체 키를 정렬하고 공백 없이 이어 쓴다(RFC 8785와 같은 키 순서. 이 지문은 정수·문자열만 담는다).
 * 같은 내용이면 키 순서·들여쓰기와 관계없이 같은 글자열이 된다.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function intentFieldsOf(r: IntentRow): IntentFields {
  return {
    v: INTENT_VERSION,
    requestId: String(r.id),
    orgId: String(r.org_id),
    assetCode: String(r.asset_code),
    networkCode: String(r.network_code),
    amountUnits: BigInt(r.amount_units).toString(),
    addressId: String(r.address_id),
    address: normalizeIntentAddress(r.address_value, r.network_family),
    memo: String(r.address_memo ?? '').trim(),
    requiredApprovals: Number(r.required_approvals),
  };
}

/** 지문: 정규화 JSON의 SHA-256(소문자 16진수 64자). */
export function intentHashOf(fields: IntentFields): string {
  return createHash('sha256').update(canonicalJson(fields), 'utf8').digest('hex');
}

/** 화면 표시용: 앞 16자를 대문자 4자 묶음으로(예: '7F3A 91C2 0B4E 55D1'). 없으면 null. */
export function intentHashDisplay(hash: string | null | undefined): string | null {
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  return hash.slice(0, 16).toUpperCase().match(/.{4}/g)!.join(' ');
}

// ---------------------------------------------------------------------------
// 시세 상태(필요 승인 수 결정과 출금 전 점검이 같은 기준을 쓴다)
// ---------------------------------------------------------------------------

/** 시세 기준 시각이 이보다 더 미래이면 잘못된 값으로 보고 지연과 같게 다룬다(시계 차이 허용 폭). */
export const PRICE_FUTURE_SKEW_MS = 5 * 60_000;

export type PriceRead = { kind: 'missing' } | { kind: 'stale' | 'fresh'; krwPrice: string; asOf: string };

/**
 * 자산 시세를 읽고 쓸 수 있는지 판단한다. 기준 시각이 staleAfterMinutes보다 오래되었거나, 읽을 수 없거나,
 * 5분 넘게 미래이면 stale이다(fail closed, docs/assumptions.md A-03·A-13).
 * override를 주면 표 대신 그 값을 쓴다(모의 데이터가 과거 시점의 점검을 다시 만들 때).
 */
export function readPrice(db: DB, assetCode: string, staleAfterMinutes: number, nowMs = Date.now(), override?: { krwPrice: string; asOf: string } | null): PriceRead {
  const row = override !== undefined
    ? (override ? { krw_price: override.krwPrice, as_of: override.asOf } : undefined)
    : (db.prepare('SELECT krw_price, as_of FROM prices WHERE asset_code = ?').get(assetCode) as { krw_price: string; as_of: string } | undefined);
  if (!row) return { kind: 'missing' };
  const age = nowMs - Date.parse(row.as_of);
  const stale = !Number.isFinite(age) || age > staleAfterMinutes * 60_000 || age < -PRICE_FUTURE_SKEW_MS;
  return { kind: stale ? 'stale' : 'fresh', krwPrice: row.krw_price, asOf: row.as_of };
}

// ---------------------------------------------------------------------------
// 출금 전 점검(F8·F13·F14)
// ---------------------------------------------------------------------------

/** config/policy.json withdrawalChecks의 기본값과 같다(설계 가정). tests/request-checks.test.ts가 둘이 같은지 확인한다. */
export const DEFAULT_WITHDRAWAL_CHECKS: Readonly<WithdrawalChecksPolicy> = {
  amountMedianMultiple: 5,
  amountMedianMinHistory: 3,
  balanceSharePercent: 50,
  burstWindowMinutes: 60,
  burstCount: 3,
};

/** 정책 값을 읽는다. 숫자가 아니거나 0 이하이면 기준이 없어지지 않도록 기본값을 쓴다. 건수는 정수로 내린다. */
export function checkThresholds(p: Partial<WithdrawalChecksPolicy> | undefined): WithdrawalChecksPolicy {
  const pos = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  const int = (v: unknown, d: number) => Math.max(1, Math.floor(pos(v, d)));
  const D = DEFAULT_WITHDRAWAL_CHECKS;
  return {
    amountMedianMultiple: pos(p?.amountMedianMultiple, D.amountMedianMultiple),
    amountMedianMinHistory: int(p?.amountMedianMinHistory, D.amountMedianMinHistory),
    balanceSharePercent: Math.min(100, pos(p?.balanceSharePercent, D.balanceSharePercent)),
    burstWindowMinutes: pos(p?.burstWindowMinutes, D.burstWindowMinutes),
    burstCount: int(p?.burstCount, D.burstCount),
  };
}

export interface CheckContext {
  /** 점검하는 요청 id. 저장 전 미리 보기는 null(같은 요청을 과거 기록·건수에서 빼는 데만 쓴다). */
  requestId: string | null;
  orgId: string;
  walletId: string;
  assetCode: string;
  networkCode: string;
  amountUnits: bigint;
  precision: number;
  /** 정규화된 받는 주소(주소록 값) */
  address: string;
  /** 사용 가능 수량. 기본은 지갑 보유 − 예약(이번 요청이 아직 예약되지 않은 상태). */
  availableUnits?: bigint;
  /** 시세. 기본은 시세 표. null이면 시세 없음. */
  price?: { krwPrice: string; asOf: string } | null;
  /** 점검 기준 시각. 기본은 지금. */
  nowIso?: string;
}

const num = (units: bigint, precision: number) => formatGrouped(formatUnits(units, precision));

function median(xs: bigint[]): bigint {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}

/** a ÷ b를 소수 첫째 자리까지 내림해 글자로(예: 12.5, 3). b는 0보다 크다. */
function ratio1(a: bigint, b: bigint): string {
  const x10 = (a * 10n) / b;
  const whole = x10 / 10n;
  const frac = x10 % 10n;
  return frac === 0n ? whole.toString() : `${whole}.${frac}`;
}

/** 정책 배수·비율(소수 가능)을 100배 정수로. */
const x100 = (n: number) => BigInt(Math.round(n * 100));
const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

/**
 * 출금 전 점검 목록. 요청 상태를 바꾸지 않는다(읽기만).
 * 1) first_use: 이 대시보드에서 같은 자산·네트워크로 이 주소에 처리 완료된 출금 요청이 없으면 주의(사유 필요) + 소액 시험 전송 권유.
 *    자산 활동 내역의 출금 행은 받는 주소가 없어 세지 않으므로, 문구에 '이 대시보드' 범위를 함께 쓴다.
 * 2) amount_history: 그런 출금이 최소 건수 이상이면 중앙값의 배수를 넘을 때 주의(사유 필요), 모자라면 확인 불가
 * 3) balance_share: 사용 가능 수량의 비율 이상을 한 번에 보내면 주의(사유 필요). 사용 가능 수량보다 많으면 수량 부족으로 알린다
 * 4) recent_burst: 최근 기간에 같은 조직·같은 자산 요청(이번 요청 포함)이 건수 이상이면 주의(사유 필요 없음)
 * 5) price: 시세가 없거나 지연되면 확인 불가(기준 이내로 보이지 않음)
 */
export function computeChecks(db: DB, policy: Policy, c: CheckContext): RequestCheck[] {
  const t = checkThresholds(policy.withdrawalChecks);
  const nowIso = c.nowIso ?? now();
  const nowMs = Date.parse(nowIso);
  const unit = c.assetCode;
  const amount = c.amountUnits;
  const out: RequestCheck[] = [];
  const check = (id: CheckId, outcome: RequestCheck['outcome'], label: string, detail: string, basis: string, requiresReason = false) =>
    out.push({ id, outcome, label, detail, basis, requiresReason: outcome === 'caution' && requiresReason });

  // 같은 주소로 처리 완료된 과거 출금(이 대시보드의 출금 요청 기준)
  const history = db.prepare(
    `SELECT r.amount_units, r.completed_at FROM withdrawal_requests r JOIN address_book ab ON ab.id = r.address_id
      WHERE r.org_id = ? AND r.status = 'COMPLETED' AND r.asset_code = ? AND r.network_code = ? AND ab.address = ? AND r.id <> ?
        AND (r.completed_at IS NULL OR r.completed_at <= ?)
      ORDER BY r.completed_at`,
  ).all(c.orgId, c.assetCode, c.networkCode, c.address, c.requestId ?? '', nowIso) as { amount_units: string; completed_at: string | null }[];
  // 범위를 문장에 함께 쓴다: 이 대시보드의 출금 요청만 세며, 자산 활동 내역의 출금 행은 받는 주소가 없어 세지 않는다(A-27).
  // 다른 화면(자산 활동 내역)에 같은 받는 곳으로 간 출금이 보여도 이 문장과 어긋나지 않게 한다.
  // 요청 상태 이름('처리 완료')과 헷갈리지 않게 점검 문장에는 '보내 완료된'으로 쓴다(같은 화면에 이 요청의 상태가 함께 보인다).
  const historyBasis = '이 대시보드에서 이 조직이 같은 자산·네트워크로 이 주소에 보내 완료된 출금 요청 기준(자산 활동 내역의 출금은 받는 주소가 기록되지 않아 제외)';

  // 1) 이 대시보드로 처음 보내는 주소(F14)
  if (history.length === 0) {
    check('first_use', 'caution', '이 대시보드로 처음 보내는 주소입니다',
      '이 대시보드의 출금 요청으로 이 주소에 보내 완료된 기록이 없습니다. 자산 활동 내역의 이전 출금은 받는 주소가 기록되지 않아 세지 않았습니다. 먼저 소액을 시험 전송해 받는 곳의 수령 확인을 받은 뒤 본 전송을 요청하는 방법을 권합니다. 시험 전송이 도착했다는 것은 이번 경로가 맞았다는 뜻일 뿐 이후 전송을 보증하지 않습니다.',
      historyBasis, true);
  } else {
    const last = history[history.length - 1]!.completed_at;
    check('first_use', 'pass', '이 대시보드로 보낸 적이 있는 주소입니다',
      `이 대시보드의 출금 요청으로 이 주소에 보내 완료된 출금이 ${history.length}건 있습니다${last ? `(마지막 ${kstDateTime(last)} KST)` : ''}. 이전 기록이 있어도 받는 곳이 그대로라는 보증은 아닙니다.`,
      historyBasis);
  }

  // 2) 과거 금액과 비교(F13)
  const amountBasis = `이 대시보드에서 완료된 출금이 ${t.amountMedianMinHistory}건 이상일 때 중앙값의 ${fmtN(t.amountMedianMultiple)}배를 넘으면 주의(설계 가정)`;
  if (history.length < t.amountMedianMinHistory) {
    check('amount_history', 'unknown', '확인 불가(과거 출금 부족)',
      `이 대시보드의 출금 요청으로 이 주소에 보내 완료된 출금이 ${history.length}건이라 과거 금액과 비교하지 않았습니다. ${t.amountMedianMinHistory}건 이상일 때 중앙값과 비교합니다.`,
      amountBasis);
  } else {
    const med = median(history.map((h) => BigInt(h.amount_units)));
    const r = med > 0n ? ratio1(amount, med) : '—';
    if (med <= 0n || amount * 100n > med * x100(t.amountMedianMultiple)) {
      check('amount_history', 'caution', '과거 출금보다 훨씬 큰 금액입니다',
        `이 주소로 보낸 과거 ${history.length}건의 중앙값은 ${num(med, c.precision)} ${unit}인데, 이번 수량은 ${num(amount, c.precision)} ${unit}로 ${r}배입니다. 근거 문서의 수량과 단위를 다시 대조하세요.`,
        amountBasis, true);
    } else {
      check('amount_history', 'pass', `과거 출금 중앙값의 ${fmtN(t.amountMedianMultiple)}배 이하입니다`,
        `이 주소로 보낸 과거 ${history.length}건의 중앙값은 ${num(med, c.precision)} ${unit}이고, 이번 수량은 그 ${r}배입니다.`,
        amountBasis);
    }
  }

  // 3) 사용 가능 수량 대비 비율(F13)
  let available = c.availableUnits;
  if (available === undefined) {
    const b = db.prepare('SELECT total_units, reserved_units FROM balances WHERE wallet_id = ? AND asset_code = ?').get(c.walletId, c.assetCode) as { total_units: string; reserved_units: string } | undefined;
    available = BigInt(b?.total_units ?? '0') - BigInt(b?.reserved_units ?? '0');
  }
  const shareBasis = `사용 가능 수량(보유 − 예약)의 ${fmtN(t.balanceSharePercent)}% 이상이면 주의(설계 가정)`;
  if (available <= 0n || amount > available) {
    // 비율 문제가 아니라 수량이 모자란 경우: 나누어 보내라는 안내 대신 두 수량과 예약 확인을 알린다(검토 단계에서 서버가 거부한다).
    check('balance_share', 'caution', '사용 가능 수량보다 많이 보내려고 합니다',
      `지금 사용 가능 수량(보유 − 예약)은 ${num(available < 0n ? 0n : available, c.precision)} ${unit}이고 이번 수량은 ${num(amount, c.precision)} ${unit}입니다. 이대로는 검토로 이동할 수 없습니다. 승인 대기 중인 다른 요청에 예약된 수량을 확인하고, 수량을 줄이거나 예약이 풀린 뒤 다시 요청하세요.`,
      shareBasis, true);
  } else {
    const permille = (amount * 1000n) / available;
    const pct = `${permille / 10n}${permille % 10n ? `.${permille % 10n}` : ''}%`;
    if (amount * 10000n >= available * x100(t.balanceSharePercent)) {
      check('balance_share', 'caution', '사용 가능 수량의 큰 부분을 한 번에 보냅니다',
        `사용 가능 수량 ${num(available, c.precision)} ${unit} 중 ${num(amount, c.precision)} ${unit}(${pct})를 보냅니다. 나누어 보내거나 소액 시험 전송을 먼저 하는 방법을 검토하세요.`,
        shareBasis, true);
    } else {
      check('balance_share', 'pass', `사용 가능 수량의 ${fmtN(t.balanceSharePercent)}% 미만입니다`,
        `사용 가능 수량 ${num(available, c.precision)} ${unit} 중 ${pct}를 보냅니다.`,
        shareBasis);
    }
  }

  // 4) 짧은 시간에 몰린 같은 자산 요청(F13). 상태와 관계없이 작성된 요청을 센다(시도 자체를 본다).
  const since = new Date(nowMs - t.burstWindowMinutes * 60_000).toISOString();
  const others = (db.prepare('SELECT COUNT(*) c FROM withdrawal_requests WHERE org_id = ? AND asset_code = ? AND id <> ? AND created_at >= ? AND created_at <= ?')
    .get(c.orgId, c.assetCode, c.requestId ?? '', since, nowIso) as { c: number }).c;
  const total = others + 1;
  const win = fmtN(t.burstWindowMinutes);
  const burstBasis = `최근 ${win}분 안에 같은 조직에서 작성된 같은 자산 출금 요청(이번 요청 포함, 상태 무관)이 ${t.burstCount}건 이상이면 주의(설계 가정)`;
  if (total >= t.burstCount) {
    check('recent_burst', 'caution', `최근 ${win}분 안에 같은 자산 출금 요청이 몰렸습니다`,
      `이번 요청을 포함해 ${unit} 출금 요청이 ${total}건입니다. 요청마다 요청자와 목적이 맞는지 따로 확인하세요.`,
      burstBasis);
  } else {
    check('recent_burst', 'pass', `최근 ${win}분 같은 자산 출금 요청 ${total}건`,
      `이번 요청을 포함해 ${unit} 출금 요청이 ${total}건으로 기준(${t.burstCount}건)보다 적습니다.`,
      burstBasis);
  }

  // 5) 시세(F8). 없거나 지연이면 확인 불가이며, 승인 요청 때는 고액 기준 승인 수가 적용된다(A-03).
  const p = readPrice(db, c.assetCode, policy.priceStaleAfterMinutes, nowMs, c.price);
  const stale = policy.priceStaleAfterMinutes;
  const highN = Math.max(policy.approval.highValueRequiredApprovals, policy.approval.defaultRequiredApprovals);
  const priceBasis = `모의 시세 기준. 시세가 없거나 기준 시각이 ${stale}분보다 오래되면 확인 불가(설계 가정)`;
  if (p.kind === 'missing') {
    check('price', 'unknown', '확인 불가(시세 없음)',
      `이 자산의 시세가 없어 원화 평가액을 확인할 수 없습니다. 이 경우 승인 요청 때 서로 다른 승인자 ${highN}명이 필요합니다.`,
      priceBasis);
  } else if (p.kind === 'stale') {
    check('price', 'unknown', '확인 불가(시세 지연)',
      `시세 기준 시각(${kstDateTime(p.asOf) || '알 수 없음'} KST)이 ${stale}분보다 오래되었거나 읽을 수 없어 원화 평가액을 믿을 수 없습니다. 이 경우 승인 요청 때 서로 다른 승인자 ${highN}명이 필요합니다.`,
      priceBasis);
  } else {
    let krw: string;
    try { krw = formatGrouped(krwValue(amount, c.precision, p.krwPrice).toString()); } catch { krw = '—'; }
    check('price', 'pass', `시세 기준 시각이 ${stale}분 이내입니다`,
      `모의 시세로 계산한 원화 평가액은 ${krw}원입니다(${kstDateTime(p.asOf)} KST 기준).`,
      priceBasis);
  }
  return out;
}

/**
 * 제출 본문의 진행 사유를 점검 목록에 붙인다.
 * 사유에서 보이지 않는 서식 문자(폭 없는 공백·방향 제어 문자 등 \p{Cf})를 지우고 앞뒤 공백을 없앤 뒤,
 * 글자·숫자가 5자 이상인지 센다(문장부호·공백만으로는 채울 수 없다). 사유가 필요한 주의 항목에 그런 사유가 없으면
 * 항목마다 필드 오류(checkReasons.<id>)를 담아 422 CHECK_REASON_REQUIRED로 거부한다.
 * 저장하는 사유도 서식 문자를 지운 값이다(승인자에게 보이지 않는 글자나 뒤집힌 글자가 섞이지 않게).
 * 기준 이내 항목의 사유는 버린다. 사유가 필요 없는 주의·확인 불가 항목에 적은 사유는 그대로 남긴다.
 */
export function attachCheckReasons(items: RequestCheck[], reasons: Partial<Record<string, string>> | undefined): RequestCheck[] {
  const r = reasons ?? {};
  const clean = (id: string) => stripFormatChars(String(r[id] ?? '')).trim();
  const missing = items.filter((i) => i.requiresReason && letterDigitCount(clean(i.id)) < CHECK_REASON_MIN_LENGTH);
  if (missing.length) {
    throw new AppError(422, 'CHECK_REASON_REQUIRED',
      `주의 항목 ${missing.length}건에 진행 사유가 필요합니다.`,
      `각 주의 항목 아래에 그대로 진행하는 이유를 글자·숫자 ${CHECK_REASON_MIN_LENGTH}자 이상으로 적어 주세요. 사유는 승인자에게 함께 보입니다.`,
      missing.map((i) => ({ field: `checkReasons.${i.id}`, message: `'${i.label}' 항목의 진행 사유를 글자·숫자 ${CHECK_REASON_MIN_LENGTH}자 이상으로 입력하세요.` })),
      { checkIds: missing.map((i) => i.id) });
  }
  return items.map((i) => {
    const reason = clean(i.id);
    return { ...i, reason: i.outcome !== 'pass' && reason ? reason : null };
  });
}

export interface StoredChecks { version: number; evaluatedAt: string; items: RequestCheck[] }

export function serializeChecks(evaluatedAt: string, items: RequestCheck[]): string {
  return JSON.stringify({ version: 1, evaluatedAt, items } satisfies StoredChecks);
}

/** 저장된 점검 결과. 이 기능 도입 전 제출분이나 읽을 수 없는 값은 null. */
export function parseStoredChecks(raw: unknown): StoredChecks | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || !Array.isArray(v.items) || typeof v.evaluatedAt !== 'string') return null;
    return { version: Number(v.version) || 1, evaluatedAt: v.evaluatedAt, items: v.items as RequestCheck[] };
  } catch {
    return null;
  }
}
