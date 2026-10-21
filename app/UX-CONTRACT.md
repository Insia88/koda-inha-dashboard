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
| File attach | `PaymentEvidenceEditor`(src/components/PaymentEvidence.tsx): native `<input type="file" multiple>`(숨김)을 여는 보이는 「파일 추가」 버튼, 보내기 전 크기·앞부분 형식 확인, 파일마다 원본 바이트 POST(`uploadAttachment`, src/api.ts)를 차례로, 진행은 `role="status"`, 실패는 한 `Notice role="alert"` 목록; 삭제는 `ConfirmDialog`(destructive); 내려받기는 `downloadFile`(오류는 화면 안 안내) | DESIGN.md '지급 근거' · shared/attachments.ts · docs/api.md 'A2b: 지급 근거' | owner-editor(요청자, 작성·검토 중) / read-only(card·decide) | e2e/a2b-attachments.spec.ts 첨부·거부·삭제·고정·내려받기·390px·axe; tests/attachments.test.ts 서버 검증 |

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
- 대화상자: `ConfirmDialog` — 안전한 선택 초기 포커스, Tab 순환, 배경 inert, Escape=취소(안전한 선택이 취소일 때만), busy 중 닫힘·중복 확정 금지, 실패 시 대화상자 안 오류, 닫힌 뒤 트리거(없으면 h1) 포커스. 열릴 때 150ms 동안 4px 자리 잡기와 바탕 어두워짐만 있고(포커스는 바로 옮김), 닫힘은 즉시다(A4, 줄인 움직임이면 움직이지 않음, DESIGN.md 모션).
- 메뉴 서랍(860px 이하): `Layout`(src/components/Layout.tsx) — 열면 첫 메뉴로 포커스, 서랍은 머리글 아래에서 시작해 토글(「메뉴 닫기」)이 늘 보이고 누를 수 있음, 서랍 밖(건너뛰기 링크·환경 띠·머리글의 다른 요소·본문) inert, Tab·Shift+Tab은 토글과 메뉴 사이에서 순환, Escape·막 클릭·토글로 닫으면 토글로 포커스, 메뉴 링크를 고르면 먼저 토글로 포커스를 돌려준 뒤 이동해 화면이 바뀌면 새 화면 h1 포커스, 같은 경로이거나 작성 중 이탈 확인에서 「계속 작성」을 고르면 토글에 남음(A3·A3 검토, e2e/a3-a11y.spec.ts). 여는 것만 240ms 미끄러져 들어오고(포커스는 열자마자 옮김) 닫힘은 즉시다(A4, 예전에는 열 때 200ms였고 닫을 때는 `visibility`로 즉시 숨겼다). 줄인 움직임이면 움직이지 않는다.
- 보기 전환(한 목록 거르기): 탭 역할(tablist·tab)을 쓰지 않고 `role="group"` + `aria-pressed` 버튼 묶음(상태 칩과 같은 방식). 결재 및 요청 '요청 보기'(A3). 좁으면 줄을 바꾼다.
- 알림 영역(A3에서 바꾼 화면): 출금 요청 작성(수량 미리 보기 `<output>`·출금 전 점검 요약 `.rc-live`), 주소 등록(형식 점검 `Findings`), 결재 및 요청(결과 줄 `.req-result`)의 알림 영역은 처음부터 빈 채로 그리고 내용만 바꾼다(`.live-slot:empty`는 빈 동안 자리를 차지하지 않음). 긴 목록은 알리지 않고 요약 한 줄만 알린다(출금 전 점검 미리 보기). 결재 및 요청 결과는 늘 있는 결과 줄이 0건까지 알린다. 새 결과·새 미리 보기를 불러오는 동안은 앞 문장을 그대로 둔다(빈 글자·앞 결과의 건수를 끼워 쓰지 않음, A3 검토). 새로 만들거나 바꾸는 알림 영역도 이 규칙을 따른다. 자산 활동 내역·감사 기록 목록은 아직 페이지 줄(`Pagination`의 `aria-live`)만 알려 0건이면 알림 영역이 목록과 함께 사라지고, 주소록·마켓 인사이트·인사이트 자료 관리의 결과 건수 줄은 데이터를 받은 뒤에야 그려진다(R5 범위 밖, 후속).
- 작성 보호: `useUnsavedGuard(dirty)` — 인앱 이동 확인, beforeunload는 작성 중일 때만, 저장 성공 이동은 `allowNavigation()`.
- 한 화면에 이동 확인(`useBlocker`)은 하나만 둔다. 요청 상세는 지급 근거 메모 입력값과 파일을 올리는 중인지를 화면이 갖고, 내용 수정·반려 사유·진행 사유와 함께 그 화면의 `useUnsavedGuard` 하나에 합친다(A2b).
- dirty 기준: 각 폼은 선택 항목(메타데이터) 포함 전체 입력을 기준값(최초 값 또는 마지막 저장 성공 뒤 값)과 비교한다. 인사이트 게시는 기관·발행일·언어만 바꿔도 작성 중이며, 게시 중에는 입력을 잠그고(fieldset disabled) 성공 시 제출 스냅샷에서 유지한 메타데이터를 새 기준으로 삼는다(e2e/insight-guard.spec.ts).
- 세션 만료: 작성 중이 아니면 로그인 화면(`next`로 복귀), 작성 중이면 같은 계정 재로그인 대화상자(src/auth.tsx).
- 문서 제목: `useDocumentTitle`/`PageHeader`.
