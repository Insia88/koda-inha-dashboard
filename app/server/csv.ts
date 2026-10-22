/**
 * 스프레드시트가 수식으로 읽을 수 있는 첫 글자(A3): = + - @, 탭, CR, LF, 그리고 전각 ＝ ＋ － ＠(U+FF1D·FF0B·FF0D·FF20).
 * 전각 기호는 일부 스프레드시트·입력기가 반각으로 바꿔 수식으로 읽는다. LF로 시작하는 값은 셀 안 첫 줄이 비고 둘째 줄이 수식처럼 보일 수 있다.
 */
export const FORMULA_START = /^[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]/u;

/**
 * 값 가운데에서 새 칸이 시작될 수 있는 자리(';' 또는 줄바꿈) 바로 뒤에 오는 수식 문자(A3 검토). 사이에 큰따옴표만 있어도 같다. 문자 묶음은 FORMULA_START와 같다.
 * 목록 구분 기호가 ';'인 지역 설정의 Excel(독일·프랑스 등. 한국어 Excel은 ',')은 이 파일의 ','가 아니라 ';'에서 칸을 나누고,
 * 칸 맨 앞의 '"'만 따옴표로 본다. 그래서 'x;=1+1' 같은 값은 ';' 뒤 조각 '=1+1'이 새 칸의 첫 글자가 되어 수식으로 읽힌다.
 * 같은 이유로 그 Excel에서는 칸 가운데의 줄바꿈도 따옴표 안으로 보지 않아 다음 줄이 새 행의 첫 칸이 된다.
 * 그 자리에도 작은따옴표를 넣는다('x;=1+1' → "x;'=1+1"). 이런 값이 아니면 내보낸 글자는 저장된 값과 같다.
 */
const FORMULA_AFTER_BREAK = new RegExp(`(;|\\r\\n|\\r|\\n)(?="*${FORMULA_START.source.slice(1)})`, 'gu');

/**
 * CSV 셀 보호: 수식으로 실행될 수 있는 값(FORMULA_START로 시작)에 작은따옴표를 붙이고, 가운데의 ';'·줄바꿈 바로 뒤에 오는 수식 문자 앞에도
 * 작은따옴표를 넣고, 따옴표·쉼표·줄바꿈이 있거나 작은따옴표로 시작하면 큰따옴표로 감싼다.
 * 내보낼 때의 글자 표현만 바꾼다. 저장된 값(감사 기록 행·해시)은 그대로다.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  s = s.replace(FORMULA_AFTER_BREAK, "$1'");
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
