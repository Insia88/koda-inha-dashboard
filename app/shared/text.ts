// 사람이 읽고 판단하는 글(사유·메모·이름)의 공통 규칙. 서버(입력 검증·처리)와 화면(보내기 전 점검)이 같은 기준을 쓴다.
// 화면 번들에 검증 라이브러리(zod)를 끌어오지 않도록 이 파일은 아무것도 가져오지 않는다(shared/schemas.ts가 다시 내보낸다).

/**
 * 보이지 않는 서식 문자(\p{Cf}: 폭 없는 공백 U+200B, 방향 제어 문자 U+202E, BOM 등)와, 글자로 분류되지만 화면에
 * 아무것도 보이지 않는 채움 문자(한글 채움 U+115F·U+1160·U+3164·U+FFA0, 점자 빈칸 U+2800)를 지운다.
 * 사람이 읽고 판단하는 글(사유·메모·이름)에 보이지 않거나 뒤집혀 보이는 글자가 섞이지 않게 한다.
 */
const INVISIBLE_CHARS = /[\p{Cf}ᅟᅠㅤﾠ⠀]/gu;
export function stripFormatChars(s: string): string {
  return s.replace(INVISIBLE_CHARS, '');
}

/** 글자(\p{L})와 숫자(\p{N})의 개수. 공백·문장부호·기호·보이지 않는 문자는 세지 않는다. */
export function letterDigitCount(s: string): number {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/** 사람이 읽고 판단하는 글(사유·메모·이름): 보이지 않는 서식 문자를 지우고 앞뒤 공백을 없앤 값. 저장·감사 기록에도 이 값을 쓴다. */
export function cleanText(s: string): string {
  return stripFormatChars(s).trim();
}

/** 필수 사유·메모의 최소 글자 수(설계 가정). 글자·숫자만 센다. */
export const REASON_MIN_LETTERS = 5;

/**
 * 필수 사유·메모 점검(cleanText를 거친 값 기준). 맞으면 null, 모자라면 보일 문구.
 * - 지운 뒤 길이가 min자보다 짧다(빈 값, 폭 없는 공백만 넣은 값 등): short 문구
 * - 길이는 되지만 글자·숫자가 min자보다 적다(문장부호·공백만 넣은 값 등): '<label>에 글자·숫자를 N자 이상 넣어 주세요.'
 */
export function reasonError(cleaned: string, opts: { label: string; short: string; min?: number }): string | null {
  const min = opts.min ?? REASON_MIN_LETTERS;
  if (cleaned.length < min) return opts.short;
  if (letterDigitCount(cleaned) < min) return `${opts.label}에 글자·숫자를 ${min}자 이상 넣어 주세요.`;
  return null;
}
