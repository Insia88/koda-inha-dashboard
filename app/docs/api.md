# API 계약 (요약)

모든 경로는 `/api` 아래, JSON. 인증은 `koda_sid` HttpOnly 쿠키(공개 데모에서는 Secure 추가). 변경 요청(POST/PUT/PATCH)은 `X-CSRF-Token` 헤더(`GET /api/me`의 `csrfToken`) 필수. 다른 조직의 리소스는 존재 여부를 숨기기 위해 404. `/api` 응답은 모두 `Cache-Control: no-store`.

## 오류 형식
```json
{ "error": { "code": "ADDRESS_NETWORK_MISMATCH", "message": "원인(한국어)", "action": "복구 행동", "fields": [{ "field": "addressId", "message": "..." }] }, "requestId": "uuid" }
```
상태 코드: 401 로그인 필요, 403 권한 없음·자기 승인(`SELF_APPROVAL_FORBIDDEN`)·자기 주소 확인(`SELF_REVIEW_FORBIDDEN`)·CSRF, 404 없음/타 조직, 409 상태 충돌(`INVALID_TRANSITION`, `VERSION_CONFLICT`, `ALREADY_DECIDED`, `LOOKALIKE_UPDATED`, `USE_COOLDOWN_STOP`, `NOT_COOLING_DOWN`, `INTENT_CHANGED`, `INTENT_MISSING`, `INTENT_TAMPERED`), 422 입력·업무 규칙 오류, 429 요청 한도, 500 내부 오류(변경 롤백).

오류에 따라 `error` 안에 추가 필드가 붙는다(아래 오류 코드 표의 '추가 필드'). 409 `INVALID_TRANSITION`·`VERSION_CONFLICT`는 `status`(와 `version`), 주소 점검 오류는 `findings`를 준다.

### 오류 코드 (2026-10-19 추가·변경분)

| 코드 | 상태 | 언제 | `fields[].field` | 추가 필드 |
| --- | --- | --- | --- | --- |
| `AMOUNT_FORMAT` | 422 | 수량 형식 오류. 쉼표는 천 단위 자리(예: `1,000`, `12,345.5`)에만 쓸 수 있고 `1,5`·`1,,000`·`1,000,` 등은 거부. 소수점은 마침표 | `amount` | — |
| `CONFIRM_MIDDLE_MISMATCH` | 422 | 주소 등록·확인(승인) 때 다시 입력한 고유부 가운데 8자리가 다름(대소문자 무시). 끝자리 검사(`CONFIRM_TAIL_MISMATCH`) 다음에 검사 | `confirmMiddle` | — |
| `REASON_REQUIRED` | 422 | 주소 등록 때 유사 주소가 있는데 `lookalikeReason`이 5자 미만 | `lookalikeReason` | `findings` |
| `NOTE_REQUIRED` | 422 | 주소 확인(승인) 때 저장된 점검 결과에 유사 주소가 있는데 `note`가 5자 미만 | `note` | — |
| `LOOKALIKE_UPDATED` | 409 | 주소 확인(승인) 때 다시 점검해 저장된 점검 결과에 없던 유사 주소를 찾음. 점검 결과(`findings`)와 `version`을 갱신해 저장하고 승인하지 않는다. 화면은 주소를 다시 불러와 비교를 보여 준 뒤 메모와 함께 다시 확인 | — | — |
| `ADDRESS_NOT_ACTIVE` | 422 | 사용 가능 상태가 아닌 주소로 초안·수정·검토 이동·제출·점검 미리 보기(입력 오류), 또는 받는 주소가 사용 중지된 요청의 승인. **사용 대기(`COOLING_DOWN`) 주소**는 메시지에 사용 가능 시각(`YYYY-MM-DD HH:mm KST`)을, 행동에 '기다린 뒤 다시 요청, 요청한 적 없는 등록이면 승인자에게 사용 대기 중 정지 요청'을 담는다 | `addressId`(초안·제출) | 사용 대기일 때 `addressStatus: 'COOLING_DOWN'`, `activeFrom` |
| `APPROVERS_INSUFFICIENT` | 422 | 승인 요청 제출 때, 작성자를 뺀 지금 승인할 수 있는 사람이 필요한 승인 수보다 적음. 아무것도 예약하지 않음 | — | `eligibleApprovers`, `requiredApprovals`, `approvalBasis` |
| `SELF_ROLE_ESCALATION` | 422 | 역할 변경에서 자기 자신에게 승인자·자산 담당자 역할을 새로 부여 | — | — |
| `PROVIDER_NOT_WHITELISTED` | 422 | 화이트리스트 밖 기관 자료 게시, **숨긴 자료를 다시 게시**(PATCH `published`)할 때도 | `providerId` | — |
| `PROVIDER_DOMAIN_MISMATCH` | 422 | 원문 링크의 호스트가 제공 기관 홈페이지 호스트와 다름(모든 모드, 게시와 다시 게시) | `url` | — |
| `DEMO_LIMIT` | 422 | 공개 데모에서만. 인스턴스당 사용자가 새로 만든 주소 등록·출금 요청·인사이트 게시가 종류별 200건에 도달 | — | — |

### 오류 코드 (wave 3A: 주소 수명 주기·공개 데모 세션)

| 코드 | 상태 | 언제 | `fields[].field` | 추가 필드 |
| --- | --- | --- | --- | --- |
| `OUT_OF_BAND_SAME_CHANNEL` | 422 | 주소 등록에서 주소를 받은 경로(`receivedVia`)와 다시 확인한 경로(`verifiedVia`)가 같음 | `verifiedVia` | — |
| `ADDRESS_POISON_SUSPECTED` | 422 | 등록하려는 주소(또는 확인하려는 확인 대기 주소)가 최근 90일 안에 0원·소액 입금을 보낸 주소와 같음(주소 오염 의심). 확인 때는 등록 뒤에 들어온 입금도 본다 | `address`(등록) | `findings`(등록) |
| `USE_COOLDOWN_STOP` | 409 | 사용 대기 중인 주소에 일반 사용 중지(`/disable`)를 요청함. 사유와 함께 `/stop`을 써야 한다 | — | — |
| `NOT_COOLING_DOWN` | 409 | 사용 대기가 아닌 주소에 `/stop`을 요청함(이미 사용 가능이면 조직 관리자의 사용 중지를 안내) | — | `status` |

`ADDRESS_POISON_LOOKALIKE`(경고, 저장된 `findings`에만)는 최근 소액 입금을 보낸 주소와 앞·뒤만 같은 주소다. 공개 데모 세션 쿠키가 변조·만료·다른 서명 값·형식 오류이면 401 `UNAUTHENTICATED`다.

### 오류 코드 (WP-11: 승인 대상 지문·출금 전 점검)

| 코드 | 상태 | 언제 | `fields[].field` | 추가 필드 |
| --- | --- | --- | --- | --- |
| `CHECK_REASON_REQUIRED` | 422 | 승인 요청(`/submit`) 때 사유가 필요한 주의 항목(처음 보내는 주소, 과거 출금 중앙값의 5배 초과, 사용 가능 수량의 50% 이상)에 5자 이상 진행 사유가 없음. 빠진 항목마다 필드 오류. 아무것도 예약하지 않고 검토 중으로 남는다. 끝자리 검사(`CONFIRM_TAIL_MISMATCH`)·사용 가능 수량 검사 다음, 승인 가능 인원 검사(`APPROVERS_INSUFFICIENT`) 앞 | `checkReasons.<점검 id>` | `checkIds` |
| `INTENT_CHANGED` | 409 | 승인·반려 본문의 `intentHash`가 제출 때 고정한 지문과 다름(대소문자 무시). 승인 표를 남기지 않는다 | — | `intentHashDisplay`(지금 지문) |
| `INTENT_MISSING` | 409 | 지문 기록 전(이 기능 도입 전)에 제출된 승인 대기 요청의 승인. 대조할 지문이 없어 거부한다(fail closed). 반려는 `intentHash: null`로 할 수 있다 | — | — |
| `INTENT_TAMPERED` | 409 | 승인할 때와 커스터디로 넘기기 직전에 저장된 행으로 지문을 다시 계산했더니 제출 때 지문과 다르거나, 정족수에 든 승인 표 중 같은 지문을 승인하지 않은 표가 있음. 승인 트랜잭션을 되돌려 처리 중으로 넘기지 않고 커스터디를 부르지 않는다. 별도 트랜잭션으로 감사 기록 `request.intent_tampered`(수행자 '시스템(승인 대상 지문 재확인)', 상세: `stage`(`approve`·`handoff`), `storedHash`, `recomputedHash`, `mismatchedApproverIds`, `attemptedBy`, 끝자리만 담은 `current`, `custodyCalled: false`)를 남긴다. 반려는 막지 않는다 | — | — |
| `VALIDATION` | 422 | 승인·반려 본문에 `intentHash`가 없음 | `intentHash` | — |

## 멱등성
`Idempotency-Key`(8~80자 영숫자·`_-`). `POST /api/requests`는 필수, 요청 행동(`/review`, `/submit`, `/approve`, `/reject`, `/cancel`, `/back-to-draft`)은 선택. 같은 사용자·경로·키 + 같은 본문이면 처음 응답을 재전송(`Idempotent-Replayed: true`), 다른 본문이면 422 `IDEMPOTENCY_KEY_REUSED`.

커스터디 접수(서버 내부)는 요청 id를 멱등 키로 넘긴다. 같은 키로 다시 접수하면 같은 접수 참조(`custodyRef`)를 돌려받는다(설계 가정 A-18). 접수 입력에는 승인 대상 지문(`intentHash`)도 함께 넘기며, 모의 어댑터는 키별로 지문을 기록하고 같은 키에 다른 지문이 오면 받지 않는다(A-30).

`INTENT_TAMPERED`로 거부된 승인은 멱등 기록을 남기지 않는다(같은 키로 다시 보내면 다시 확인하고 다시 거부한다).

## 동시성
요청·주소·역할 변경은 `version`(역할은 `rolesVersion`)을 본문에 보내야 하며 다르면 409. 쓰기는 `BEGIN IMMEDIATE` 트랜잭션.

## 금액
요청 본문의 `amount`는 10진 문자열(예 `"2500.25"`, 천 단위 쉼표 허용 `"1,000"`), 자산 자릿수 초과 시 422 `AMOUNT_PRECISION`. 응답은 `amount`(표시용 10진 문자열)와 `amountUnits`(최소 단위 정수 문자열)를 함께 준다. 원화 값은 원 단위 정수 문자열.

## 출금 요청 응답 (`GET /requests/:id`, 행동 응답)

| 필드 | 뜻 |
| --- | --- |
| `requiredApprovals` | 제출 때 정한 필요 승인 수 |
| `approvedCount` | 정족수에 들어간 승인 수. 승인 대기 중에는 지금 유효한 표(같은 조직 활성 사용자, 지금 승인 권한 있음, 작성자 아님)만 센다. 결정이 끝난 요청은 결정 당시 저장한 목록 기준(목록이 없는 이전 요청은 당시 승인 표 전체) |
| `approvals[]` | `{userId, name, decision('approved'\|'rejected'), reason, createdAt, counted}`. `counted`는 이 표가 정족수에 들어갔는지이며 반려 표는 항상 false |
| `approvalBasis` | 필요 승인 수의 근거: `value_below_threshold`, `value_at_or_above_threshold`, `price_missing`(시세 없음), `price_stale`(30분 초과·읽을 수 없음·5분 넘게 미래). 뒤의 둘은 고액 기준 적용. 제출 전이거나 이 필드 도입 전 요청은 null |
| `priceAsOfAtSubmit` | 제출 때 쓴 시세 기준 시각(ISO). 시세가 없었으면 null |
| `krwValueAtSubmit` | 제출 때 원화 평가액(원 단위 정수 문자열) 또는 null |
| `blockedReason` | 승인 대기 요청을 승인할 수 없는 이유. 지금은 받는 주소가 사용 가능 상태가 아닐 때의 `ADDRESS_NOT_ACTIVE`뿐이며, 이때 `allowedActions`에는 `approve`가 없고 `reject`만 남는다(승인자). 그 밖에는 null |
| `allowedActions` | 지금 사용자에게 허용된 행동(서버 계산). 목록 응답에서는 빈 배열. 지문이 없는 이전 승인 대기 요청에는 `approve`가 없다 |
| `custodyRef` | 커스터디 접수 참조(모의) |
| `intentHash` | 승인 대상 지문(16진수 소문자 64자). 승인 요청(제출) 때 정규화 JSON `{v:1, requestId, orgId, assetCode, networkCode, amountUnits, addressId, address(네트워크 계열 규칙으로 정규화), memo, requiredApprovals}`(키 정렬, 공백 없음)의 SHA-256으로 정하고 바꾸지 않는다. 제출 전·이 기능 도입 전 요청은 null. 목록 응답에도 있다 |
| `intentHashDisplay` | 화면 표시용 지문: 앞 16자를 대문자 4자 묶음으로(예 `7F3A 91C2 0B4E 55D1`). 없으면 null |
| `approvals[].intentHash`, `approvals[].intentHashDisplay` | 그 사람이 승인·반려할 때 본 지문. 이 기능 도입 전 표는 null |
| `checks` | 상세 응답에만. 출금 전 점검 `{evaluatedAt, stored, items[]}`. 작성·검토 중이면 볼 때마다 다시 계산(`stored: false`), 승인 요청 뒤에는 제출 때 저장한 결과와 요청자 사유(`stored: true`). 점검 기록 전에 제출된 요청은 null |
| `checks.items[]` | `{id, label, outcome, detail, basis, requiresReason, reason?}`. `id`: `first_use`·`amount_history`·`balance_share`·`recent_burst`·`price`(이 순서). `outcome`: `pass`(기준 이내)·`caution`(주의)·`unknown`(확인 불가, 기준 이내로 보이지 않음). `requiresReason`은 주의이면서 진행 사유가 필요한 항목. `reason`은 제출 때 저장한 사유(제출 전·사유 없음은 null). 기준값은 `GET /org/policy`의 `withdrawalChecks`(설계 가정 A-27) |

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
{ "ok": true, "count": 51, "brokenAtSeq": null, "brokenAtNo": null, "headHash": "64자 16진수" }
```
- `count`: 이 조직의 감사 기록 수. `brokenAtSeq`: 처음 어긋난 기록의 전체 공용 순번. `brokenAtNo`: 그 기록이 조직 체인에서 몇 번째인지(1부터). 화면은 `brokenAtNo`와 목록의 `orgSeq`를 쓴다.
- `headHash`: 체인이 맞을 때만 가장 최근 기록의 해시. 어긋났거나 기록이 없으면 null.
- 체인 중간의 수정·삭제는 찾지만 **가장 최근 기록을 지운 경우는 `ok:true`로 나온다**. 감사 담당자가 `headHash`·`count`를 앱 밖에 보관해 두고 다음 검증 결과와 대조해야 알 수 있다.
- 새 기록은 해시 v2(수행자 이름 포함)로 쓴다. 기존 v1 기록은 v1으로 검증하며, v2 뒤의 v1 기록과 알 수 없는 방식은 어긋남으로 본다(A-24).
- `GET /audit` 목록 항목에는 `orgSeq`(필터 적용 전 조직 안 순번, 1부터)가 있다.

## 감사 기록 CSV (`GET /audit/export.csv`)

UTF-8(BOM) CSV, 줄바꿈 CRLF. 목록과 같은 필터(`action`, `actor`, `q`, `from`, `to`)를 받고 최대 50,000행, 오래된 순. 열:

`순번`(전체 공용 순번 `seq`), `시각(한국 시간)`(`YYYY-MM-DD HH:mm:ss`, KST), `수행자`, `행동`(화면과 같은 한국어 이름, `shared/terms.ts` `ACTION_LABEL`, 없는 코드는 코드 그대로), `행동 코드`(원래 코드, 예 `request.approved`), `대상 종류`, `대상 ID`, `내용`, `해시`.

`=`·`+`·`-`·`@`·탭·CR로 시작하는 값은 앞에 작은따옴표를 붙여 스프레드시트에서 수식으로 실행되지 않게 한다. 내보내기 자체도 감사 기록(`audit.exported`)에 남는다.

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
| GET /dashboard | dashboard.read | 보유 자산, 할 일, 진행 요청, 최근 활동. 할 일 `kind`: `approve_requests`(받는 주소가 사용 가능한 요청만), `blocked_requests`(승인자, 받는 주소가 사용 중지되어 승인할 수 없는 요청), `review_addresses`, `cooling_addresses`(사용 대기 중인 주소, 주소 등록·확인·사용 중지 권한자에게 경고), `my_drafts`, `my_rejected`, `my_blocked_requests`(요청자 본인), `my_pending_addresses`, `audit_recent`. 진행 중 요청의 `approved`는 승인 대기면 지금 유효한 표 수. 최근 활동 행에는 `poison`(위 거래 내역 응답) |
| GET /balances, /wallets, /staking, /catalog | 각 read | 잔고·지갑·스테이킹·지원 자산 |
| GET /activity?type&assetCode&status&q&from&to&order&page&pageSize | activity.read | 거래 내역(페이지 10/25/50/100) |
| GET /addresses?status&assetCode&networkCode&q&sort, GET /addresses/:id | address.read | 주소록, 상세+이력(위 주소 응답) |
| POST /addresses/check | address.read | 형식·중복·유사 주소·주소 오염(최근 90일 0원·소액 입금을 보낸 주소) 점검(저장 안 함). 중복은 확인 대기·사용 대기·사용 가능 주소만, 유사 주소는 모든 상태와 비교 |
| POST /addresses | address.create | 등록 → PENDING_REVIEW. `confirmTail`, `confirmMiddle`, `ackNotVerified`, `ackOutOfBandConfirmed`, `receivedVia`(`email`·`messenger`·`document`·`phone`·`in_person`·`other`), `verifiedVia`(`registered_phone`·`in_person`·`video_call`·`signed_document`·`other`), `verifiedWith`(1~100자) 필수, 유사 주소가 있으면 `lookalikeReason`(5~300자). 같은 경로면 `OUT_OF_BAND_SAME_CHANNEL`, 소액 입금을 보낸 주소와 같으면 `ADDRESS_POISON_SUSPECTED`. 공개 데모는 `DEMO_LIMIT` |
| POST /addresses/:id/review `{decision, note, version, confirmTail, confirmMiddle}` | address.review(등록자 제외) | 확인/거절. 확인은 끝자리·가운데 대조, 유사 주소가 있으면 `note` 5자 이상, 재점검 결과 새 유사 주소가 있으면 409 `LOOKALIKE_UPDATED`, 소액 입금을 보낸 주소와 같아졌으면 `ADDRESS_POISON_SUSPECTED`. 확인하면 `COOLING_DOWN`(`activeFrom` = 확인 시각 + 대기 시간), 대기 시간 0이면 바로 `ACTIVE` |
| POST /addresses/:id/disable `{version}` | address.disable | 사용 중지(사용 가능·확인 대기). 사용 대기 중이면 409 `USE_COOLDOWN_STOP`. 이 주소를 쓰는 승인 대기 요청은 승인할 수 없게 되며(`blockedReason`), 반려·취소 때까지 예약 유지 |
| POST /addresses/:id/stop `{version, reason}` | address.create·address.review·address.disable 중 하나 | 사용 대기 중 정지: 사용 대기 주소를 바로 `DISABLED`로 바꾸고 사유(5~300자)를 남긴다(감사 기록 `address.cooldown_stopped`). 사용 대기가 아니면 409 `NOT_COOLING_DOWN` |
| GET /requests?view(mine\|to_approve\|blocked)&status(csv)&q&order&page&pageSize, GET /requests/:id | request.read | 목록(상태별 건수 `counts`는 보기·검색 조건을 따르고 상태 필터만 무시), 상세(허용 행동·처리 기록·사용 가능 수량). `to_approve`는 받는 주소가 사용 가능한 요청만, `blocked`는 받는 주소가 사용 가능하지 않은 승인 대기 요청(조직 전체) |
| POST /requests, PUT /requests/:id | request.create | 초안 작성·수정. 공개 데모는 `DEMO_LIMIT`(작성) |
| POST /requests/checks-preview `{assetCode, networkCode, addressId, amount, requestId?}` | request.create | 작성 화면의 출금 전 점검 미리 보기 `{evaluatedAt, items}`(저장 안 함). 초안과 같은 입력 검증(`ADDRESS_NOT_ACTIVE` 등). `requestId`는 고치는 중인 초안을 과거 기록·건수에서 뺀다 |
| POST /requests/:id/review \| back-to-draft \| submit \| cancel | request.create(작성자) | 상태 전이. submit 본문 `{version, confirmTail, ackIrreversible, checkReasons?}`: `checkReasons`는 점검 id → 진행 사유(300자 이내, 알 수 없는 id는 422). 서버가 제출 시점 기준으로 점검을 다시 계산하고, 사유가 필요한 주의 항목에 5자 이상 사유가 없으면 `CHECK_REASON_REQUIRED`. 통과하면 지문(`intentHash`)과 점검 결과·사유를 바꿀 수 없는 기록으로 저장하고 감사 기록 `request.submitted`에 지문·점검 결과·사유를 남긴다. 승인 가능 인원 부족 시 `APPROVERS_INSUFFICIENT` |
| POST /requests/:id/approve `{version, intentHash}` \| reject `{version, reason, intentHash}` | request.approve(작성자 제외) | 승인 / 반려(`reason` 5~500자). `intentHash`는 요청 응답의 값을 그대로 보낸다(없으면 422, 다르면 409 `INTENT_CHANGED`, 지문 없는 이전 요청의 승인은 409 `INTENT_MISSING`, 반려는 `null`). 검사 순서: 권한 → 요청(404) → 자기 승인 → 이미 결정 → 상태·버전 → 지문 → 저장 내용 재계산(`INTENT_TAMPERED`) → 받는 주소(`ADDRESS_NOT_ACTIVE`). 승인 표마다 지문을 남기고, 정족수가 차면 커스터디로 넘기기 직전에 다시 계산·대조한 뒤 지문과 함께 넘긴다 |
| GET /org/members, GET /org/policy | org.read | 구성원·정책(`approval`, `addressBook`, `withdrawalChecks`, `isDesignAssumption: true`) |
| PUT /org/members/:id/roles `{roles, rolesVersion}` | org.manage | 역할 변경(감사 기록). 본인 관리자 해제·마지막 관리자 해제·본인에게 승인자/자산 담당자 부여 금지 |
| GET /audit, GET /audit/verify, GET /audit/export.csv | audit.read / audit.export | 감사 기록(`orgSeq`), 해시 체인 검증(위 형식), CSV |
| GET /insights?provider&q&offset&limit&related&includeHidden, GET /insights/providers | insight.read | 인사이트(고객: 게시+화이트리스트만). `limit` 1~50(기본 12), 응답 `{total, offset, limit, items}`. `includeHidden=1`은 insight.manage만 숨김·화이트리스트 밖 자료 포함 |
| POST /insights, PATCH /insights/:id `{status}` | insight.manage | 운영자 게시·숨김. 게시와 다시 게시 모두 화이트리스트·기관 도메인 확인. 공개 데모는 `DEMO_LIMIT`(게시) |
