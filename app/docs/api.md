# API 계약 (요약)

모든 경로는 `/api` 아래, JSON. 인증은 `koda_sid` HttpOnly 쿠키(공개 데모에서는 Secure 추가). 변경 요청(POST/PUT/PATCH)은 `X-CSRF-Token` 헤더(`GET /api/me`의 `csrfToken`) 필수. 다른 조직의 리소스는 존재 여부를 숨기기 위해 404. `/api` 응답은 모두 `Cache-Control: no-store`.

## 오류 형식
```json
{ "error": { "code": "ADDRESS_NETWORK_MISMATCH", "message": "원인(한국어)", "action": "복구 행동", "fields": [{ "field": "addressId", "message": "..." }] }, "requestId": "uuid" }
```
상태 코드: 400 중복 제출 방지 값 오류(`IDEMPOTENCY_KEY_REQUIRED`: `POST /api/requests`에 `Idempotency-Key`가 없음, `IDEMPOTENCY_KEY_INVALID`: 형식이 8~80자 영숫자·`_-`가 아님), 401 로그인 필요, 403 권한 없음·자기 승인(`SELF_APPROVAL_FORBIDDEN`)·자기 주소 확인(`SELF_REVIEW_FORBIDDEN`)·작성자가 아닌 사람의 요청 수정·검토 이동·되돌리기·제출·취소(`NOT_REQUEST_OWNER`)·CSRF, 404 없음/타 조직·꺼져 있는 실험 기능(`EXPERIMENT_DISABLED`, 예: `GET /insights?related=1`), 409 상태 충돌(`INVALID_TRANSITION`, `VERSION_CONFLICT`, `CONFLICT`, `ALREADY_DECIDED`, `LOOKALIKE_UPDATED`, `USE_COOLDOWN_STOP`, `NOT_COOLING_DOWN`, `INTENT_CHANGED`, `INTENT_MISSING`, `INTENT_TAMPERED`), 422 입력·업무 규칙 오류, 429 요청 한도, 500 내부 오류(변경 롤백). 409 `CONFLICT`는 주소 확인·사용 중지·정지의 상태·버전 충돌과 역할 변경의 `rolesVersion` 충돌이며 추가 필드가 없다.

오류에 따라 `error` 안에 추가 필드가 붙는다(아래 오류 코드 표의 '추가 필드'). 409 `INVALID_TRANSITION`은 `status`를, 요청 행동 시작 때 검사한 `VERSION_CONFLICT`는 `status`와 `version`을 준다. 검사 뒤 저장하는 순간에 다른 변경과 겹쳐 난 `VERSION_CONFLICT`에는 `status`·`version`이 없다(요청을 다시 불러와 확인한다). 주소 점검 오류는 `findings`를 준다.

**필수 사유 규칙**(유사 주소 등록 사유 `lookalikeReason`, 유사 주소가 있을 때의 확인 메모 `note`, 주소 등록 거절 사유 `note`, 사용 대기 중 정지 사유 `reason`, 출금 요청 반려 사유 `reason`, 출금 전 점검 진행 사유 `checkReasons.<id>`): 서버는 먼저 보이지 않는 문자, 곧 서식 문자(`\p{Cf}`: 폭 없는 공백 U+200B·방향 제어 문자 U+202E·BOM 등)와 화면에 아무것도 보이지 않는 채움 문자(한글 채움 U+115F·U+1160·U+3164·U+FFA0, 점자 빈칸 U+2800)를 지우고 앞뒤 공백을 없앤다. 남은 값이 **5자 이상**이고 그중 **글자·숫자(`\p{L}`·`\p{N}`)가 5자 이상**이어야 한다(문장부호·공백만으로는 채울 수 없다). 저장·감사 기록에도 지운 값을 쓰며, 등록 사유·메모·정지 사유·반려 사유의 길이 상한(300·500자)도 지운 값으로 센다. 채우지 못하면 등록 사유는 422 `REASON_REQUIRED`, 확인 메모는 422 `NOTE_REQUIRED`, 주소 등록 거절 사유·정지 사유·반려 사유는 422 `VALIDATION`(필드 `note`·`reason`), 진행 사유는 422 `CHECK_REASON_REQUIRED`다. 예를 들어 `.....`, `- . , !`, 폭 없는 공백이나 U+3164만 넣은 값은 모두 거부된다. 주소 상세 화면의 정지 사유 점검도 같은 함수(`shared/text.ts`)를 쓴다.

### 오류 코드 (2026-10-19 추가·변경분)

| 코드 | 상태 | 언제 | `fields[].field` | 추가 필드 |
| --- | --- | --- | --- | --- |
| `AMOUNT_FORMAT` | 422 | 수량 형식 오류. 쉼표는 천 단위 자리(예: `1,000`, `12,345.5`)에만 쓸 수 있고 `1,5`·`1,,000`·`1,000,` 등은 거부. 소수점은 마침표 | `amount` | — |
| `AMOUNT_UNREADABLE` | 422 | 작성·검토 중 요청의 **저장된** 수량을 정수로 읽을 수 없는데(앱 밖 저장 계층 변경, 예: `'0.5'`·`'abc'`, A-30) 검토 이동(`/review`)·승인 요청(`/submit`)을 보냄. 아무것도 바꾸거나 예약하지 않는다. 행동은 작성 중이면 '내용 수정에서 수량을 다시 입력하거나 요청을 취소하세요.', 검토 중이면 '작성 단계로 되돌린 뒤 내용 수정에서 수량을 다시 입력하거나 요청을 취소하세요.'. 이런 요청은 조회 응답에서 `amount: null`·`checks: null`이고 허용 행동에 `review`·`submit`이 없다(수정·되돌리기·취소는 남는다) | `amount` | — |
| `CONFIRM_MIDDLE_MISMATCH` | 422 | 주소 등록·확인(승인) 때 다시 입력한 고유부 가운데 8자리가 다름(대소문자 무시). 끝자리 검사(`CONFIRM_TAIL_MISMATCH`) 다음에 검사 | `confirmMiddle` | — |
| `REASON_REQUIRED` | 422 | 주소 등록 때 유사 주소가 있는데 `lookalikeReason`이 위 필수 사유 규칙을 채우지 못함(보이지 않는 문자를 지운 뒤 5자 미만이거나 글자·숫자 5자 미만) | `lookalikeReason` | `findings` |
| `NOTE_REQUIRED` | 422 | 주소 확인(승인) 때 저장된 점검 결과에 유사 주소가 있는데 `note`가 위 필수 사유 규칙을 채우지 못함 | `note` | — |
| `LOOKALIKE_UPDATED` | 409 | 주소 확인(승인) 때 다시 점검해 저장된 점검 결과에 없던 유사 주소를 찾음. 점검 결과(`findings`)와 `version`을 갱신해 저장하고 승인하지 않는다. 화면은 주소를 다시 불러와 비교를 보여 준 뒤 메모와 함께 다시 확인 | — | — |
| `ADDRESS_NOT_ACTIVE` | 422 | 사용 가능 상태가 아닌 주소로 초안·수정·검토 이동·제출·점검 미리 보기(입력 오류), 또는 받는 주소가 사용 중지된 요청의 승인. **사용 대기(`COOLING_DOWN`) 주소**는 메시지에 사용 가능 시각(`YYYY-MM-DD HH:mm KST`)을, 행동에 '사용 가능해질 때까지 기다린 뒤 다시 요청하세요. 요청한 적 없는 등록이라면 주소 상세에서 「사용 대기 중 정지」로 바로 정지하세요.'를 담는다(요청자도 주소 등록 권한으로 정지할 수 있다, A-31). **사용 중지(`DISABLED`)·등록 거절(`REJECTED`) 주소**는 다시 쓸 수 없으므로 '…주소는 사용 중지되어 이 요청에 쓸 수 없습니다'(새 작성은 '출금 요청에')와 함께, 작성 중이면 '내용 수정에서 다른 주소를 고르거나 요청을 취소', 검토 중이면 '작성 단계로 되돌린 뒤 내용 수정에서 다른 주소를 고르거나 요청을 취소', 새 작성이면 '주소록에서 사용 가능한 다른 주소를 고르세요'를 안내한다. 확인 대기(`PENDING_REVIEW`)는 두 번째 담당자의 확인을 기다리라고 안내한다 | `addressId`(초안·제출) | 사용 대기일 때 `addressStatus: 'COOLING_DOWN'`, `activeFrom`. 사용 중지·등록 거절일 때 `addressStatus` |
| `APPROVERS_INSUFFICIENT` | 422 | 승인 요청 제출 때, 작성자를 뺀 지금 승인할 수 있는 사람이 필요한 승인 수보다 적음. 아무것도 예약하지 않음 | — | `eligibleApprovers`, `requiredApprovals`, `approvalBasis` |
| `SELF_ROLE_ESCALATION` | 422 | 역할 변경에서 자기 자신에게 승인자·자산 담당자 역할을 새로 부여 | — | — |
| `PROVIDER_NOT_WHITELISTED` | 422 | 화이트리스트 밖 기관 자료 게시, **숨긴 자료를 다시 게시**(PATCH `published`)할 때도 | `providerId` | — |
| `PROVIDER_DOMAIN_MISMATCH` | 422 | 원문 링크의 호스트가 제공 기관 홈페이지 호스트와 다름(모든 모드, 게시와 다시 게시) | `url` | — |
| `DEMO_LIMIT` | 422 | 공개 데모에서만. 인스턴스당 사용자가 새로 만든 주소 등록·출금 요청·인사이트 게시가 종류별 200건에 도달 | — | — |

### 오류 코드 (wave 3A: 주소 수명 주기·공개 데모 세션)

| 코드 | 상태 | 언제 | `fields[].field` | 추가 필드 |
| --- | --- | --- | --- | --- |
| `OUT_OF_BAND_SAME_CHANNEL` | 422 | 주소 등록에서 주소를 받은 경로(`receivedVia`)와 다시 확인한 경로(`verifiedVia`)가 같음 | `verifiedVia` | — |
| `ADDRESS_POISON_SUSPECTED` | 422 | 등록하려는 주소(또는 확인하려는 확인 대기 주소)가 최근 90일 안에 0원·소액 입금을 보낸 주소와 같음(주소 오염 의심). 확인 때는 등록 뒤에 들어온 입금도 본다. **확인 때는 거부하기 전에 찾은 결과를 저장한다**: 그 결과를 주소의 점검 결과(`findings`) 맨 앞에 넣고 `version`을 1 올리고 감사 기록 `address.findings_updated`를 남긴 뒤(커밋) 422를 돌려준다. 같은 입금으로 이미 저장해 둔 결과면 다시 쓰지 않는다(버전·감사 기록이 늘지 않음). 따라서 확인 때 이 오류를 받으면 주소를 다시 불러와 새 `version`으로 결정해야 하며, 보냈던 `version`을 그대로 쓰면 409 `CONFLICT`다. 저장된 결과가 있는 주소는 서버가 확인할 때마다 다시 점검해 거부하므로 거절만 할 수 있다(화면은 확인 버튼을 내놓지 않는다) | `address`(등록) | `findings`(등록·확인) |
| `USE_COOLDOWN_STOP` | 409 | 사용 대기 중인 주소에 일반 사용 중지(`/disable`)를 요청함. 사유와 함께 `/stop`을 써야 한다 | — | — |
| `NOT_COOLING_DOWN` | 409 | 사용 대기가 아닌 주소에 `/stop`을 요청함(이미 사용 가능이면 조직 관리자의 사용 중지를 안내) | — | `status` |

`ADDRESS_POISON_LOOKALIKE`(경고, 저장된 `findings`에만)는 최근 소액 입금을 보낸 주소와 앞·뒤만 같은 주소다. 공개 데모 세션 쿠키가 변조·만료·다른 서명 값·형식 오류이면 401 `UNAUTHENTICATED`다.

### 오류 코드 (WP-11: 승인 대상 지문·출금 전 점검)

| 코드 | 상태 | 언제 | `fields[].field` | 추가 필드 |
| --- | --- | --- | --- | --- |
| `CHECK_REASON_REQUIRED` | 422 | 승인 요청(`/submit`) 때 사유가 필요한 주의 항목(이 대시보드로 처음 보내는 주소, 과거 출금 중앙값의 5배 초과, 사용 가능 수량의 50% 이상·초과)에 진행 사유가 없거나, 위 필수 사유 규칙의 보이지 않는 문자를 지운 뒤 글자·숫자가 5자 미만(문장부호·공백만인 사유 포함). 빠진 항목마다 필드 오류. 아무것도 예약하지 않고 검토 중으로 남는다. 끝자리 검사(`CONFIRM_TAIL_MISMATCH`)·사용 가능 수량 검사 다음, 승인 가능 인원 검사(`APPROVERS_INSUFFICIENT`) 앞 | `checkReasons.<점검 id>` | `checkIds` |
| `INTENT_CHANGED` | 409 | 승인·반려 본문의 `intentHash`가 제출 때 고정한 지문과 다름(대소문자 무시, 지문이 있는 요청에 `null`을 보낸 경우 포함). 승인·반려 표를 남기지 않는다. 제출 뒤 지문은 바뀌지 않으므로 결정하는 사람의 화면이 다른 내용을 보였다는 신호로 보고, 결정 트랜잭션을 되돌린 뒤 별도 트랜잭션으로 감사 기록 `request.intent_mismatch`(수행자는 결정하려던 사람, 상세: `decision`(`approve`·`reject`), `storedHash`, `submittedHashPrefix`(보낸 지문의 앞 16자, 소문자. 안 보냈으면 null), `actor`, `voteRecorded: false`)를 남긴다(행동 이름 '승인 대상 지문이 달라 결정 거부'). 멱등 기록은 남기지 않는다 | — | `intentHashDisplay`(지금 지문) |
| `INTENT_MISSING` | 409 | 지문 기록 전(이 기능 도입 전)에 제출된 승인 대기 요청의 승인. 대조할 지문이 없어 거부한다(fail closed). 반려는 `intentHash: null`로 할 수 있다 | — | — |
| `INTENT_TAMPERED` | 409 | 승인할 때와 커스터디로 넘기기 직전에 저장된 행으로 지문을 다시 계산했더니 제출 때 지문과 다르거나, 정족수에 든 승인 표 중 같은 지문을 승인하지 않은 표가 있음. 승인 트랜잭션을 되돌려 처리 중으로 넘기지 않고 커스터디를 부르지 않는다. 별도 트랜잭션으로 감사 기록 `request.intent_tampered`(수행자 '시스템(승인 대상 지문 재확인)', 상세: `stage`(`approve`·`handoff`), `storedHash`, `recomputedHash`(저장된 수량을 정수로 읽을 수 없어 다시 계산하지 못하면 null), `mismatchedApproverIds`, `attemptedBy`, 끝자리만 담은 `current`(`amount`는 읽을 수 없으면 null, `amountUnits`는 저장된 글자 그대로), `custodyCalled: false`)를 남긴다(행동 이름 '승인 대상 지문 불일치로 중단'). 조회 응답도 지문을 다시 계산해 `blockedReason: 'INTENT_TAMPERED'`로 알리고 `approve`를 내보이지 않는다. 저장된 수량을 정수로 읽을 수 없는 요청(예: `'0.5'`, `'abc'`)도 같고, 상세·목록·홈은 그대로 응답한다(`amount: null`). 반려·취소는 막지 않으며 승인 요청 때 예약한 수량을 푼다 | — | — |
| `VALIDATION` | 422 | 승인·반려 본문에 `intentHash`가 없음 | `intentHash` | — |

## 멱등성
`Idempotency-Key`(8~80자 영숫자·`_-`). `POST /api/requests`는 필수, 요청 행동(`/review`, `/submit`, `/approve`, `/reject`, `/cancel`, `/back-to-draft`)은 선택. 같은 사용자·경로·키 + 같은 본문이면 처음 응답을 재전송(`Idempotent-Replayed: true`), 다른 본문이면 422 `IDEMPOTENCY_KEY_REUSED`.

커스터디 접수(서버 내부)는 요청 id를 멱등 키로 넘긴다. 같은 키로 다시 접수하면 같은 접수 참조(`custodyRef`)를 돌려받는다(설계 가정 A-18). 접수 입력에는 승인 대상 지문(`intentHash`)도 함께 넘기며, 모의 어댑터는 키별로 지문을 기록하고 같은 키에 다른 지문이 오면 받지 않는다(A-30). 수량·주소·메모는 저장된 글자열이 아니라 지문에 묶은 정규화 값(10진 정수 수량, 네트워크 계열 규칙으로 정규화한 주소, 앞뒤 공백을 지운 메모)을 넘긴다. 숫자로는 같지만 표기가 다른 저장 값(16진수·앞자리 0·공백·대소문자)이 그대로 커스터디에 닿지 않게 하기 위함이다. 감사 기록 `request.processing`의 수량·주소 끝자리도 같은 값이다.

`INTENT_TAMPERED`·`INTENT_CHANGED`로 거부된 결정은 멱등 기록을 남기지 않는다(같은 키로 다시 보내면 다시 확인하고 다시 거부한다).

## 동시성
요청·주소·역할 변경은 `version`(역할은 `rolesVersion`)을 본문에 보내야 하며 다르면 409. 쓰기는 `BEGIN IMMEDIATE` 트랜잭션.

## 금액
요청 본문의 `amount`는 10진 문자열(예 `"2500.25"`, 천 단위 쉼표 허용 `"1,000"`), 자산 자릿수 초과 시 422 `AMOUNT_PRECISION`. 응답은 `amount`(표시용 10진 문자열)와 `amountUnits`(최소 단위 정수 문자열)를 함께 준다. 저장된 최소 단위 값을 정수로 읽을 수 없으면(앱을 거치지 않은 저장 계층 변경) 요청 응답·목록·홈 진행 중 요청의 `amount`는 null이고 `amountUnits`는 저장된 글자 그대로다. 원화 값은 원 단위 정수 문자열.

요청 번호(`refNo`, `WR-000001` 형식)는 조직마다 1부터 매긴다. 다른 조직의 요청량이 번호에 드러나지 않으며, 같은 번호가 다른 조직에도 있을 수 있다(저장 계층 고유 제약은 조직·번호 단위, migrations/007).

## 출금 요청 응답 (`GET /requests/:id`, 행동 응답)

| 필드 | 뜻 |
| --- | --- |
| `requiredApprovals` | 제출 때 정한 필요 승인 수 |
| `approvedCount` | 정족수에 들어간 승인 수. 승인 대기 중에는 지금 유효한 표(같은 조직 활성 사용자, 지금 승인 권한 있음, 작성자 아님)만 센다. 결정이 끝난 요청은 결정 당시 저장한 목록 기준(목록이 없는 이전 요청은 당시 승인 표 전체) |
| `approvals[]` | `{userId, name, decision('approved'\|'rejected'), reason, createdAt, counted, matchesRequestIntent, rolesAtDecision, rolesSource, approveRoleAtDecision}`. `counted`는 이 표가 정족수에 들어갔는지이며 반려 표는 항상 false. 뒤의 네 필드는 아래 '결정 근거'(A2-3)와 같은 값이다 |
| `approvalWait` | (A2-1) 승인 대기 요청을 지금 누가 승인할 수 있는지 `{candidates: [{id, name}], remaining, shortfall}`. 상태가 승인 대기이고 승인할 수 있는 요청(`blockedReason` 없음, 지문 있음)일 때만 값이 있고, 그 밖과 **목록 응답에서는 null**. `candidates`는 같은 조직의 활성 사용자 가운데 지금 역할에 `request.approve`가 있는 사람에서 작성자와 이 요청에 이미 결정(승인·반려)을 남긴 사람을 뺀 목록(이름순, 항목의 키는 `id`·`name`뿐, 이메일·직함 없음). 제출 때 승인 가능 인원 검사(`APPROVERS_INSUFFICIENT`)와 같은 판정 함수를 쓴다. `remaining` = `requiredApprovals` − `approvedCount`(0 이상), `shortfall` = 후보 수 < `remaining`. 표시용이며 정족수·승인 가능 여부는 승인 처리가 다시 정한다. 대기 시작 시각은 `submittedAt` |
| `timeline[]` | 상세·행동 응답의 처리 기록 `{action, actorName, summary, createdAt}`. `request.approved`·`request.rejected` 행에만 `evidence`(그 수행자의 결정 근거, 표를 찾지 못하면 null)가 붙는다. 수행자 id는 행에도 `evidence`에도 넣지 않는다(이 `evidence`에는 아래 '결정 근거'의 `userId`가 없다. 같은 사람의 id는 같은 응답 `approvals[].userId`에 있다) |
| `approvalBasis` | 필요 승인 수의 근거: `value_below_threshold`, `value_at_or_above_threshold`, `price_missing`(시세 없음), `price_stale`(30분 초과·읽을 수 없음·5분 넘게 미래). 뒤의 둘은 고액 기준 적용. 제출 전이거나 이 필드 도입 전 요청은 null |
| `priceAsOfAtSubmit` | 제출 때 쓴 시세 기준 시각(ISO). 시세가 없었으면 null |
| `krwValueAtSubmit` | 제출 때 원화 평가액(원 단위 정수 문자열) 또는 null |
| `blockedReason` | 승인 대기 요청을 승인할 수 없는 이유. `INTENT_TAMPERED`: 조회할 때 지금 저장된 요청·주소록 행으로 다시 계산한 지문이 `intentHash`와 다름(승인 요청 뒤 내용이 바뀜, 먼저 본다). `ADDRESS_NOT_ACTIVE`: 받는 주소가 사용 가능 상태가 아님. 이때 `allowedActions`에는 `approve`가 없고 `reject`만 남는다(승인자, 요청자는 `cancel`). 서버의 승인 거부(409 `INTENT_TAMPERED`·422 `ADDRESS_NOT_ACTIVE`)는 그대로다. 그 밖에는 null이며, 작성·검토 중 요청은 받는 주소가 사용 중지되어도 null이다(예약이 없다. 대신 `allowedActions`에서 `review`·`submit`이 빠진다). 목록 응답에도 있다 |
| `allowedActions` | 지금 사용자에게 허용된 행동(서버 계산). 목록 응답에서는 빈 배열. 지문이 없는 이전 승인 대기 요청에는 `approve`가 없다. 작성·검토 중 요청의 받는 주소가 사용 가능 상태가 아니면 `review`·`submit`이 없고 `edit`·`back_to_draft`·`cancel`은 남는다 |
| `custodyRef` | 커스터디 접수 참조(모의) |
| `intentHash` | 승인 대상 지문(16진수 소문자 64자). 승인 요청(제출) 때 정규화 JSON `{v:1, requestId, orgId, assetCode, networkCode, amountUnits, addressId, address(네트워크 계열 규칙으로 정규화), memo, requiredApprovals}`(키 정렬, 공백 없음)의 SHA-256으로 정하고 바꾸지 않는다. 제출 전·이 기능 도입 전 요청은 null. 목록 응답에도 있다 |
| `intentHashDisplay` | 화면 표시용 지문: 앞 16자를 대문자 4자 묶음으로(예 `7F3A 91C2 0B4E 55D1`). 없으면 null |
| `approvals[].intentHash`, `approvals[].intentHashDisplay` | 그 사람이 승인·반려할 때 본 지문. 이 기능 도입 전 표는 null |
| `checks` | 상세 응답에만. 출금 전 점검 `{evaluatedAt, stored, items[]}`. 작성·검토 중이면 볼 때마다 다시 계산(`stored: false`), 승인 요청 뒤에는 제출 때 저장한 결과와 요청자 사유(`stored: true`). 점검 기록 전에 제출된 요청은 null |
| `checks.items[]` | `{id, label, outcome, detail, basis, requiresReason, reason?}`. `id`: `first_use`·`amount_history`·`balance_share`·`recent_burst`·`price`(이 순서). `outcome`: `pass`(기준 이내)·`caution`(주의)·`unknown`(확인 불가, 기준 이내로 보이지 않음). `requiresReason`은 주의이면서 진행 사유가 필요한 항목. `first_use`·`amount_history`는 이 대시보드에서 처리 완료된 출금 요청만 세며(자산 활동 내역의 출금 행은 받는 주소가 없어 제외), 문구에 그 범위를 함께 쓴다(A-27). `reason`은 제출 때 저장한 사유(제출 전·사유 없음은 null). 기준값은 `GET /org/policy`의 `withdrawalChecks`(설계 가정 A-27) |

## 결정 근거 (`DecisionEvidence`, A2-3)

요청 상세의 `approvals[]`·`timeline[].evidence`, 감사 기록 목록 항목의 `evidence`, 감사 CSV의 '결정 근거(내보낼 때 계산)' 열이 같은 값을 쓴다(처리 기록의 `timeline[].evidence`만 `userId`를 빼고 준다. 감사 기록 목록 항목은 `actorId`가 이미 있어 그대로 둔다). **읽을 때 계산하는 값**이며 승인 표·지문 기록·감사 기록에 새로 쓰지 않는다(해시 대상 아님, 마이그레이션 없음).

```json
{ "userId": "u-a-oh", "name": "오민재", "decision": "approved", "decidedAt": "ISO", "intentHashDisplay": "17B9 C2A0 9F3E 11D4",
  "matchesRequestIntent": true, "counted": true, "rolesAtDecision": ["approver"], "rolesSource": "role_history", "approveRoleAtDecision": true }
```

| 필드 | 뜻 |
| --- | --- |
| `intentHashDisplay` | 그 사람이 결정할 때 본 승인 대상 지문(`approval_intents`, 수정·삭제 금지). 이 기능 도입 전 표는 null |
| `matchesRequestIntent` | 표의 지문이 요청 지문(`intentHash`)과 같은지. 표 지문이 없으면 null |
| `counted` | 필요 승인 수에 셌는지(정족수 포함 여부. 승인 대기 중에는 지금 역할로 다시 판단, 결정이 끝난 요청은 결정 당시 목록 `counted_approver_ids`). 반려 표는 false. 필드 이름은 그대로다 |
| `rolesAtDecision` | 결정 당시 역할: 같은 조직 감사 기록의 `member.roles_changed`(대상 사용자 = 결정자) 가운데 `created_at` ≤ 결정 시각이고 그 결정의 감사 기록(`request.approved`·`request.rejected`)보다 앞선 마지막 행의 `detail.after`. 알려진 역할 코드의 배열이 아니거나 기록이 없으면 null. **감사 기록 조회 권한(`audit.read`: 감사 담당자·조직 관리자)이 있는 조회자에게만 채우고, 그 밖에는 늘 null**이다(역할 변경 기록은 지금도 `audit.read`로만 보인다) |
| `rolesSource` | `rolesAtDecision`이 있으면 `'role_history'`(역할 변경 기록 기준), 없으면 null |
| `approveRoleAtDecision` | `rolesAtDecision`에 출금 승인 권한이 있는지(역할→권한 표는 코드라 지금 권한표 기준, A-01). `rolesAtDecision`이 null이면 null. false이면 화면·CSV가 '역할 변경 기록상 이때 승인 권한이 없습니다 — 기록을 확인하세요'를 쓴다 |

문구(`shared/terms.ts` `decisionEvidenceText`): '결정 당시 역할: 승인자(역할 변경 기록 기준) · 필요 승인 수에 셈 · 결정 때 본 승인 대상 지문 17B9 C2A0 9F3E 11D4(지금 요청과 같음)'. 화면 낱말('승인 x/y'·'필요한 승인 수'·결정 카드의 '승인 대상 지문')과 맞추려고 '정족수'·'결정한 지문'이라는 말은 쓰지 않는다. 역할 조각은 `audit.read`가 있을 때만 쓰고, 역할 변경 기록이 없으면 '결정 당시 역할: 알 수 없음(역할 변경 기록 없음)'(기록상 역할이 비어 있던 '없음(역할 변경 기록 기준)'과 다르다), 반려 표에는 필요 승인 수 조각이 없고, 승인했지만 세지 않은 표는 '필요 승인 수에 세지 않음', 지문이 다르면 '(지금 요청과 다름)', 없으면 '승인 대상 지문 기록 없음(이 기능 도입 전 결정)'이다. 화면은 지문 네 묶음만 고정폭·한 줄로 보인다(글자는 CSV와 같다). 이메일·직함은 넣지 않는다.

## 주소 응답 (`GET /addresses`, `GET /addresses/:id`)

| 필드 | 뜻 |
| --- | --- |
| `findings` | 저장된 점검 결과 `[{code, level, message, action?, data?}]`. 유사 주소 경고(`ADDRESS_LOOKALIKE`)는 `data.matches[] = {id, label, status, address, prefix, suffix}`(최대 3건, 같은 글자 수가 많은 순). 확인(승인) 때 새로 찾은 유사 주소가 합쳐진다. 이 규칙 도입 전 등록분은 빈 배열 |
| `lookalikeReason` | 유사 주소가 있을 때 등록자가 남긴 사유. 없으면 null |
| `middle` | `{start, end}`: 다시 입력할 가운데 8자리의 위치(고유부 기준, 1부터, 양 끝 포함). 글자 자체는 따로 주지 않는다 |
| `openRequestCount` | 이 주소를 쓰는 진행 중(작성 중·검토 중·승인 대기) 출금 요청 수 |
| `status` | `PENDING_REVIEW`(확인 대기) → `COOLING_DOWN`(사용 대기) → `ACTIVE`(사용 가능), 또는 `REJECTED`·`DISABLED`. 확인 뒤 `policy.addressBook.cooldownHours`(기본 24시간, 설계 가정 A-31)가 지나야 사용 가능이 되며, 0이면 확인 즉시 사용 가능. 대기 시간이 끝난 주소는 목록·상세·출금 요청 검증 전에, 그리고 서버의 1초 주기 작업(공개 데모는 요청 시점 작업)에서 사용 가능으로 바뀌고 주소마다 감사 기록 `address.activated`(수행자 '시스템(사용 대기 종료)')를 남긴다 |
| `activeFrom` | 사용 대기가 끝나 출금 요청에 쓸 수 있게 되는(된) 시각(ISO). 대기 없이 확인된 주소와 이 규칙 도입 전 주소는 null |
| `outOfBand` | 다른 경로 확인 기록 `{receivedVia, receivedViaLabel, verifiedVia, verifiedViaLabel, verifiedWith}`(A-32). 이 기록 방식 도입 전 등록분은 null |
| `disabled` | 사용 중지·정지 기록 `{by, at, reason}`. 사용 대기 중 정지는 사유가 남는다. 이 기록 도입 전 사용 중지분은 null |
| `allowedActions` | `review`(등록자가 아닌 확인 담당자, 확인 대기일 때), `disable`(사용 가능·확인 대기), `stop`(사용 대기, 주소 등록·확인·사용 중지 권한 중 하나) |

## 거래 내역 응답 (`GET /activity`, 홈 최근 활동)

| 필드 | 뜻 |
| --- | --- |
| `counterpartyAddress` | 입금을 보낸 주소(기록된 경우만, 그 밖에는 null) |
| `poison` | 0원·소액 입금(자산별 소액 기준, A-33)이면서 보낸 주소가 기록된 입금에 붙는 주소 오염 의심 표시 `{reason: 'dust', lookalike}`. `lookalike`는 주소록에서 앞·뒤가 같은 가장 비슷한 주소 `{id, label, status, prefix, suffix}` 또는 null. 그 밖의 거래는 null |

## 감사 기록 검증 (`GET /audit/verify`)

```json
{ "ok": true, "count": 51, "brokenAtNo": null, "headHash": "64자 16진수" }
```
- `count`: 이 조직의 감사 기록 수. `brokenAtNo`: 처음 어긋난 기록이 조직 체인에서 몇 번째인지(1부터). 목록의 `orgSeq`, 화면의 '번호', CSV의 `순번`과 같은 번호다. 전체(모든 조직) 공용 순번은 다른 조직의 기록량을 드러내므로 응답에 넣지 않는다.
- `headHash`: 체인이 맞을 때만 가장 최근 기록의 해시. 어긋났거나 기록이 없으면 null.
- 체인 중간의 수정·삭제는 찾지만 **가장 최근 기록을 지운 경우는 `ok:true`로 나온다**. 감사 담당자가 `headHash`·`count`를 앱 밖에 보관해 두고 다음 검증 결과와 대조해야 알 수 있다.
- 새 기록은 해시 v2(수행자 이름 포함)로 쓴다. 기존 v1 기록은 v1으로 검증하며, v2 뒤의 v1 기록과 알 수 없는 방식은 어긋남으로 본다(A-24).
- `GET /audit` 목록 항목에는 `orgSeq`(필터 적용 전 조직 안 순번, 1부터)가 있다. 전체 공용 순번 `seq`는 조직마다 빈 번호가 생기고 다른 조직의 기록량을 드러내므로 싣지 않는다. 항목은 `id`로 구분한다.
- (A2-3) `request.approved`·`request.rejected` 항목에만 `evidence`(위 '결정 근거', 요청마다 한 번 계산. 표를 찾지 못하면 null)가 붙는다. 다른 행동 항목에는 이 키가 없다. 모든 조회는 조회자 조직으로 거른다.

## 감사 기록 CSV (`GET /audit/export.csv`)

UTF-8(BOM) CSV, 줄바꿈 CRLF. 목록과 같은 필터(`action`, `actor`, `q`, `from`, `to`)를 받고 최대 50,000행, 오래된 순. 파일 이름은 `koda-audit-YYYY-MM-DD.csv`(**한국 시간 날짜**).

**맨 위 표지(A2-4).** BOM 다음에 표지 행 묶음이 오고, 빈 줄 하나 뒤에 표가 온다. 표지는 내보낼 때 만든 설명이며 저장하지 않고 해시 대상이 아니다. 첫 줄은 한 칸 'KODA 감사 기록 내보내기 표지 — 내보낼 때 만든 설명이며 감사 기록이 아닙니다(해시 대상 아님)', 둘째 줄은 `항목,값`, 그다음은 두 열:

| 항목 | 값 |
| --- | --- |
| 기간 | `2026-09-01 ~ 2026-09-30 (한국 시간 날짜)`(한쪽만 있으면 '처음'·'지금'). 형식(`YYYY-MM-DD`)에 맞지 않아 걸리지 않은 값은 쓰지 않는다. 없으면 '전체 기간' |
| 조건 | `행동: 승인(request.approved) · 수행자: 오민재 · 내용 검색: WR-000001`. 없으면 '조건 없음'. 사용자가 넣은 값은 줄바꿈·탭을 공백으로 바꾸고, `=`·`+`·`-`·`@`로 시작하면 앞에 작은따옴표를 붙인다(예: `수행자: '=HYPERLINK(…)`) |
| 내보낸 행 | `11건 · 조건에 맞는 기록 11건`. 상한을 넘으면 `50,000건까지만 내보냈습니다 · 조건에 맞는 기록 n건` |
| 내보낸 사람 | `이름 (역할 이름, …)` |
| 내보낸 시각 | `YYYY-MM-DD HH:mm:ss (한국 시간)`(아래 `audit.exported` 기록 시각과 같다) |
| 해시 연결 확인(조직 전체) | 감사 기록 화면과 같은 A1 문장: '기록 n건이 각각 바로 앞 기록과 끊김 없이 이어져 있습니다(해시 연결 확인).' 또는 'n번 기록에서 해시가 맞지 않습니다. 보안 담당자에게 알리세요.'(조직 안 번호) |
| 보관용 값 | `기록 n건 · 마지막 기록 해시 … (이 내보내기 기록이 남기 전 값입니다. 내보낸 직후 감사 기록 화면은 이 내보내기 기록 1건이 더해져 건수가 1건 많고 마지막 기록 해시도 다릅니다)`(체인이 맞을 때만, 괄호 문장은 `AUDIT_EXPORT_TEXT.anchorNote`) |
| 확인 범위 | A1의 한계 문장(체인이 맞을 때만) |
| 안내 | '표지와 결정 근거 열은 내보낼 때 계산한 값입니다. 아래 표의 각 행과 해시 열은 저장된 기록 그대로입니다.' |

표지의 건수·마지막 해시는 행 조회·조건에 맞는 건수(COUNT)와 함께 `audit.exported`를 쓰기 전에 같은 트랜잭션에서 계산한다. 그래서 내보내기 직전 `GET /audit/verify`의 `count`·`headHash`와 같고, 내보낸 직후의 `count`는 1 많으며 `headHash`도 다르다(표지 '보관용 값' 칸이 이 차이를 함께 적는다. 해시된 행·`verifyChain`·`audit.exported` 상세는 그대로). **프로그램으로 읽을 때: 머리글은 표지 다음 빈 줄 뒤, `순번`으로 시작하는 첫 줄이다.** 빈 줄이 표 범위를 나누므로 스프레드시트의 정렬·필터는 표에만 걸린다.

**표 열(10개):** `순번`(목록의 `orgSeq`·화면의 '번호'·검증 결과의 `brokenAtNo`와 같은 조직 안 순번. 필터를 걸기 전에 매기므로 필터를 걸어도 같은 기록은 같은 순번이고, 필터 없이 내보내면 1부터 빈 번호 없이 이어진다), `시각(한국 시간)`(`YYYY-MM-DD HH:mm:ss`, KST), `수행자`, `행동`(화면과 같은 한국어 이름, `shared/terms.ts` `ACTION_LABEL`, 없는 코드는 코드 그대로), `행동 코드`(원래 코드, 예 `request.approved`), `대상 종류`, `대상 ID`, `내용`, `결정 근거(내보낼 때 계산)`(A2-3, 승인·반려 행에만 `decisionEvidenceText`, 다른 행은 빈칸), `해시`(마지막 열, 저장된 값 그대로).

표지와 표의 모든 셀에서 `=`·`+`·`-`·`@`·탭·CR로 시작하는 값은 앞에 작은따옴표를 붙여 스프레드시트에서 수식으로 실행되지 않게 한다. 내보내기 자체도 감사 기록(`audit.exported`)에 남으며, 상세는 `{filters, rowCount, matchedCount, truncated, chain: {ok, count, brokenAtNo, headHash}}`다(이 형식은 A2 뒤의 새 기록에만, 전체 공용 순번 `brokenAtSeq`는 쓰지 않는다). 감사 기록 행이 늘어나는 것은 이 한 건뿐이다.

## 공개 데모 세션

공개 데모(`DEMO_PUBLIC=1`)의 `koda_sid`는 저장소 세션 id가 아니라 `{v:1, sid, uid, org, iat, exp}`를 `DEMO_SESSION_SECRET`(32바이트 이상)으로 HMAC-SHA256 서명한 무상태 쿠키다(A-23). 어느 함수 인스턴스든 같은 키로 서명과 만료를 확인하므로 요청이 다른 인스턴스로 가도 로그인이 유지된다. 사용자·역할은 요청마다 응답한 인스턴스의 데이터에서 다시 읽고, CSRF 값은 세션에서 계산한다. 서버에서 강제로 끊을 수 없어(로그아웃은 쿠키 삭제) 수명을 짧게(기본 120분) 둔다. 로컬 실행은 기존 저장소 세션(로그아웃 때 서버 폐기)이며 서명 쿠키를 받지 않는다.

## 상태 확인 (`GET /healthz`)

```json
{ "ok": true, "env": "development", "authMode": "dev", "custody": "모의 커스터디(개발용)", "mode": "local", "instanceId": "uuid", "seededAt": null }
```
`mode`는 `local` 또는 `public-demo`. `seededAt`은 이번 기동에서 모의 데이터를 새로 만든 시각(기존 DB를 이어 쓰면 null). 공개 데모의 `/api` 응답에는 `X-Demo-Instance`(인스턴스 id) 헤더가 붙고, 화면은 이 탭이 처음 보는 인스턴스가 응답하면 '다른 데모 서버로 연결되었습니다' 안내를 보인다. 로그인은 서명된 세션 쿠키라 유지되고, 데이터는 인스턴스마다 따로라 방금 만든 요청·주소가 없을 수 있다. 이미 본 인스턴스로 돌아갈 때는 다시 띄우지 않는다. `GET /me`의 `environment`에도 `mode`·`instanceId`·`seededAt`이 있다.

## 경로
| 메서드·경로 | 권한 | 설명 |
| --- | --- | --- |
| GET /healthz | 공개 | 상태(위 형식) |
| GET /auth/dev-users, POST /auth/dev-login, POST /auth/logout | 개발 모드 | 모의 로그인 |
| GET /me | 로그인 | 사용자·조직·역할·권한·CSRF·환경·정책 |
| GET /dashboard | dashboard.read | 보유 자산, 할 일, 진행 요청, 최근 활동. 할 일 `kind`: `approve_requests`(받는 주소가 사용 가능한 요청만), `blocked_requests`(승인자, 받는 주소가 사용 중지되어 승인할 수 없는 요청), `review_addresses`, `cooling_addresses`(사용 대기 중인 주소, 주소 등록·확인·사용 중지 권한자에게 경고), `my_drafts`, `my_rejected`, `my_blocked_requests`(요청자 본인), `my_pending_addresses`, `audit_recent`. 진행 중 요청의 `approved`는 승인 대기면 지금 유효한 표 수, `amount`는 저장 값을 읽을 수 없으면 null. (A2-1) 진행 중 요청에는 `submittedAt`(승인 요청 시각, 제출 전이면 null)과 `waitingFor`(승인 대기이고 승인할 수 있는 요청이면 요청 상세 `approvalWait.candidates`와 같은 `[{id, name}]`, 그 밖에는 null)가 있다. `waitingFor`는 조회자에게 `request.read`가 있을 때만 채우고, 조직의 승인 후보는 한 번만 읽으며, 계산할 수 없는 요청(저장 수량을 읽을 수 없는 요청 등)은 null로 두어 홈이 실패하지 않는다. 최근 활동 행에는 `poison`(위 거래 내역 응답) |
| GET /balances, /wallets, /staking, /catalog | 각 read | 잔고·지갑·스테이킹·지원 자산 |
| GET /activity?type&assetCode&status&q&from&to&order&page&pageSize | activity.read | 거래 내역(페이지 10/25/50/100) |
| GET /addresses?status&assetCode&networkCode&q&sort, GET /addresses/:id | address.read | 주소록, 상세+이력(위 주소 응답) |
| POST /addresses/check | address.read | 형식·중복·유사 주소·주소 오염(최근 90일 0원·소액 입금을 보낸 주소) 점검(저장 안 함). 중복은 확인 대기·사용 대기·사용 가능 주소만, 유사 주소는 모든 상태와 비교 |
| POST /addresses | address.create | 등록 → PENDING_REVIEW. `confirmTail`, `confirmMiddle`, `ackNotVerified`, `ackOutOfBandConfirmed`, `receivedVia`(`email`·`messenger`·`document`·`phone`·`in_person`·`other`), `verifiedVia`(`registered_phone`·`in_person`·`video_call`·`signed_document`·`other`), `verifiedWith`(1~100자) 필수, 유사 주소가 있으면 `lookalikeReason`(300자 이내, 위 필수 사유 규칙). 같은 경로면 `OUT_OF_BAND_SAME_CHANNEL`, 소액 입금을 보낸 주소와 같으면 `ADDRESS_POISON_SUSPECTED`. 공개 데모는 `DEMO_LIMIT` |
| POST /addresses/:id/review `{decision, note, version, confirmTail, confirmMiddle}` | address.review(등록자 제외) | 확인/거절. 확인은 끝자리·가운데 대조, 유사 주소가 있으면 `note`(필수 사유 규칙, 채우지 못하면 `NOTE_REQUIRED`), 재점검 결과 새 유사 주소가 있으면 409 `LOOKALIKE_UPDATED`, 소액 입금을 보낸 주소와 같아졌으면 422 `ADDRESS_POISON_SUSPECTED`(찾은 결과를 `findings`에 저장하고 `version`을 올리고 `address.findings_updated`를 남긴 뒤 거부한다. 다시 결정하려면 주소를 다시 불러와 새 `version`을 보낸다. 위 오류 코드 표). 거절은 `note`(필수 사유 규칙, 채우지 못하면 422 `VALIDATION`). 확인하면 `COOLING_DOWN`(`activeFrom` = 확인 시각 + 대기 시간), 대기 시간 0이면 바로 `ACTIVE` |
| POST /addresses/:id/disable `{version}` | address.disable | 사용 중지(사용 가능·확인 대기). 사용 대기 중이면 409 `USE_COOLDOWN_STOP`. 이 주소를 쓰는 승인 대기 요청은 승인할 수 없게 되며(`blockedReason`), 반려·취소 때까지 예약 유지 |
| POST /addresses/:id/stop `{version, reason}` | address.create·address.review·address.disable 중 하나 | 사용 대기 중 정지: 사용 대기 주소를 바로 `DISABLED`로 바꾸고 사유(300자 이내, 필수 사유 규칙, 채우지 못하면 422 `VALIDATION`)를 남긴다(감사 기록 `address.cooldown_stopped`). 사용 대기가 아니면 409 `NOT_COOLING_DOWN` |
| GET /requests?view(mine\|to_approve\|blocked)&status(csv)&q&order&page&pageSize, GET /requests/:id | request.read | 목록(상태별 건수 `counts`는 보기·검색 조건을 따르고 상태 필터만 무시), 상세(허용 행동·처리 기록·사용 가능 수량, A2의 `approvalWait`와 표마다 결정 근거). 다른 조직 요청은 404, `request.read`가 없으면 403. `to_approve`는 받는 주소가 사용 가능한 요청만, `blocked`는 받는 주소가 사용 가능하지 않은 승인 대기 요청(조직 전체) |
| POST /requests, PUT /requests/:id | request.create | 초안 작성·수정. 작성에는 `Idempotency-Key`가 필요하다(없으면 400 `IDEMPOTENCY_KEY_REQUIRED`). 요청 번호는 조직 안 번호. 수정은 작성자만(403 `NOT_REQUEST_OWNER`). 공개 데모는 `DEMO_LIMIT`(작성) |
| POST /requests/checks-preview `{assetCode, networkCode, addressId, amount, requestId?}` | request.create | 작성 화면의 출금 전 점검 미리 보기 `{evaluatedAt, items}`(저장 안 함). 초안과 같은 입력 검증(`ADDRESS_NOT_ACTIVE` 등). `requestId`는 고치는 중인 초안을 과거 기록·건수에서 뺀다 |
| POST /requests/:id/review \| back-to-draft \| submit \| cancel | request.create(작성자) | 상태 전이. 검토 이동·제출은 저장된 수량을 읽을 수 없으면 422 `AMOUNT_UNREADABLE`(되돌리기·취소는 된다). submit 본문 `{version, confirmTail, ackIrreversible, checkReasons?}`: `checkReasons`는 점검 id → 진행 사유(300자 이내, 알 수 없는 id는 422). 서버가 제출 시점 기준으로 점검을 다시 계산하고, 사유가 필요한 주의 항목에 글자·숫자 5자 이상 사유가 없으면 `CHECK_REASON_REQUIRED`(저장하는 사유에서는 보이지 않는 서식 문자를 지운다). 통과하면 지문(`intentHash`)과 점검 결과·사유, 실제로 예약한 지갑·자산·수량을 바꿀 수 없는 기록으로 저장하고 감사 기록 `request.submitted`에 지문·점검 결과·사유를 남긴다. 승인 가능 인원 부족 시 `APPROVERS_INSUFFICIENT` |
| POST /requests/:id/approve `{version, intentHash}` \| reject `{version, reason, intentHash}` | request.approve(작성자 제외) | 승인 / 반려(`reason` 500자 이내, 필수 사유 규칙, 채우지 못하면 422 `VALIDATION`). `intentHash`는 요청 응답의 값을 그대로 보낸다(없으면 422, 다르면 409 `INTENT_CHANGED`, 지문 없는 이전 요청의 승인은 409 `INTENT_MISSING`, 반려는 `null`). 검사 순서: 권한 → 요청(404) → 자기 승인 → 이미 결정 → 상태·버전 → 지문 → 저장 내용 재계산(`INTENT_TAMPERED`) → 받는 주소(`ADDRESS_NOT_ACTIVE`). 승인 표마다 지문을 남기고, 정족수가 차면 커스터디로 넘기기 직전에 다시 계산·대조한 뒤 지문과 함께 넘긴다. 반려·취소(승인 대기)는 지금 행의 수량이 아니라 승인 요청 때 예약 기록으로 예약을 풀고, 감사 기록 상세에 `released`(푼 수량)·`releasedAssetCode`와 지문이 있는 요청이면 `contentMatchesIntent`(지금 내용이 지문과 같은지)를 남긴다 |
| GET /org/members, GET /org/policy | org.read | 구성원·정책(`approval`, `addressBook`, `withdrawalChecks`, `isDesignAssumption: true`) |
| PUT /org/members/:id/roles `{roles, rolesVersion}` | org.manage | 역할 변경(감사 기록). 본인 관리자 해제·마지막 관리자 해제·본인에게 승인자/자산 담당자 부여 금지 |
| GET /audit, GET /audit/verify, GET /audit/export.csv | audit.read / audit.export | 감사 기록(`orgSeq`, 승인·반려 항목의 `evidence`), 해시 체인 검증(위 형식), CSV(맨 위 표지 + 10열, 위 형식) |
| GET /insights?provider&q&offset&limit&related&includeHidden, GET /insights/providers | insight.read | 인사이트(고객: 게시+화이트리스트만). `limit` 1~50(기본 12), 응답 `{total, offset, limit, items}`. `includeHidden=1`은 insight.manage만 숨김·화이트리스트 밖 자료 포함 |
| POST /insights, PATCH /insights/:id `{status}` | insight.manage | 운영자 게시·숨김. 게시와 다시 게시 모두 화이트리스트·기관 도메인 확인. 공개 데모는 `DEMO_LIMIT`(게시) |
