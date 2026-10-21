/** CSV 셀 보호: 스프레드시트에서 수식으로 실행될 수 있는 값(=,+,-,@,탭,CR로 시작)에 작은따옴표를 붙인다. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || s.startsWith("'")) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  // Excel이 한글을 올바르게 열도록 UTF-8 BOM을 붙인다.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * 표지가 붙은 CSV(감사 기록 내보내기, A2-4): BOM → 표지 행들 → 빈 줄 하나 → 머리글 → 행.
 * 빈 줄이 표 범위를 나누므로 스프레드시트의 정렬·필터는 아래 표에만 걸린다. 프로그램으로 읽을 때 머리글은 빈 줄 다음 첫 줄이다.
 * 표지 셀도 모두 csvCell을 거쳐 수식으로 실행되지 않는다.
 */
export function toCsvWithCover(cover: unknown[][], header: string[], rows: unknown[][]): string {
  const line = (r: unknown[]) => r.map(csvCell).join(',');
  return '﻿' + [...cover.map(line), '', line(header), ...rows.map(line)].join('\r\n') + '\r\n';
}

/** 한국 표준시(KST)는 UTC+9이며 일광 절약 시간이 없다. */
const KST_OFFSET_MS = 9 * 3600_000;

/**
 * ISO 시각 → 한국 시간 문자열. 기본 'YYYY-MM-DD HH:mm', seconds면 'YYYY-MM-DD HH:mm:ss'.
 * 감사 기록 CSV와 서버 안내 문구(사용 가능 시각 등)가 같은 형식을 쓴다. 읽을 수 없는 값은 원래 문자열을 그대로 돌려준다.
 */
export function kstDateTime(iso: string | null | undefined, opts: { seconds?: boolean } = {}): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const s = new Date(t + KST_OFFSET_MS).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, opts.seconds ? 19 : 16)}`;
}
