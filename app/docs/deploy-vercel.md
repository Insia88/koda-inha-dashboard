# 보호된 공개 데모 배포 (Vercel)

이 문서는 `app/`을 **보호된 공개 데모**로 Vercel에 올릴 때의 구성·설정·검증·되돌리기 절차다. 공개 데모도 로컬과 똑같이 **개발용 로그인·모의 데이터·모의 커스터디로만** 동작한다. KODA 공식 서비스가 아니며 실제 계정·자산·지갑과 연결되지 않는다.

표기: **[사실]** 코드·설정 파일에서 확인한 내용, **[설정]** 이 프로젝트에서 실제로 쓰는 값, **[설계 가정]** 이 프로토타입이 정한 값(KODA 정책이 아님), **[미확인]** 실제 배포 전에는 확인할 수 없는 내용, **[제안]** 아직 결정되지 않은 권고.

## 1. 동작 방식 [사실]

| 부분 | 동작 |
| --- | --- |
| 화면 | `vite build` 결과 `dist/`를 Vercel CDN이 그대로 서빙한다. 확장자 없는 경로(`/requests/wr-1` 등)는 `index.html`로 다시 쓰고, 확장자가 있는데 존재하지 않는 파일(`/missing.js`)은 404로 둔다. |
| API | 모든 `/api/*` 요청을 함수 하나(`api/index.mjs`)로 다시 쓴다. 이 파일은 커밋된 얇은 JS이며, `npm run build:api`가 esbuild로 `server/vercel.ts`를 묶은 `.vercel-server/handler.mjs`를 다시 내보낸다. |
| 기동 | 함수 인스턴스가 처음 뜰 때 `createRuntime(loadConfig())`(`server/runtime.ts`)가 메모리 SQLite를 열고 마이그레이션·모의 데이터 생성 뒤 Fastify 앱을 만든다. 요청은 `app.server.emit('request', req, res)`로 넘긴다. |
| 세션 | 무상태(서명된 쿠키). 아래 "공개 데모 세션" 참고. 어느 인스턴스가 요청을 받아도 같은 `DEMO_SESSION_SECRET`으로 쿠키를 확인하므로 로그인이 유지된다. |
| 백그라운드 작업 | 상주 타이머가 없다. `/api` 요청이 들어오면 1초에 한 번까지 모의 커스터디 정산(PROCESSING → 처리 완료)과 60초보다 오래된 모의 시세 기준 시각 갱신을 실행한다. 로컬 서버(`server/index.ts`)는 기존처럼 1초·60초 타이머를 쓴다. |
| 런타임 파일 | `config/*.json`과 `server/migrations/*.sql`은 실행 중에 읽으므로 `vercel.json`의 `functions["api/index.mjs"].includeFiles`로 함수에 포함한다. |

### 공개 데모 세션 [사실]

실제 배포에서 로그인 직후 다음 요청이 다른 함수 인스턴스로 가자, 그 인스턴스의 메모리 DB에는 세션이 없어 검토자가 로그아웃되었다. 그래서 공개 데모만 세션을 서버 저장소 대신 **서명된 쿠키**에 담는다(`server/auth.ts`의 `statelessSessionStore`). 로컬은 기존 저장소 세션 그대로다.

- 쿠키 `koda_sid` 값: `base64url(payload JSON) + '.' + base64url(HMAC-SHA256(DEMO_SESSION_SECRET, payload 부분))`. payload는 `{ v: 1, sid: 무작위 16바이트 hex, uid, org, iat, exp }`(초 단위).
- 확인 순서: 형식(base64url 두 부분, 512자 이하) → 서명(`crypto.timingSafeEqual`, 같은 길이 버퍼끼리) → 버전 `v: 1`만 → `exp` 지남·발급 시각이 60초 넘게 미래·현재 설정 만료(`SESSION_TTL_MINUTES`, 기본 120분)보다 긴 수명이면 거부 → 그 인스턴스 DB에서 `uid`로 사용자를 다시 읽는다. 사용자가 없거나 비활성이거나 `org`가 사용자의 조직과 다르면 401. 역할은 매 요청 다시 읽는다.
- CSRF 값은 `base64url(HMAC-SHA256(DEMO_SESSION_SECRET, 'csrf:' + sid))`. 어느 인스턴스든 같은 값을 계산해 확인한다. 변경 요청에는 지금처럼 `X-CSRF-Token`이 필요하다.
- 쿠키 속성은 그대로 `Secure; HttpOnly; SameSite=Strict; Path=/`, 만료는 `exp`와 같다. 로그아웃은 같은 속성으로 쿠키를 지운다.
- 개발용 로그인 한도(1분 30회)와 로그인·로그아웃 감사 기록은 바뀌지 않는다. 감사 기록은 요청을 받은 인스턴스의 DB에 남는다.
- 서명 값은 `loadConfig`가 읽어 비공개 필드에만 둔다. JSON·로그·오류 문구에는 값이 나오지 않는다(`tests/deploy-mode.test.ts`).
- 두 인스턴스(메모리 DB 각각, 같은 서명 값)로 A가 발급한 쿠키가 B에서 `/api/me`와 CSRF 보호 변경 요청을 통과하는지, 변조·만료·다른 키·다른 조직 쿠키가 401인지는 `tests/demo-session.test.ts`가 확인한다.
- [설계 가정] 공개 데모만 무상태 서명 쿠키를 쓰는 것, 서명 값 최소 32바이트, 기본 만료 120분, 발급 시각을 60초까지만 미래로 허용하는 것, 만료 전 서버에서 세션을 폐기하지 않는 것(4절)은 이 프로토타입이 정한 값이다. KODA 정책이 아니며, 운영 인증(SSO)의 세션 규칙은 따로 정해야 한다.

## 2. 안전 잠금 [사실]

- `VERCEL=1` 또는 `NODE_ENV=production`이면 서버는 **기동을 거부**한다. Vercel 프로젝트 환경변수에 `DEMO_PUBLIC=1`을 명시했을 때만 공개 데모로 뜬다(`server/config.ts`). 로컬 기본값은 바뀌지 않는다.
- 공개 데모는 `DEMO_SESSION_SECRET`이 없거나 32바이트보다 짧으면 **기동을 거부**한다(32바이트는 HMAC-SHA256 출력 길이에 맞춘 [설계 가정]). `SESSION_TTL_MINUTES`가 0보다 큰 숫자가 아니어도 거부한다. 로컬은 이 값을 읽지 않는다.
- `DEMO_PUBLIC=1`이면 다음이 강제된다.

| 항목 | 로컬(기본) | 공개 데모 |
| --- | --- | --- |
| 저장소 | `./data/koda-dev.sqlite` | 인스턴스 메모리(`:memory:`), `DB_PATH` 무시 |
| 세션 | 저장소 세션(`sessions` 표). 로그아웃하면 서버에서 폐기 | 서명된 쿠키(무상태). 저장소에 세션 행이 없고, 서버에서 폐기할 수 없음 |
| 세션 쿠키 | HttpOnly · SameSite=Strict | 여기에 **Secure** 추가 |
| 접속 IP(요청 한도 기준) | TCP 접속 주소(X-Forwarded-For 무시) | Vercel이 덮어쓴 X-Forwarded-For |
| 정산·시세 갱신 | 1초·60초 타이머 | 요청 시점(1초에 한 번까지) |
| 세션 만료 기본값 | 480분 | 120분 |
| 사용자 생성 건수 | 제한 없음 | 인스턴스당 주소 등록·출금 요청·인사이트 게시 각 200건, 넘으면 422 `DEMO_LIMIT` |
| 화면 서빙 | Fastify가 `dist/` 서빙 | CDN(함수는 화면을 서빙하지 않음) |

- 공개 데모는 커스터디 어댑터가 모의(`isMock`)가 아니거나 저장소에 `organizations.is_mock = 0`인 조직이 있으면 기동하지 않는다.
- 로컬 실행에서 `HOST`가 127.0.0.1·localhost·::1이 아니면 기동을 거부한다(`DEV_ALLOW_LAN=1`로만 해제).
- 인사이트 원문 링크는 **모든 모드에서** 제공 기관 홈페이지와 같은 호스트여야 한다(다르면 422 `PROVIDER_DOMAIN_MISMATCH`, 필드 `url`). 숨긴 자료를 다시 게시할 때도 화이트리스트와 도메인을 다시 확인한다(422 `PROVIDER_NOT_WHITELISTED`).
- 화면 상단 띠와 로그인 화면은 공개 데모에서 "공개 데모 · 모든 사람·법인·자산·주소는 모의 데이터 · KODA 공식 서비스가 아니며 실제 계정·자산과 연결되지 않습니다 · 서버가 다시 시작되면 데이터가 초기화됩니다 (데이터 생성 HH:mm)"를 보인다. 560px 이하에서는 같은 네 가지를 줄인 문구로 보인다.
- `vercel.json`은 Fastify(helmet)가 API 응답에 붙이는 CSP와 같은 정책(+ `upgrade-insecure-requests`)과 nosniff, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP, Permissions-Policy, HSTS, `X-Robots-Tag: noindex, nofollow`를 CDN 응답에 붙인다. `/assets/*`는 1년 immutable 캐시, `/api`는 앱이 붙이는 `Cache-Control: no-store`를 그대로 쓴다. 두 CSP가 같은지는 `tests/deploy-mode.test.ts`가 확인한다.

## 3. Vercel 프로젝트 설정 [설정]

| 항목 | 값 |
| --- | --- |
| Root Directory | `app` |
| Node.js Version | **24.x** |
| Framework / Install / Build / Output | `vercel.json`이 지정: Vite, `npm ci`, `npm run build:vercel`, `dist` |
| Region | `icn1` (`vercel.json`) |
| Git 연동 자동 배포 | 끔(`vercel.json`의 `"git": { "deploymentEnabled": false }`). 푸시로는 배포되지 않는다. 배포는 아래 게이트를 모두 통과한 뒤 수동으로만 한다. |
| Deployment Protection | **Vercel Authentication 켬. 미리보기(Preview) 배포는 반드시 보호한다.** 검토자에게는 Shareable Link로 공유하고, 자동 검사는 Protection Bypass for Automation 값을 쓴다. |
| Vercel Toolbar | 끔(외부 스크립트가 CSP `script-src 'self'`에 막혀 콘솔 오류가 난다) |

환경변수(Preview·Production 모두):

| 이름 | 값 | 이유 |
| --- | --- | --- |
| `DEMO_PUBLIC` | `1` | 공개 데모 예외를 명시적으로 연다. 없으면 함수가 기동을 거부한다. |
| `NODEJS_HELPERS` | `0` | Vercel이 요청 본문을 미리 해석하지 않고 Fastify에 그대로 넘긴다. |
| `DEMO_SESSION_SECRET` | 32바이트 이상 무작위 값(아래 생성 방법) | 세션 쿠키·CSRF 값 서명. 모든 함수 인스턴스가 같은 값을 써야 로그인이 유지된다. 없거나 짧으면 함수가 기동을 거부한다. |

- `DEMO_SESSION_SECRET` 만들기: 셸에서 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`를 실행해 나온 값을 Vercel 프로젝트 설정 → Environment Variables에 **Production과 Preview 모두** 넣는다(가능하면 저장 뒤 다시 읽을 수 없는 Sensitive 유형으로). [제안] Production과 Preview에 서로 다른 값을 쓰면 한쪽에서 받은 쿠키가 다른 쪽에서 통하지 않는다.
- 이 값은 저장소·`.env` 파일·문서·채팅·로그에 남기지 않는다. 값을 바꾸고 다시 배포하면 기존 쿠키가 모두 401이 된다(전체 로그아웃).
- `NODE_ENV`, `AUTH_MODE`, `DB_PATH`는 **설정하지 않는다**. 공개 데모가 스스로 정한다.
- `VERCEL_AUTOMATION_BYPASS_SECRET`(자동화 우회 값)은 Vercel이 발급한다. 검사를 돌리는 셸이나 CI 비밀값에만 두고 저장소·문서·로그에 남기지 않는다.
- [제안] 여러 인스턴스에 걸친 보조 한도로 Vercel WAF 사용자 규칙을 둔다: `/api/auth/dev-login` IP당 분당 약 20회, `/api/` IP당 분당 약 600회.
- [제안] 프로덕션 승격은 하지 않는다. 꼭 필요하면 그 전에 보호 범위를 All Deployments(프로덕션 포함)로 넓히고, 보호를 줄이는 결정은 KODA와 합의해 `docs/decisions.md`에 기록한 뒤에만 한다(KODA 로고·상표, 배포 제한이 붙은 원자료 때문).

### 운영 별칭(production) 현재 상태

DEC-001(저장소 최상위 `docs/decisions.md`)과 A-22(`app/docs/assumptions.md`)는 보호 없는 공개를 허용하지 않는다. 이를 대신하는 결정 기록은 없다. 아래는 확인한 상태와 남은 조치다.

- [사실] 2026-10-19 확인(우회 헤더 없이 보낸 GET): `https://koda-inha-dashboard.vercel.app/`는 200 `text/html`, `/login`은 200, `/api/healthz`는 200에 `mode: public-demo`를 돌려준다. 운영 별칭 앞에 배포 보호가 없다. 누구나 비밀번호 없는 개발용 로그인으로 어느 모의 사용자로도 들어갈 수 있고, KODA 운영 담당(`u-k-op`)으로 인사이트를 게시해 같은 인스턴스의 다른 방문자에게 보이게 할 수 있다. 인스턴스당 생성 한도(`DEMO_LIMIT`)도 남이 먼저 다 쓸 수 있다.
- [사실] 커밋 e515f0e는 Hobby 요금제에서 운영 도메인에 Vercel Authentication을 걸 수 없다는 이유로 `smoke-deploy --public`만 더했다. 공개를 허용하는 결정은 아니다. [미확인] 요금제별 보호 범위는 Vercel 프로젝트 설정 화면에서 다시 확인해야 한다.
- [조치 필요, 미완료] DEC-001로 되돌리는 일은 Vercel 운영 조치라 KODA 결정이 필요 없다. 프로젝트 소유자가 Vercel에서 직접 한다(7절, 사용자 확인 필요).
  1. Settings → Domains에서 운영 별칭(`koda-inha-dashboard.vercel.app`)을 지우거나, 그럴 수 없으면 프로젝트를 일시 중지(Pause)한다. 일시 중지하면 미리보기도 멈추므로 검토가 필요한 동안에는 별칭 제거를 먼저 쓴다.
  2. 검토자에게는 보호된 미리보기 주소의 Shareable Link만 준다.
  3. 우회 헤더 없이 `/`를 다시 요청해 200이 아닌지(401·로그인 이동, 또는 별칭이 없다는 응답) 확인하고, 미리보기에 대해 5절 7번 스모크 검사를 `--public` 없이 돌린다.
  4. 이 항목을 "[사실] YYYY-MM-DD 운영 별칭 제거(또는 일시 중지), 우회 헤더 없이 `/` <상태 코드>, 7번 스모크 `--public` 없이 실패 0·경고 0"으로 바꿔 적는다.
- 운영 주소 자체를 보호하려면 운영 도메인 보호를 지원하는 요금제가 필요하다. 보호 없는 공개 주소를 계속 두려면 KODA 합의와 DEC-001을 대신하는 새 결정 기록이 먼저 있어야 한다. 이 문서의 조치 범위가 아니다.

## 4. 알려진 한계

- [사실] 로그인은 인스턴스와 관계없이 유지되지만, **데이터 쓰기는 여전히 인스턴스마다 따로** 메모리에 있다. 인스턴스 A에서 만든 출금 요청·주소·인사이트는 B에는 없고(B에서 404), 콜드 스타트·재배포·인스턴스 추가 때 처음 상태로 돌아간다. 화면은 응답 헤더 `X-Demo-Instance`로 이 탭이 처음 보는 인스턴스가 응답하면 본문 위에 "다른 데모 서버로 연결되었습니다. 로그인은 유지되지만, 방금 만든 요청·주소가 이 서버에는 없을 수 있습니다. 모든 데이터는 모의 데이터입니다." 안내를 띄운다. 로그아웃하지 않으며, 「닫기」로 닫거나 「처음 화면으로」(로그인은 두고 화면 조회 결과만 비운 뒤 홈에서 다시 불러옴)를 고를 수 있다. 이미 본 인스턴스로 돌아갈 때는 다시 띄우지 않는다.
- [사실] **무상태 세션의 한계**: 서버에 세션 상태가 없어 만료 전에 서버에서 세션을 폐기할 수 없다. 로그아웃은 브라우저 쿠키를 지우고 감사 기록을 남길 뿐이며, 쿠키 값을 따로 복사해 둔 사람은 `exp`(발급 후 기본 120분)까지 그 값을 쓸 수 있다(`tests/demo-session.test.ts`가 이 동작을 고정해 둔다). 사용자를 비활성으로 바꾸면 그 변경이 있는 인스턴스에서만 401이 된다. 그래서 만료를 짧게 두고(`SESSION_TTL_MINUTES`를 늘리지 않는다), 모든 세션을 즉시 끊어야 하면 `DEMO_SESSION_SECRET`을 새 값으로 바꿔 다시 배포한다. 모의 데이터·개발용 로그인 데모라서 받아들이는 절충이며, 운영 인증(SSO)에는 쓰지 않는다.
- [사실] 요청 한도(전체 600회/분, 개발용 로그인 30회/분, IP 기준)도 인스턴스마다 따로 센다.
- [사실] 감사 기록 해시 체인 검증은 한 인스턴스 안에서만 의미가 있다. 로컬의 재시작 후 유지 테스트(`tests/api.test.ts`)는 로컬 모드에만 해당한다.
- [사실] 함수 응답 크기 상한(4.5 MB) 때문에 감사 기록 CSV 내보내기가 크면 실패할 수 있다. 모의 데이터 규모에서는 문제되지 않는다.
- [사실] 함수 최대 실행 시간은 15초(`vercel.json`)다.
- [미확인] Hobby 요금제는 비상업 용도 조건이 있다. KODA × 인하 프로젝트에 맞는 요금제인지 확인해야 한다.
- [미확인] 실제 배포 전에는 확인할 수 없는 것: 다시 쓰기 뒤에도 함수의 `req.url`이 원래 `/api/...` 경로를 유지하는지, 함수 번들 추적(nft)이 `node:sqlite`와 `includeFiles`를 기대대로 담는지, 런타임 로그의 Node 버전이 24인지.

## 5. 배포 게이트 (모두 통과한 커밋만 배포)

1. 패키지 브랜치마다 `npm run check`, `npm run e2e`, 새 테스트 통과.
2. 통합 브랜치에서 전체 `npm run check` + `npm run e2e` 통과(로컬).
3. 함수 빌드 확인: `npm run build:vercel` 후 `node scripts/smoke-deploy.mjs --local 4418`. 빌드된 함수를 `VERCEL=1 DEMO_PUBLIC=1`로 127.0.0.1:4418에 띄워 API 검사를 돌리고 닫는다(CDN·보호 검사는 건너뜀). `DEMO_SESSION_SECRET`이 없으면 스크립트가 이번 실행에만 쓰는 무작위 값을 만든다. `npm run check:vercel`의 핸들러 점검(`scripts/probe-handler.mjs`)도 공개 데모로 기동하므로 서명 값이 있어야 한다. 셸에 이번 실행에만 쓰는 임시 값(32바이트 이상, 배포에 쓰는 값이 아닌 새 값)을 넣고 실행한다. 예: `DEMO_SESSION_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")" npm run check:vercel`.
4. `npx vercel@62.2.0 build`로 `.vercel/output/functions/api/index.func`에 `config/`, `server/migrations/`, `node_modules/fastify`가 있고 `data/*.sqlite`·`.research`가 없는지 확인.
5. 앱 폴더에서 CLI로 보호된 Preview 배포(git 푸시 불필요).
6. 원격 화면 검사(읽기 전용 a11y·responsive만):
   ```bash
   E2E_BASE_URL=https://<preview> VERCEL_AUTOMATION_BYPASS_SECRET=<값> npx playwright test
   ```
   axe 위반 0건이어야 한다. 데이터를 바꾸는 흐름 검사는 원격에서 돌리지 않는다(데이터가 공유·인스턴스별).
7. 스모크 검사:
   ```bash
   VERCEL_AUTOMATION_BYPASS_SECRET=<값> node scripts/smoke-deploy.mjs https://<preview>
   ```
   먼저 우회 헤더 없이 401 또는 로그인 이동이 오는지(보호 켜짐) 확인하고, 200이면 즉시 중단한다. 이 게이트는 `--public` 없이 돌려 통과해야 한다. `--public`을 주면 보호 없음을 통과가 아닌 `WARN  배포 보호 없음(--public)`으로 남기고 나머지 검사를 계속하며, 요약에 `경고 N`으로 따로 센다. 경고가 있는 실행은 7번 통과로 보지 않는다(보호 없는 공개를 허용하는 결정 기록이 없는 한 `--public`은 현재 상태를 확인하는 용도로만 쓴다). 이어서 healthz 공개 데모 모드, `/`와 깊은 경로의 보안 헤더, `/missing.js` 404, `/api/me` 401 + no-store, Secure·HttpOnly·SameSite=Strict·Path=/ 쿠키, **같은 쿠키로 `/api/me` 20회 반복이 모두 200**(응답한 `X-Demo-Instance` 값의 수를 기록하며, 1곳이든 여러 곳이든 모두 200이면 통과), 변조한 세션 쿠키(내용·서명) 401, CSRF 403, 본인 승인 403, 80,000 USDC 2인 승인, MOCK- 외 주소 거부(점검과 등록 모두 주소 규칙 오류 `ADDRESS_NETWORK_MISMATCH`로 거부되는지. 등록은 형식 검사를 통과하는 완전한 본문으로 보내고, 같은 본문에 올바른 MOCK 주소를 넣으면 주소 규칙은 통과해 일부러 틀린 끝자리(`CONFIRM_TAIL_MISMATCH`)에서 거부되는지도 본다. 아무 주소도 만들지 않는다), 화이트리스트 외 기관 422, 기관 도메인 불일치 422, 로그아웃이 같은 속성으로 쿠키를 지우는지, 같은 IP 31번째 로그인 429를 확인한다. 로그인 한도는 인스턴스마다 따로 세므로, 여러 인스턴스가 번갈아 응답하면 마지막 검사가 실패할 수 있다(4절). 같은 이유로 작성 → 검토 → 승인 요청처럼 여러 번 나눠 쓰는 검사(본인 승인 403, 80,000 USDC 2인 승인)는 다음 단계가 다른 인스턴스로 가면 404로 실패할 수 있다. 이때 실패 문구에 두 인스턴스 값이 함께 찍히며, 20회 반복 검사가 기록한 인스턴스 수와 함께 보고 다시 실행해 판단한다. 로컬에서 인스턴스 두 개를 번갈아 응답하게 한 시험에서는 20회 반복·변조 쿠키·CSRF·로그아웃 검사가 통과하고 이 세 검사가 위 이유로 실패하는 것을 확인했다. 마지막 검사가 로그인 한도를 다 쓰므로 6번을 먼저 돌리거나 1분 기다린다. 검사로 만든 출금 요청은 스크립트가 취소한다.
8. 프로덕션 승격은 1~7을 모두 통과하고 3절 [제안]의 조건을 채운 뒤에만 수동으로 한다.

## 6. 되돌리기

- Vercel 대시보드의 Instant Rollback으로 직전 배포로 되돌린다.
- 긴급 차단: 프로젝트 환경변수에서 `DEMO_PUBLIC`을 지우고 다시 배포하면 함수가 기동을 거부해 모든 `/api`가 실패한다. 프로젝트 일시 중지(Pause)도 쓸 수 있다.
- 보호 없이 열린 운영 별칭 닫기: Settings → Domains에서 운영 별칭을 지우거나 프로젝트를 일시 중지한다. 우회 헤더 없이 `/`가 200이 아닌지 확인하고 3절 "운영 별칭(production) 현재 상태"에 날짜와 결과를 적는다. 화면만 막히는 것이 아니라 `/api`(개발용 로그인)도 함께 닫혀야 한다.
- 세션만 모두 끊기: `DEMO_SESSION_SECRET`을 새 무작위 값으로 바꾸고 다시 배포한다. 이전 값으로 서명된 쿠키는 모두 401이 되고, 검토자는 다시 로그인하면 된다.
- 공개 데모에는 보존할 데이터가 없다(인스턴스 메모리). 되돌린 뒤 데이터 이전은 필요 없다.

## 7. 실행할 때마다 사용자 확인이 필요한 일

다음은 그때그때 사용자에게 채팅으로 명시적인 확인을 받은 뒤에만 한다.

- 프로덕션 기동 거부를 `DEMO_PUBLIC=1` 예외로 여는 것 자체를 받아들이는지
- Vercel 프로젝트 생성·연결, 환경변수 설정
- 각 배포와 프로덕션 승격
- 배포 보호를 줄이거나 끄는 모든 변경(KODA 결정도 함께 필요)
- 요금제(Hobby는 비상업)가 이 프로젝트에 맞는지
