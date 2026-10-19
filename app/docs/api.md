# API 계약 (요약)

모든 경로는 `/api` 아래, JSON. 인증은 `koda_sid` HttpOnly 쿠키(공개 데모에서는 Secure 추가). 변경 요청(POST/PUT/PATCH)은 `X-CSRF-Token` 헤더(`GET /api/me`의 `csrfToken`) 필수. 다른 조직의 리소스는 존재 여부를 숨기기 위해 404. `/api` 응답은 모두 `Cache-Control: no-store`.

## 오류 형식
```json
{ "error": { "code": "ADDRESS_NETWORK_MISMATCH", "message": "원인(한국어)", "action": "복구 행동", "fields": [{ "field": "addressId", "message": "..." }] }, "requestId": "uuid" }
```
상태 코드: 401 로그인 필요, 403 권한 없음·자기 승인(`SELF_APPROVAL_FORBIDDEN`)·자기 주소 확인(`SELF_REVIEW_FORBIDDEN`)·CSRF, 404 없음/타 조직, 409 상태 충돌(`INVALID_TRANSITION`, `VERSION_CONFLICT`, `ALREADY_DECIDED`, `LOOKALIKE_UPDATED`), 422 입력·업무 규칙 오류, 429 요청 한도, 500 내부 오류(변경 롤백).

오류에 따라 `error` 안에 추가 필드가 붙는다(아래 오류 코드 표의 '추가 필드'). 409 `INVALID_TRANSITION`·`VERSION_CONFLICT`는 `status`(와 `version`), 주소 점검 오류는 `findings`를 준다.

### 오류 코드 (2026-10-19 추가·변경분)

| 코드 | 상태 | 언제 | `fields[].field` | 추가 필드 |
| --- | --- | --- | --- | --- |
| `AMOUNT_FORMAT` | 422 | 수량 형식 오류. 쉼표는 천 단위 자리(예: `1,000`, `12,345.5`)에만 쓸 수 있고 `1,5`·`1,,000`·`1,000,` 등은 거부. 소수점은 마침표 | `amount` | — |
| `CONFIRM_MIDDLE_MISMATCH` | 422 | 주소 등록·확인(승인) 때 다시 입력한 고유부 가운데 8자리가 다름(대소문자 무시). 끝자리 검사(`CONFIRM_TAIL_MISMATCH`) 다음에 검사 | `confirmMiddle` | — |
| `REASON_REQUIRED` | 422 | 주소 등록 때 유사 주소가 있는데 `lookalikeReason`이 5자 미만 | `lookalikeReason` | `findings` |
| `NOTE_REQUIRED` | 422 | 주소 확인(승인) 때 저장된 점검 결과에 유사 주소가 있는데 `note`가 5자 미만 | `note` | — |
| `LOOKALIKE_UPDATED` | 409 | 주소 확인(승인) 때 다시 점검해 저장된 점검 결과에 없던 유사 주소를 찾음. 점검 결과(`findings`)와 `version`을 갱신해 저장하고 승인하지 않는다. 화면은 주소를 다시 불러와 비교를 보여 준 뒤 메모와 함께 다시 확인 | — | — |
| `ADDRESS_NOT_ACTIVE` | 422 | 사용 가능 상태가 아닌 주소로 초안·제출(입력 오류), 또는 받는 주소가 사용 중지된 요청의 승인 | `addressId`(초안·제출) | — |
| `APPROVERS_INSUFFICIENT` | 422 | 승인 요청 제출 때, 작성자를 뺀 지금 승인할 수 있는 사람이 필요한 승인 수보다 적음. 아무것도 예약하지 않음 | — | `eligibleApprovers`, `requiredApprovals`, `approvalBasis` |
| `SELF_ROLE_ESCALATION` | 422 | 역할 변경에서 자기 자신에게 승인자·자산 담당자 역할을 새로 부여 | — | — |
| `PROVIDER_NOT_WHITELISTED` | 422 | 화이트리스트 밖 기관 자료 게시, **숨긴 자료를 다시 게시**(PATCH `published`)할 때도 | `providerId` | — |
| `PROVIDER_DOMAIN_MISMATCH` | 422 | 원문 링크의 호스트가 제공 기관 홈페이지 호스트와 다름(모든 모드, 게시와 다시 게시) | `url` | — |
| `DEMO_LIMIT` | 422 | 공개 데모에서만. 인스턴스당 사용자가 새로 만든 주소 등록·출금 요청·인사이트 게시가 종류별 200건에 도달 | — | — |

## 멱등성
`Idempotency-Key`(8~80자 영숫자·`_-`). `POST /api/requests`는 필수, 요청 행동(`/review`, `/submit`, `/approve`, `/reject`, `/cancel`, `/back-to-draft`)은 선택. 같은 사용자·경로·키 + 같은 본문이면 처음 응답을 재전송(`Idempotent-Replayed: true`), 다른 본문이면 422 `IDEMPOTENCY_KEY_REUSED`.

커스터디 접수(서버 내부)는 요청 id를 멱등 키로 넘긴다. 같은 키로 다시 접수하면 같은 접수 참조(`custodyRef`)를 돌려받는다(설계 가정 A-18).

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
| `allowedActions` | 지금 사용자에게 허용된 행동(서버 계산). 목록 응답에서는 빈 배열 |
| `custodyRef` | 커스터디 접수 참조(모의) |

## 주소 응답 (`GET /addresses`, `GET /addresses/:id`)

| 필드 | 뜻 |
| --- | --- |
| `findings` | 저장된 점검 결과 `[{code, level, message, action?, data?}]`. 유사 주소 경고(`ADDRESS_LOOKALIKE`)는 `data.matches[] = {id, label, status, address, prefix, suffix}`(최대 3건, 같은 글자 수가 많은 순). 확인(승인) 때 새로 찾은 유사 주소가 합쳐진다. 이 규칙 도입 전 등록분은 빈 배열 |
| `lookalikeReason` | 유사 주소가 있을 때 등록자가 남긴 사유. 없으면 null |
| `middle` | `{start, end}`: 다시 입력할 가운데 8자리의 위치(고유부 기준, 1부터, 양 끝 포함). 글자 자체는 따로 주지 않는다 |
| `openRequestCount` | 이 주소를 쓰는 진행 중(작성 중·검토 중·승인 대기) 출금 요청 수 |
| `allowedActions` | `review`(등록자가 아닌 확인 담당자, 확인 대기일 때), `disable` |

## 감사 기록 검증 (`GET /audit/verify`)

```json
{ "ok": true, "count": 51, "brokenAtSeq": null, "brokenAtNo": null, "headHash": "64자 16진수" }
```
- `count`: 이 조직의 감사 기록 수. `brokenAtSeq`: 처음 어긋난 기록의 전체 공용 순번. `brokenAtNo`: 그 기록이 조직 체인에서 몇 번째인지(1부터). 화면은 `brokenAtNo`와 목록의 `orgSeq`를 쓴다.
- `headHash`: 체인이 맞을 때만 가장 최근 기록의 해시. 어긋났거나 기록이 없으면 null.
- 체인 중간의 수정·삭제는 찾지만 **가장 최근 기록을 지운 경우는 `ok:true`로 나온다**. 감사 담당자가 `headHash`·`count`를 앱 밖에 보관해 두고 다음 검증 결과와 대조해야 알 수 있다.
- 새 기록은 해시 v2(수행자 이름 포함)로 쓴다. 기존 v1 기록은 v1으로 검증하며, v2 뒤의 v1 기록과 알 수 없는 방식은 어긋남으로 본다(A-24).
- `GET /audit` 목록 항목에는 `orgSeq`(필터 적용 전 조직 안 순번, 1부터)가 있다.

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
| GET /dashboard | dashboard.read | 보유 자산, 할 일, 진행 요청, 최근 활동. 할 일 `kind`: `approve_requests`(받는 주소가 사용 가능한 요청만), `blocked_requests`(승인자, 받는 주소가 사용 중지되어 승인할 수 없는 요청), `review_addresses`, `my_drafts`, `my_rejected`, `my_blocked_requests`(요청자 본인), `my_pending_addresses`, `audit_recent`. 진행 중 요청의 `approved`는 승인 대기면 지금 유효한 표 수 |
| GET /balances, /wallets, /staking, /catalog | 각 read | 잔고·지갑·스테이킹·지원 자산 |
| GET /activity?type&assetCode&status&q&from&to&order&page&pageSize | activity.read | 거래 내역(페이지 10/25/50/100) |
| GET /addresses?status&assetCode&networkCode&q&sort, GET /addresses/:id | address.read | 주소록, 상세+이력(위 주소 응답) |
| POST /addresses/check | address.read | 형식·중복·유사 주소 점검(저장 안 함). 중복은 확인 대기·사용 가능 주소만, 유사 주소는 모든 상태와 비교 |
| POST /addresses | address.create | 등록 → PENDING_REVIEW. `confirmTail`, `confirmMiddle`, `ackNotVerified`, `ackOutOfBandConfirmed` 필수, 유사 주소가 있으면 `lookalikeReason`(5~300자). 공개 데모는 `DEMO_LIMIT` |
| POST /addresses/:id/review `{decision, note, version, confirmTail, confirmMiddle}` | address.review(등록자 제외) | 확인/거절. 확인은 끝자리·가운데 대조, 유사 주소가 있으면 `note` 5자 이상, 재점검 결과 새 유사 주소가 있으면 409 `LOOKALIKE_UPDATED` |
| POST /addresses/:id/disable `{version}` | address.disable | 사용 중지. 이 주소를 쓰는 승인 대기 요청은 승인할 수 없게 되며(`blockedReason`), 반려·취소 때까지 예약 유지 |
| GET /requests?view(mine\|to_approve\|blocked)&status(csv)&q&order&page&pageSize, GET /requests/:id | request.read | 목록(상태별 건수 `counts`는 보기·검색 조건을 따르고 상태 필터만 무시), 상세(허용 행동·처리 기록·사용 가능 수량). `to_approve`는 받는 주소가 사용 가능한 요청만, `blocked`는 받는 주소가 사용 가능하지 않은 승인 대기 요청(조직 전체) |
| POST /requests, PUT /requests/:id | request.create | 초안 작성·수정. 공개 데모는 `DEMO_LIMIT`(작성) |
| POST /requests/:id/review \| back-to-draft \| submit \| cancel | request.create(작성자) | 상태 전이. submit은 `confirmTail`, `ackIrreversible`, 승인 가능 인원 부족 시 `APPROVERS_INSUFFICIENT` |
| POST /requests/:id/approve \| reject | request.approve(작성자 제외) | 승인 / 반려(`reason` 5~500자). 받는 주소가 사용 가능하지 않으면 승인은 `ADDRESS_NOT_ACTIVE` |
| GET /org/members, GET /org/policy | org.read | 구성원·정책(`isDesignAssumption: true`) |
| PUT /org/members/:id/roles `{roles, rolesVersion}` | org.manage | 역할 변경(감사 기록). 본인 관리자 해제·마지막 관리자 해제·본인에게 승인자/자산 담당자 부여 금지 |
| GET /audit, GET /audit/verify, GET /audit/export.csv | audit.read / audit.export | 감사 기록(`orgSeq`), 해시 체인 검증(위 형식), CSV |
| GET /insights?provider&q&offset&limit&related&includeHidden, GET /insights/providers | insight.read | 인사이트(고객: 게시+화이트리스트만). `limit` 1~50(기본 12), 응답 `{total, offset, limit, items}`. `includeHidden=1`은 insight.manage만 숨김·화이트리스트 밖 자료 포함 |
| POST /insights, PATCH /insights/:id `{status}` | insight.manage | 운영자 게시·숨김. 게시와 다시 게시 모두 화이트리스트·기관 도메인 확인. 공개 데모는 `DEMO_LIMIT`(게시) |
