# KODA 대시보드 작업 상태

갱신: 2026-10-19 (회차 5 완료 — review-20261019-0300 사용자 문구 정리)

## 기준 사실
- 브랜치: `feat/enterprise-dashboard-app` (main 5d7ab25에서 분기). 로컬 커밋만 있음(푸시·PR·main 병합 안 함).
- 커밋 작성자: 저장소에 git 사용자 설정이 없어 `-c user.name="KODA build agent" -c user.email="agent@localhost.invalid"` 사용(전역 설정 변경 안 함).
- Notion/Drive 연결 도구 없음 → 로컬 사본(context/)만 사용. 최신 Notion/Drive 변경은 확인하지 못함.
- 원본 앱 없음 → `app/`에 새로 구축(Fastify + node:sqlite + React/Vite + TanStack Query).

## 회차 5 결과 (review-20261019-0300: 사용자 화면 문구 2곳, 동작 변경 없음)
- app/src/pages/InsightsManage.tsx 머리말 설명: '화이트리스트 기관의 자료만 게시할 수 있습니다(서버에서 검사). 운영 기준은 config/insight-policy.json 설정으로 분리되어 있습니다.' → '게시가 허용된 기관의 자료를 올리고 공개 상태를 관리합니다.' 화이트리스트·모의 데이터 안내 상자와 서버 화이트리스트 검사(server/app.ts)는 그대로 유지. 설정 파일 경로는 개발/운영 문서에만 남음.
- app/src/pages/Org.tsx: 자기 승인 금지 문장 끝의 '(서버에서 검사)'만 제거. 의미 유지.
- 검증(범위 한정): typecheck exit 0, build 통과. 실제 Chromium으로 /insights/manage(u-k-op), /org(u-a-yoon)를 1440·390px 렌더 → 새 문구 표시, 화면 본문에 '서버에서 검사'·'insight-policy'·'config/' 없음, 화이트리스트/모의 고지 유지, 가로 넘침 없음, 콘솔 오류 0. 스크린샷 app/artifacts/screenshots/copy-{insights-manage,org}-{desktop,mobile}.png, copy-insights-manage-mobile-top.png. 기존 테스트는 이 문자열을 참조하지 않음(grep 확인) → e2e·단위 테스트는 지시대로 재실행·변경하지 않음.
- 참고(범위 밖, 미수정): 로컬 개발 DB에 이전 E2E로 인사이트 게시물이 누적돼 관리 화면 목록이 길다. `npm run db:reset`으로 초기화.

## 회차 4 결과 (review-20261019-0230: 인사이트 메타데이터만 변경 시 입력 유실)
- 원인: InsightsManage의 dirty가 제목·요약·원문 주소만 검사 → 기관·발행일·언어만 바꾸면 인앱 이동·창 닫기 보호가 없었음.
- 수정(app/src/pages/InsightsManage.tsx): 전체 폼을 기준값(최초 값 또는 마지막 게시 성공 뒤 값)과 비교(본문은 trim 비교). 같은 dirty를 인앱 이동·beforeunload에 사용. 게시는 제출 스냅샷으로 보내고 게시 중 입력을 fieldset disabled로 잠금 → 성공 시 스냅샷의 기관·발행일·언어를 유지한 값을 새 깨끗한 기준으로 설정. 실패 시 입력·보호 유지. 성공 안내는 다시 작성 중이면 숨김. 부수 수정: 기본 발행일을 UTC가 아닌 기기 기준 오늘로(한국 0~9시 전날 표시 방지). CSS .form-lock(레이아웃 변화 없음, 스크린샷 확인).
- 검증: e2e/insight-guard.spec.ts 6건 신규(기관만/발행일만/언어만 이탈 확인·계속 작성 값 유지·버리기, 되돌리면 경고 없음, 세 항목 각각 beforeunload, 깨끗할 때 beforeunload 없음, 500 실패 뒤 값·보호 유지, 게시 중 잠금, 성공 뒤 메타데이터 유지·경고 없음·재변경 시 보호). 이전 코드에서 5/6 실패, 수정 후 6/6 통과 확인. 전체 npm run e2e 37/37(기존 31 + 6), typecheck 0, npm test 39/39(서버 변경 없음, 회귀 확인용 1회), build 통과, strict audit 0건. 스크린샷 artifacts/screenshots/insight-manage-{guard,locked}-{desktop,mobile}.png 콘솔 오류 0·가로 넘침 없음.
- 다른 폼(요청 작성·수정, 주소 등록, 반려 사유)은 이미 전체 폼을 기준값과 비교함을 코드로 확인(UX-CONTRACT.md에 dirty 기준 명시).

## 회차 3 결과 (검수 1~6 항목)
1. 브라우저 confirm() 제거 → 공통 `ConfirmDialog`(src/components/Dialog.tsx, 네이티브 dialog.showModal): 주소 사용 중지·요청 취소. 대상·되돌릴 수 없음·실행 동사, 안전한 선택 초기 포커스, Tab 순환, 배경 inert, Escape, 처리 중 중복 확정·닫힘 차단, 실패 시 대화상자 안 오류, 닫힌 뒤 트리거(없으면 h1) 포커스.
2. `useUnsavedGuard`(src/lib/unsaved.tsx): 출금 요청 작성·수정, 주소 등록, 인사이트 게시, 반려 사유. 인앱 이동은 앱 대화상자, 창 닫기는 작성 중일 때만 beforeunload, 저장 성공 이동은 경고 없음. 세션 만료 시 작성 중이면 같은 계정 재로그인 대화상자(입력은 메모리에만, 브라우저 저장소 보관 없음). `Field`가 aria-invalid/aria-describedby 자동 연결, `useFocusFirstError`로 첫 오류 포커스.
3. `SearchField`(300ms debounce, IME 조합 중 조회 없음, Enter·지우기·Escape 즉시, 지우기 후 포커스) 5개 목록 적용 + 목록 조회에 AbortSignal 전달.
4. 정적 audit 20건 → 0건(strict exit 0): 검색 form noValidate, 공통 `TextareaAuto`(resize none + 자동 높이·상한 내부 스크롤), premium-ui.json + app/UX-CONTRACT.md(native select/date 소유권 근거·검증), 경로별 document.title, 전역 scrollbar 기준, 복사 실패 안내. 참고: 공통 컴포넌트 이름이 'Textarea'이면 감사기가 대소문자를 무시해 사용처를 literal textarea로 보므로 이름을 TextareaAuto로 정함(규칙 약화 아님, 실제 resize none은 E2E로 확인).
5. 홈: 1100px 이하에서 '지금 처리할 일 → 보유 자산 → 진행 중인 요청 → 최근 활동' 순서(보유 자산 카드는 폭별로 하나만 표시).
- 검증 중 새로 발견해 수정: (a) 제어형 날짜 입력의 React value 동기화가 Chrome 칸 입력을 초기화해 두 자리 일(15)을 입력할 수 없음 → `DateInput` owner; (b) 데스크톱 Chrome 390px에서 셸 그리드 1fr로 11px 가로 넘침(기존 결함) → minmax(0,1fr); (c) 모바일 수량 단위 'USDC' 줄바꿈; (d) 늘어난 E2E가 개발용 로그인 한도(30/분)에 걸림 → LOGIN_RATE_LIMIT_MAX 설정화(기본 30 유지, E2E 서버만 300) + API 테스트 추가.
- flow.spec 검색 단계는 확정된 검색어(URL 반영)를 기다리게 보완. blur 시 즉시 확정은 클릭 직전에 결과 목록이 바뀌어 다른 주소를 누를 위험이 있어 의도적으로 하지 않음(UX-CONTRACT.md).

## 완료 (누적)
- 서버: 개발용 로그인(운영 모드 기동 거부), 역할·조직 권한(서버), CSRF, 요청 한도, 보안 헤더, 감사 로그(해시 체인 + UPDATE/DELETE 금지 트리거), 주소록(형식·중복·유사 주소·끝자리 재입력·2인 확인), 출금 요청 상태기계, 자기 승인 금지(API+DB), 2인 승인 정책, 멱등성, 낙관적 잠금, 수량 예약, 모의 커스터디, CSV 수식 무력화, Market Insight 화이트리스트, 실험 플래그(기본 꺼짐).
- 화면: 로그인·홈·잔고·활동·요청·주소록·지갑·스테이킹·토큰·조직·감사·인사이트·인사이트 관리. URL 상태 유지, 로딩/오류/권한 없음/빈 상태, 위 회차 3 상호작용 계약.
- 문서: app/README.md, DESIGN.md, UX-CONTRACT.md, THIRD_PARTY_NOTICES.md, docs/{api,assumptions,traceability,tab-design,operations,experiments}.md.

## 검증 결과 (회차 3 기준; 회차 4 재실행 결과는 위 회차 4 항목)
- `npm run check`(typecheck·test·build) 통과. `npm test` 39/39.
- `npm run e2e` 31/31 통과(기존 22 + e2e/interaction.spec.ts 9). 마지막 CSS 수정 뒤 a11y+responsive 16/16 재통과(axe 15화면 위반 0).
- 정적 audit: frontend-design-premium audit_project.py app --mode strict → 0건(app/artifacts/premium-audit.json).
- 스크린샷: scripts/screens.mjs 45장 콘솔 오류 0, scripts/screens-states.mjs(state-*.png; 의도된 422 외 오류 0). 모바일 홈·대화상자·폼 오류·검색 직접 확인.
- 미실시: 실제 사용자 테스트·3초 이해도 측정, 스크린리더 실사용, 운영 SSO·커스터디 연동. 네이티브 select/date 팝업 모양은 브라우저 소유(UX-CONTRACT.md에 수용 근거).

## 실행
```
cd app && npm ci && npm run db:reset && npm run build && npm start   # http://127.0.0.1:4300
npm test ; npm run build && npm run e2e ; node scripts/screens.mjs ; node scripts/screens-states.mjs ; bash scripts/stop-server.sh
<bundled python> <frontend-design-premium>/scripts/audit_project.py . --mode strict --output artifacts/premium-audit.json
```
- CI: .github/workflows/app-check.yml (PR 시 typecheck·test·build·e2e).

## 대기(WAIT) 근거
회차 5: review-20261019-0300의 사용자 문구 2곳을 정리하고 typecheck/build·실제 화면 렌더로 확인했다. 운영 도입 전 외부 연동 조건은 그대로 남아 있다: 운영 SSO·재인증, 커스터디 테스트 환경 연동, 실제 KODA 역할·상태·승인 정책, 주소 검증 규칙, 인사이트 운영 기준, 운영 DB·감사 보존 정책, 실사용자 검증(app/docs/operations.md).
검수 review-20261019-0230의 인사이트 입력 유실 결함을 수정하고 신규·전체 브라우저 검사, typecheck/build/정적 audit를 통과했다(회차 4). 그 전 검수 review-20261019-0130의 로컬 결함 1~5와 검증 중 새로 발견한 결함 4건을 구현·수정했고, 6의 브라우저 검사·영향 검사·typecheck/build/정적 audit가 모두 통과했다. 이전 수용 기준(DASH-001~007, 권한·격리·자기 승인·전이·멱등·동시성·정밀도·감사 불변·CSV·오류·새로고침·E2E·반응형·접근성 자동 검사)도 재통과. 남은 항목은 외부 자료·환경이 필요하므로 범위를 임의로 넓히지 않고 대기한다.

## 남은 항목 / 다음 작업
- 외부 자료 필요(차단): 실제 역할·상태·승인 정책, 주소 검증 규칙, 인사이트 운영 기준, 익명화 인터뷰, SSO 재인증·커스터디 테스트 환경, 운영 DB/감사 보존 정책, 실사용자 검증 (app/docs/operations.md).
- 선택 개선 후보(요구사항 미명시): 요청 목록 금액 정렬, 감사 CSV 스트리밍, 주소 수정 흐름, 주소록 대량화 시 검색형 Combobox 재판단.
