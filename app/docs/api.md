# API 계약 (요약)

모든 경로는 `/api` 아래, JSON. 인증은 `koda_sid` HttpOnly 쿠키. 변경 요청(POST/PUT/PATCH)은 `X-CSRF-Token` 헤더(`GET /api/me`의 `csrfToken`) 필수. 다른 조직의 리소스는 존재 여부를 숨기기 위해 404.

## 오류 형식
```json
{ "error": { "code": "ADDRESS_NETWORK_MISMATCH", "message": "원인(한국어)", "action": "복구 행동", "fields": [{ "field": "addressId", "message": "..." }] }, "requestId": "uuid" }
```
상태 코드: 401 로그인 필요, 403 권한 없음·자기 승인(`SELF_APPROVAL_FORBIDDEN`)·CSRF, 404 없음/타 조직, 409 상태 충돌(`INVALID_TRANSITION`, `VERSION_CONFLICT`, `ALREADY_DECIDED`), 422 입력 오류, 429 요청 한도, 500 내부 오류(변경 롤백).

## 멱등성
`Idempotency-Key`(8~80자 영숫자·`_-`). `POST /api/requests`는 필수, 요청 행동(`/review`, `/submit`, `/approve`, `/reject`, `/cancel`, `/back-to-draft`)은 선택. 같은 사용자·경로·키 + 같은 본문이면 처음 응답을 재전송(`Idempotent-Replayed: true`), 다른 본문이면 422 `IDEMPOTENCY_KEY_REUSED`.

## 동시성
요청·주소·역할 변경은 `version`(역할은 `rolesVersion`)을 본문에 보내야 하며 다르면 409. 쓰기는 `BEGIN IMMEDIATE` 트랜잭션.

## 금액
요청 본문의 `amount`는 10진 문자열(예 `"2500.25"`), 자산 자릿수 초과 시 422 `AMOUNT_PRECISION`. 응답은 `amount`(표시용 10진 문자열)와 `amountUnits`(최소 단위 정수 문자열)를 함께 준다. 원화 값은 원 단위 정수 문자열.

## 경로
| 메서드·경로 | 권한 | 설명 |
| --- | --- | --- |
| GET /healthz | 공개 | 상태 |
| GET /auth/dev-users, POST /auth/dev-login, POST /auth/logout | 개발 모드 | 모의 로그인 |
| GET /me | 로그인 | 사용자·조직·역할·권한·CSRF·환경·정책 |
| GET /dashboard | dashboard.read | 보유 자산, 할 일, 진행 요청, 최근 활동 |
| GET /balances, /wallets, /staking, /catalog | 각 read | 잔고·지갑·스테이킹·지원 자산 |
| GET /activity?type&assetCode&status&q&from&to&order&page&pageSize | activity.read | 거래 내역(페이지 10/25/50/100) |
| GET /addresses?status&assetCode&networkCode&q&sort, GET /addresses/:id | address.read | 주소록, 상세+이력 |
| POST /addresses/check | address.read | 형식·중복·유사 주소 점검(저장 안 함) |
| POST /addresses | address.create | 등록 → PENDING_REVIEW. `confirmTail`, `ackNotVerified`, `ackOutOfBandConfirmed` 필수 |
| POST /addresses/:id/review `{decision, note, version, confirmTail}` | address.review(등록자 제외) | 확인/거절 |
| POST /addresses/:id/disable `{version}` | address.disable | 사용 중지 |
| GET /requests?view(mine\|to_approve)&status(csv)&q&order&page&pageSize, GET /requests/:id | request.read | 목록(상태별 건수), 상세(허용 행동·처리 기록·사용 가능 수량) |
| POST /requests, PUT /requests/:id | request.create | 초안 작성·수정 |
| POST /requests/:id/review \| back-to-draft \| submit \| cancel | request.create(작성자) | 상태 전이. submit은 `confirmTail`, `ackIrreversible` |
| POST /requests/:id/approve \| reject | request.approve(작성자 제외) | 승인 / 반려(`reason` 5~500자) |
| GET /org/members, GET /org/policy | org.read | 구성원·정책 |
| PUT /org/members/:id/roles `{roles, rolesVersion}` | org.manage | 역할 변경(감사 기록) |
| GET /audit, GET /audit/verify, GET /audit/export.csv | audit.read / audit.export | 감사 기록, 해시 체인 검증, CSV |
| GET /insights?provider&q&offset&limit&related, GET /insights/providers | insight.read | 인사이트(고객: 게시+화이트리스트만) |
| POST /insights, PATCH /insights/:id `{status}` | insight.manage | 운영자 게시·숨김(화이트리스트 강제) |