# UX-CONTRACT — KODA 법인 대시보드

`DESIGN.md`(시각 규칙)와 함께 유지한다. 아래 표는 반복되는 상호작용의 **단일 소유자(canonical owner)** 다. 화면에서 같은 동작을 따로 만들지 않고 이 소유자를 쓰거나 이름 있는 변형으로 확장한다. 정적 검사(`premium-ui.json` + audit)는 소유권 기록만 확인하며, 실제 동작은 각 행의 Verification 검사로 확인한다.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | native `<select>` + 공통 `Field`(레이블·aria-invalid·도움말 연결); 목록 도구막대는 sr-only 레이블 | DESIGN.md 폼 · 이 문서 | form-field / toolbar-filter | e2e/interaction.spec.ts 키보드 선택(ArrowDown) → URL 반영, 모바일 폭 넘침 없음; axe |
| Date | native `<input type="date">` (날짜만, 시간대 변환 없이 `YYYY-MM-DD` 문자열로 서버 전달) | 이 문서 · server 기간 필터 | toolbar-range(시작/종료, min/max 상호 제한) / form-field(발행일) | e2e/interaction.spec.ts ko-KR 키보드 입력 → URL·결과 반영, 390px 폭 넘침 없음 |
| Form | `Field`·`TextareaAuto`(src/components/ui.tsx), `useFocusFirstError`(src/lib/forms.ts), `useUnsavedGuard`(src/lib/unsaved.tsx), 서버 zod 검증(422 fields) | server 검증 스키마 · DESIGN.md 폼 | create(출금 요청·주소·인사이트) / edit(요청 수정) / action-panel(검토·승인·반려) | e2e/interaction.spec.ts 첫 오류 포커스·aria-invalid, 네트워크/500/세션 만료 뒤 입력 유지, 이탈 확인; e2e/insight-guard.spec.ts 메타데이터만 변경 시 보호; tests/api.test.ts 서버 검증 |
| Scrollbar | `src/styles.css` `:root` 표준 `scrollbar-width`/`scrollbar-color` + `scrollbar-gutter: stable` | DESIGN.md 기타 전역 규칙 | 없음(표 가로 스크롤은 기하 예외만) | e2e/interaction.spec.ts computed style |
| Toast | 토스트 없음 — 화면 안 `Notice role="status"`(성공) / `ApiErrorNotice role="alert"`(실패, 원인+복구 행동) | DESIGN.md 상태 표현 · shared/terms.ts | success / info / warning / danger | e2e/flow.spec.ts 성공 안내, e2e/interaction.spec.ts 오류 안내; axe |
| CRUD | 라우트 `목록 → 상세(state.back으로 목록 URL 복귀) / 작성 → 상세(replace)`; 파괴적 행동은 `ConfirmDialog`(src/components/Dialog.tsx) | 이 문서 · docs/api.md | return-to-list(뒤로) / stay(상세에서 상태 전이) | e2e/flow.spec.ts 수직 흐름·필터 복귀, e2e/interaction.spec.ts 대화상자 취소/확정/포커스 |

### 적용하지 않는 항목
- **Table Selection**: 다건 선택·일괄 처리를 두지 않는다. 출금 승인·주소 확인은 건별 대조가 안전 장치이므로 일괄 승인은 설계 가정상 제외(docs/assumptions.md A-34). 행은 상세로 이동하는 링크다.

## 소유권 결정 근거

### Native select (Select/Listbox = native)
- 선택지는 짧은 고정 목록(자산·네트워크·상태·정렬·페이지 크기)이고 검색형 콤보박스가 필요하지 않다. 플랫폼 팝업은 OS 화면 낭독기·모바일 휠 선택기·키보드(↑↓, 첫 글자 이동)를 그대로 제공한다.
- 받아들이는 제약: 팝업 모양·위치는 브라우저가 정한다(디자인 토큰 미적용). 옵션 문구가 길면 잘릴 수 있어 옵션은 「코드 · 이름」 정도로 짧게 유지한다.
- 주소 선택(출금 요청)은 선택 뒤 **주소 대조 띠**로 전체 주소를 다시 보여 주므로 옵션에 주소를 넣지 않는다.
- 운영 데이터에서 주소록이 수백 건이 되면 검색형 authored Combobox로 바꾸는 것을 다시 판단한다(현재 모의 데이터 규모에서는 미측정).

### Native date (Date = native)
- 기간 필터와 발행일은 날짜만 다룬다. 값은 `YYYY-MM-DD` 그대로 서버에 보내고 서버가 KST 기준 하루 범위로 해석한다(시간대 변환 없음).
- 표시 형식은 브라우저 언어 설정을 따른다(한국어 Chrome: `연도. 월. 일.`). 직접 타이핑과 달력 팝업 둘 다 가능하다. 받아들이는 제약: 달력 팝업 모양·한국어 요일 표기는 브라우저 소유.
- 시작일·종료일은 화면에서 `min`/`max`로 서로를 제한한다. 서버는 `YYYY-MM-DD`가 아닌 값을 무시하고, 시작일이 종료일보다 늦으면 결과가 비어 빈 결과 안내(필터 초기화)를 보인다.

## 상호작용 규칙 요약
- 검색: `SearchField`(src/components/SearchField.tsx) — 300ms debounce(`SEARCH_DEBOUNCE_MS`), IME 조합 중 조회 금지, Enter·지우기 즉시, 지우기 후 입력 포커스. 조회는 TanStack Query 키(URL 쿼리)별로 캐시되고 AbortSignal로 취소되어 늦게 온 이전 결과가 현재 결과를 덮지 않는다.
- 대화상자: `ConfirmDialog` — 안전한 선택 초기 포커스, Tab 순환, 배경 inert, Escape=취소(안전한 선택이 취소일 때만), busy 중 닫힘·중복 확정 금지, 실패 시 대화상자 안 오류, 닫힌 뒤 트리거(없으면 h1) 포커스.
- 작성 보호: `useUnsavedGuard(dirty)` — 인앱 이동 확인, beforeunload는 작성 중일 때만, 저장 성공 이동은 `allowNavigation()`.
- dirty 기준: 각 폼은 선택 항목(메타데이터) 포함 전체 입력을 기준값(최초 값 또는 마지막 저장 성공 뒤 값)과 비교한다. 인사이트 게시는 기관·발행일·언어만 바꿔도 작성 중이며, 게시 중에는 입력을 잠그고(fieldset disabled) 성공 시 제출 스냅샷에서 유지한 메타데이터를 새 기준으로 삼는다(e2e/insight-guard.spec.ts).
- 세션 만료: 작성 중이 아니면 로그인 화면(`next`로 복귀), 작성 중이면 같은 계정 재로그인 대화상자(src/auth.tsx).
- 문서 제목: `useDocumentTitle`/`PageHeader`.
