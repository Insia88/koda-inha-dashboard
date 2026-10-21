import { formatGrouped } from '../shared/decimal.ts';

const KST = 'Asia/Seoul';

export function amount(decimal: string | null | undefined, unit?: string) {
  if (decimal === null || decimal === undefined) return '—';
  return `${formatGrouped(decimal)}${unit ? ' ' + unit : ''}`;
}

/** 원화: 1억 이상은 "12.34억 원" 보조 표기와 함께 정확한 원 단위를 유지한다. */
export function krw(value: string | null | undefined) {
  if (value === null || value === undefined) return '—';
  return `${formatGrouped(value)}원`;
}

export function krwShort(value: string | null | undefined) {
  if (!value) return '—';
  const v = BigInt(value);
  if (v >= 100_000_000n) {
    const eok = v / 1_000_000n; // 0.01억 단위
    const s = (Number(eok) / 100).toFixed(2).replace(/\.?0+$/, '');
    return `약 ${s}억 원`;
  }
  if (v >= 10_000n) return `약 ${formatGrouped((v / 10_000n).toString())}만 원`;
  return `${formatGrouped(value)}원`;
}

function parts(d: Date, withTime: boolean) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: KST, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}${withTime ? ` ${p.hour}:${p.minute}` : ""}`;
}

/** 2026-10-19 14:03 (KST) */
export function dateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return parts(new Date(iso), true);
}

export function date(iso: string | null | undefined) {
  if (!iso) return "—";
  return parts(iso.length === 10 ? new Date(`${iso}T12:00:00+09:00`) : new Date(iso), false);
}

export function relative(iso: string | null | undefined) {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  const m = Math.round(diff / 60000);
  if (m < 1) return '방금 전';
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}
/**
 * 기다린 시간(A2-1): 'n분째'·'n시간째'·'n일째'. 내림으로 계산한다(4시간 59분 → '4시간째'). 1분이 안 되면 '1분째'(첫 1분 안).
 * 지연 기준·색은 두지 않는다(만료·지연 판단은 KODA 결정). 화면은 <time dateTime>과 KST 절대 시각 title을 함께 붙인다(WaitedTime).
 */
export function waited(iso: string | null | undefined, nowMs = Date.now()) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(1, Math.floor((nowMs - t) / 60000));
  if (m < 60) return `${m}분째`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간째`;
  return `${Math.floor(h / 24)}일째`;
}

/** 지급 근거 파일 크기 표시('67B'·'182KB'·'1.5MB'). 서버의 감사 기록 문구와 같은 함수다. */
export { fileSizeLabel } from '../shared/attachments.ts';
