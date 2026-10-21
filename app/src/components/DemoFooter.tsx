import './demo-footer.css';

/** 공개 데모 화면 맨 아래 한 줄의 문구(A5, DEC-004). 저장소 소유자가 정한 문구 그대로 쓴다. */
export const DEMO_FOOTER_TEXT = '모의 데이터 · KODA 공식 서비스 아님';

/**
 * 공개 데모의 모든 화면(로그인 포함) 맨 아래에 두는 작은 한 줄(A5). 예전 상단 띠와 로그인 화면의 '공개 데모입니다' 안내 상자를 대신한다.
 * - 고정하지 않고 문서 흐름의 맨 끝에 둔다. 내용·포커스를 가리지 않고(WCAG 2.4.11), 짧은 화면에서는 셸·로그인 화면의 최소 높이로 화면 아래 끝에 붙는다.
 * - `<footer>`라 contentinfo 랜드마크다. 알림 영역이 아니고 처음 그린 뒤 바뀌지 않으므로 화면 낭독기가 되풀이해 읽지 않는다.
 * - 로컬 실행에는 그리지 않는다. 로컬은 상단 개발 환경 띠를 그대로 쓴다(DESIGN.md '고지·환경 표시': 운영 연동 전에는 없애지 않음).
 * - 메뉴 서랍이 열려 있는 동안에는 서랍 밖이라 inert다(Layout.tsx OUTSIDE_DRAWER).
 */
export function DemoFooter() {
  return <footer className="demo-footer">{DEMO_FOOTER_TEXT}</footer>;
}
