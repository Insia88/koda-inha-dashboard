/** CSV 셀 보호: 스프레드시트에서 수식으로 실행될 수 있는 값(=,+,-,@,탭,CR로 시작)에 작은따옴표를 붙인다. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || s.startsWith("'")) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  // Excel이 한글을 올바르게 열도록 UTF-8 BOM을 붙인다.
  return '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}