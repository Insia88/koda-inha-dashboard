# 문제 → 개선 → 요구사항 → 검증 결과 (DASH-006)

"검증"은 이 저장소의 자동 테스트·실제 브라우저 확인 결과다. **실제 사용자 테스트·인터뷰는 수행하지 않았으며**, 개선율·소요 시간 등 효과 수치는 측정하지 않았다. 아래 "기대 효과"는 모두 검증 전 가설이다.

상태 표기: **해결**(프로토타입에서 문제 상황을 막거나 바꿨고 테스트가 있음) · **일부**(일부만 바뀌었거나 화면이 남음) · **미해결**(바꾸지 않음, 이유 기록) · **가설**(효과를 측정하지 않은 설계 판단). 검증 칸에는 테스트 이름을 적고, 자동 검사가 없으면 '검증 안 됨'으로 적는다. 설계 가정 ID(A-xx)는 `assumptions.md`, 제안 ID(DEC-xxx)는 `../../docs/decisions.md`.

## 출처

| ID | 자료 | 인용 방식 |
| --- | --- | --- |
| S1 | 2026-10-16 방문 녹취 | 녹음 경과 시각 (`../../docs/dashboard.md`의 S1) |
| S2 | 산학과제 Notion 허브 및 방문노트 | 페이지·기록 이름 (`dashboard.md`의 S2) |
| S3 | KODA 고객 대시보드 이용가이드 (PDF 47쪽, 2025-10-23판) | **PDF 쪽 번호(p.N)만** 적는다. 기밀 고지가 있는 자료라 문구·화면 캡처·예시 데이터(이름·이메일·주소·금액)를 옮기지 않고 요지만 우리 말로 적는다. 원본과 분석 노트는 저장소 밖 로컬 자료로만 둔다. |
| R1 | 독립 검수 (2026-10-19, 코드 대조) | 검수 항목 ID(예: COV-04, SEC-02). 원자료는 저장소 밖 로컬 자료 |

## 방문 논의·검수에서 나온 문제

| 기존 문제 (출처) | 개선 | 요구사항 | 검증 결과 (2026-10-19) |
| --- | --- | --- | --- |
| 첫 화면에서 자산·처리할 업무·다음 행동을 구분하기 어려움 (S1 1:09:39–1:13:40, 설계 가설 OPEN-001) | 홈을 "지금 처리할 일(역할별 건수·이동)", "보유 자산(평가액+기준 시각·출처·상태)", "진행 중인 요청(4단계 레일)", "최근 활동"으로 분리 | DASH-001 | E2E `수직 흐름`에서 홈의 세 영역 노출 확인. 데스크톱·태블릿·모바일 스크린샷 확인. 3초 이해 여부는 사용자 측정 없음 |
| 평가액만 있고 기준 시각·데이터 상태가 없음 | 시세 기준 시각(KST)·출처·'모의 데이터/시세 지연/시세 없음' 배지, 잔고 기준 시각 별도 | DASH-001 | API `priceState` 구현, 화면 확인. 지연 상태는 `MOCK_PRICE_FEED=off`로 수동 확인 대상 |
| 용어·상태가 비전문 이용자에게 어려움 (S1 1:06:46–1:13:40, R1 COV-07) | 용어·상태 설명 단일 출처(`shared/terms.ts`), 용어 설명 버튼, 오류마다 원인+복구 행동. 2026-10-19 용어 추가: 커스터디 처리·화이트리스트·스테이킹·검증인·해제 대기·데스티네이션 태그·되돌릴 수 없는 전송·승인 x/y·토큰과 자산. 스테이킹 화면에 스테이킹·검증인·해제 대기 설명 버튼 | DASH-002 | API 테스트 `오류 응답`: 모든 오류에 message·action, 스택 노출 없음. `glossary.test.ts` 8건(필수 용어, 상태 설명, 안전 보장 표현 없음, 확인 안 된 날짜 없음). E2E 접근성 `/staking`·`/tokens`. 이해 여부는 사용자 측정 없음 |
| 잘못된 주소·네트워크 선택 위험, 육안 검증 어려움 (S1 1:07:48–1:13:40) | 네트워크 불일치 즉시 안내(추정 네트워크 표시), 같은 형식 네트워크 경고, 메모/태그 필수 검사, 유사 주소 경고, 4자 묶음 대조 띠, 원본 보고 끝자리 재입력, 2인 확인, "안전성 보증 아님" 고지. 2026-10-19: 등록·확인 때 가운데 8자리 재입력(A-05), 유사 주소 lookalike-v2·전 상태 비교·사유/메모 필수·확인 때 재점검(A-07), 다른 부분을 강조한 두 주소 비교 | DASH-003 | 단위 `address rules`·`look-alike rule (lookalike-v2)`·`middle segment`, API `주소록` 5건(`rejects a wrong middle segment at create and at review (CONFIRM_MIDDLE_MISMATCH)` 포함), `address-protection.test.ts` 12건, E2E `수직 흐름`·`유사 주소: 등록자는 비교를 보고 사유를 남기고, …` |
| 요청·승인 단계와 역할별 행동이 불분명 (S1 14:35–19:39) | 4단계 레일, 역할별 "다음 할 일" 문장, 서버 계산 허용 행동, 자기 승인 차단, 반려 사유 필수, 2인 승인 정책 | DASH-004 | API `요청 상태 전이와 승인` 8건(전체 흐름·자기 승인 API/DB 거부·잘못된 전이·사유 필수·동시 승인 충돌·멱등성·정밀도·주소 비활성) 통과. E2E 승인/반려 통과 |
| 모든 탭에 같은 페이지네이션·정보량 설정 (S2 COO 대화) | 탭별 탐색 방식 차등(`tab-design.md`), URL 상태 유지, 필터 변경 시 1페이지, 빈 결과 안내 | DASH-005 | API `목록 탐색`(137건, 첫/마지막/범위 밖/잘못된 크기), E2E `목록` 통과. 인사이트 자료 관리 화면의 페이지 이동은 아직 없음(`tab-design.md`) |
| Market Insight 화면의 정보량 선택·출처 표시 불편 (S2, 기존 화면 캡처) | 기관·발행일·언어·원문(새 창) 표시, 이용 고지 상단 고정, 기관 칩 필터, "더 보기", 화이트리스트 서버 강제. **운영 설정은 화이트리스트를 강제할지(`requireWhitelistedProvider`)뿐이고, 어느 기관이 화이트리스트인지는 모의 데이터(`insight_providers.is_whitelisted`)다.** 화이트리스트 변경 화면·감사 기록은 없다(A-11). 2026-10-19: 원문 링크가 기관 홈페이지와 같은 호스트인지 모든 모드에서 확인, 숨긴 자료를 다시 게시할 때 재확인 | DASH-007 | API `Market Insight`(비화이트리스트 게시 거부, javascript: URL 거부), `deploy-mode.test.ts` `rejects a link whose host differs from the provider homepage in local and demo mode`·`re-checks the whitelist when an item is published again`, E2E `Market Insight` 통과. 모의 기관이 모두 같은 호스트라 기관 사이 도메인 구분은 검증 안 됨 |
| 파괴적 행동에 브라우저 confirm(), 작성 중 이탈 시 입력 손실, 필드 오류 연결 부족, 검색이 매 글자 조회 (독립 검수 2026-10-19) | 공통 ConfirmDialog(초기 포커스·Tab 순환·inert·busy 중복 방지·실패 유지·포커스 복귀), useUnsavedGuard(인앱 확인·beforeunload), Field의 aria-invalid/describedby·첫 오류 포커스, 세션 만료 시 같은 계정 재로그인(입력 유지), SearchField(300ms·IME·Enter·지우기), DateInput(Chrome 날짜 칸 입력 초기화 결함 수정), 좁은 화면 홈 순서(할 일→보유 자산), 390px 가로 넘침 수정 | DASH-002·003·004·005 | E2E `interaction.spec.ts` 9건 통과, 정적 audit(strict) 0건, 모바일 상태 스크린샷 확인 |
| 엔터프라이즈 도입 심사 항목 | 서버 권한·조직 격리·CSRF·세션 폐기·요청 한도·감사 해시 체인·불변 트리거·CSV 수식 무력화·500 시 롤백 | 공통 | 최초 기록: API·단위 테스트 39건, E2E 16건 + axe 15화면 위반 0건. 2026-10-19 재실행 결과는 아래 '2026-10-19 보강' 마지막 행 |

## 이용가이드(S3)에서 확인한 불편

가이드의 화면 설명을 프로토타입 변경과 연결한다. 실서비스 동작은 가이드에 보이는 범위만 근거로 삼고, 화면에 보이지 않는 통제가 실제로 없는지는 확인하지 않았다.

| 쪽 | 기존 불편 (요지) | 프로토타입 변경 | 상태 | 검증 |
| --- | --- | --- | --- | --- |
| p.13 | 메뉴 '결재 및 요청' 옆 숫자 배지가 무엇을 센 것인지(내 처리 건인지 전체인지) 설명이 없다 | 홈 '지금 처리할 일'에 역할별 건수와 할 일 설명을 둔다. 메뉴 배지는 내가 처리할 건수(승인할 요청 + 제출 전 내 요청)이고 화면 낭독기에는 '처리할 일 N건'으로 읽힌다. 눈에 보이는 설명은 없고, 승인할 수 없는 요청(A-17)은 배지에 들어가지 않는다 | 일부 | E2E `수직 흐름`(홈 '지금 처리할 일' 노출). 배지 숫자의 의미 전달은 검증 안 됨 |
| p.25, p.44 | 같은 대상을 '코인'·'토큰'으로 섞어 부른다 | 화면 본문은 '자산'으로 통일. 토큰 목록 화면에 토큰과 자산이 같은 대상이라는 한 줄 설명(`GLOSSARY.token`). 메뉴 이름 '토큰 목록'과 자산 이름의 '코인' 표기(USD 코인)는 그대로다(메뉴 변경은 후속) | 일부 | `glossary.test.ts` `has every required key with a label and an explanation`, E2E `접근성 자동 검사 /tokens`. 용어 혼동이 줄었는지는 검증 안 됨 |
| p.28, p.41 | 체크박스 하나로 '지갑 관리자'가 되면 결재선·구성원을 직접 바꿀 수 있고, 최고관리자·지갑 관리자의 출금 요청은 결재선을 거치지 않는다 | **의도적으로 재현하지 않음**(A-21, DEC-002): 모든 출금은 작성자가 아닌 승인자 승인이 필요하고 자기 승인은 API·저장 계층에서 거부한다. 관리자도 자기에게 승인자·자산 담당자 역할을 줄 수 없다(A-19). 역할 변경 영향 안내·두 번째 관리자 확인은 없다 | 일부 | API `forbids self-approval at API and at the storage layer`, `request-integrity.test.ts` `refuses an admin granting themselves approver or requester, but allows granting others` |
| p.33 | 토큰을 지우면 실제 자산은 남는데 잔고·활동 내역에서 사라지고, 그 토큰의 주소록이 함께 지워진다 | 재현하지 않음: 토큰 목록은 조회 전용이고 삭제 기능이 없다(A-25). 실서비스의 대안(숨김 표시·영향 건수 안내)은 KODA 확인 필요 | 미해결 | 검증 안 됨 |
| p.37–38 | 트래블룰 수취인 정보·거래소(VASP) 선택·확약서 제출이 필요하지만 제출 위치·상태가 화면에 없고, '거래소 등록 정보와 정확히 일치' 조건은 가이드에만 있다 | 모델링하지 않음(A-14, OPEN-002). 필요한 항목·상태·일치 규칙은 KODA 자료로 정한다 | 미해결 | 검증 안 됨 |
| p.42, p.45 | 결재(회사 안 승인)와 요청(KODA 처리)이 다른 탭에 나뉘어 한 건이 어디까지 왔는지 한 화면에서 볼 수 없다 | 한 목록과 상세에서 작성→검토→승인 대기→처리 결과 4단계 레일로 보인다. 처리 결과 단계 안의 KODA 처리·블록체인 확정 구분은 없다(A-26) | 일부 | E2E `수직 흐름` |
| p.43 | 삭제된 주소로 가는 출금이 승인 대기 목록에 경고 없이 남아 있다 | 서버가 승인을 거부(422 `ADDRESS_NOT_ACTIVE`). 승인 행동을 내보이지 않고 반려만 남기며(`blockedReason`), '내가 승인할 요청'과 건수에서 빼 `view=blocked`와 홈 할 일(위험 표시)로 따로 보인다. 예약 수량은 반려·취소 때까지 유지(A-17). 요청 상세의 반려 경로와 요청 목록의 '승인할 수 없는 요청' 보기 탭은 아직 없다(후속 화면 작업) | 일부 | API `rejects approval when the destination address was disabled after submission`, `request-integrity.test.ts` `stops offering approve, moves the request to view=blocked and the blocked tasks, and still refuses approval on the server` |
| p.44 | 날짜 형식이 세 가지(슬래시, 오전/오후, 두 줄)로 섞여 있다 | 화면의 날짜·시각은 `YYYY-MM-DD HH:mm`(KST) 한 형식(`src/format.ts`). 감사 기록 CSV는 아직 UTC 원값을 내보낸다(후속) | 일부 | 검증 안 됨(코드 확인만) |
| p.45 | '처리됨'이 KODA 서명인지 블록체인 확정인지 정의가 없고, 거래 해시·완료 시각이 없다 | '처리 완료' 설명에 "모의 커스터디가 완료를 알린 상태, 블록체인 확정을 완료 기준으로 삼을지는 KODA와 정할 항목"을 명시(A-26). 완료 증빙(거래 해시·확정 수) 표시는 없다 | 일부 | `glossary.test.ts` `defines 처리 완료 as the mock custody's report, with the completion basis left to KODA` |
| p.42–44 | 상태에 'n차 승인됨' 자리표시자가 그대로 보여 몇 명이 승인했고 몇 명이 더 필요한지 알 수 없다 | '승인 x/y'(지금 유효한 승인 수 / 필요한 승인 수)로 홈 진행 중 요청과 요청 상세에 표시. 권한을 잃었거나 비활성화된 사람의 승인은 세지 않는다(A-03, A-15). 용어 설명 `GLOSSARY.approvalCount` | 해결 | API `requires two distinct approvers above the high-value threshold and handles concurrent approvals`, `request-integrity.test.ts` `drops the vote of an approver whose role was removed, then a third valid approver completes the quorum`. 화면 문구 자체는 자동 검사 없음 |

## 2026-10-19 보강 (검수 결과 반영)

| 기존 문제 (출처) | 개선 | 가정 | 검증 결과 (2026-10-19) |
| --- | --- | --- | --- |
| 수량의 쉼표를 모두 지워 '1,5'를 15로 읽음 (R1 SEC-02) | 쉼표는 천 단위 자리에만 허용, 그 밖은 422 `AMOUNT_FORMAT`(수량 칸 오류) | — | `decimal.property.test.ts`(속성 1,000회 이상), `amount-input.test.ts` |
| 시세가 없거나 오래되어도 1명 승인으로 내려감, 권한을 잃은 승인자의 표도 셈 (R1) | 시세 없음·지연·읽을 수 없음·미래 시각이면 고액 기준, 지금 유효한 표만 정족수 | A-03, A-15 | `request-integrity.test.ts` `필요 승인 수: 시세 없음·지연이면 fail closed` 4건, `유효한 승인 표만 집계` 2건 |
| 승인할 사람이 모자라도 제출되어 수량이 묶임, 관리자가 자기에게 승인 권한을 줄 수 있음 (R1 COV-11) | 422 `APPROVERS_INSUFFICIENT`, 422 `SELF_ROLE_ESCALATION` | A-16, A-19 | `승인할 수 있는 사람이 부족하면 제출 거부` 3건, `본인 역할 상승 금지` |
| 승인 재시도 때 커스터디 접수가 두 번 될 수 있음 (R1) | 요청 id를 멱등 키로 전달, 모의 어댑터가 같은 참조 반환 | A-18 | `returns the same custody ref when the approval is retried after a failure that rolled back the transaction` |
| 앞·뒤만 같게 만든 주소(주소 위조)를 끝자리 확인으로 막지 못함 (R1) | 가운데 8자리 재입력, lookalike-v2 | A-05, A-07 | 위 '잘못된 주소' 행 참조 |
| 감사 해시가 수행자 이름을 보호하지 않음, 최근 기록 삭제를 찾을 기준이 없음 (R1) | 해시 v2, 검증 결과에 조직 안 위치(`brokenAtNo`)와 `headHash` | A-24 | `audit-chain.test.ts` 27건 |
| 보호된 공개 데모가 필요하지만 기존 안전 잠금이 호스팅 실행을 막음 (R1) | `DEMO_PUBLIC=1` 명시 때만 공개 데모, 인스턴스 메모리 데이터, 생성 한도 | A-22, A-23, DEC-001 | `deploy-mode.test.ts` 20건. 실제 배포 검증은 하지 않음 |
| 전체 재실행 (97ecd92 + 용어·문서 보강) | — | — | `npm run typecheck` 통과, `npm test` 9개 파일 163건 통과, `npm run build` 성공, E2E 39건 통과(axe 15화면 위반 0건 포함, 2026-10-19) |

개인 제안(고객사별 맞춤 리서치)은 핵심 기능에 넣지 않고 꺼진 실험으로만 구현했다(`experiments.md`).
