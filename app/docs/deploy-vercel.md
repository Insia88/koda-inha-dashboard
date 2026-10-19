# 보호된 공개 데모 배포 (Vercel)

이 문서는 `app/`을 **보호된 공개 데모**로 Vercel에 올릴 때의 구성·설정·검증·되돌리기 절차다. 공개 데모도 로컬과 똑같이 **개발용 로그인·모의 데이터·모의 커스터디로만** 동작한다. KODA 공식 서비스가 아니며 실제 계정·자산·지갑과 연결되지 않는다.

표기: **[사실]** 코드·설정 파일에서 확인한 내용, **[설정]** 이 프로젝트에서 실제로 쓰는 값, **[미확인]** 실제 배포 전에는 확인할 수 없는 내용, **[제안]** 아직 결정되지 않은 권고.

## 1. 동작 방식 [사실]

| 부분 | 동작 |
| --- | --- |
| 화면 | `vite build` 결과 `dist/`를 Vercel CDN이 그대로 서빙한다. 확장자 없는 경로(`/requests/wr-1` 등)는 `index.html`로 다시 쓰고, 확장자가 있는데 존재하지 않는 파일(`/missing.js`)은 404로 둔다. |
| API | 모든 `/api/*` 요청을 함수 하나(`api/index.mjs`)로 다시 쓴다. 이 파일은 커밋된 얇은 JS이며, `npm run build:api`가 esbuild로 `server/vercel.ts`를 묶은 `.vercel-server/handler.mjs`를 다시 내보낸다. |
| 기동 | 함수 인스턴스가 처음 뜰 때 `createRuntime(loadConfig())`(`server/runtime.ts`)가 메모리 SQLite를 열고 마이그레이션·모의 데이터 생성 뒤 Fastify 앱을 만든다. 요청은 `app.server.emit('request', req, res)`로 넘긴다. |
| 백그라운드 작업 | 상주 타이머가 없다. `/api` 요청이 들어오면 1초에 한 번까지 모의 커스터디 정산(PROCESSING → 처리 완료)과 60초보다 오래된 모의 시세 기준 시각 갱신을 실행한다. 로컬 서버(`server/index.ts`)는 기존처럼 1초·60초 타이머를 쓴다. |
| 런타임 파일 | `config/*.json`과 `server/migrations/*.sql`은 실행 중에 읽으므로 `vercel.json`의 `functions["api/index.mjs"].includeFiles`로 함수에 포함한다. |

## 2. 안전 잠금 [사실]

- `VERCEL=1` 또는 `NODE_ENV=production`이면 서버는 **기동을 거부**한다. Vercel 프로젝트 환경변수에 `DEMO_PUBLIC=1`을 명시했을 때만 공개 데모로 뜬다(`server/config.ts`). 로컬 기본값은 바뀌지 않는다.
- `DEMO_PUBLIC=1`이면 다음이 강제된다.

| 항목 | 로컬(기본) | 공개 데모 |
| --- | --- | --- |
| 저장소 | `./data/koda-dev.sqlite` | 인스턴스 메모리(`:memory:`), `DB_PATH` 무시 |
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

- `NODE_ENV`, `AUTH_MODE`, `DB_PATH`는 **설정하지 않는다**. 공개 데모가 스스로 정한다.
- `VERCEL_AUTOMATION_BYPASS_SECRET`(자동화 우회 값)은 Vercel이 발급한다. 검사를 돌리는 셸이나 CI 비밀값에만 두고 저장소·문서·로그에 남기지 않는다.
- [제안] 여러 인스턴스에 걸친 보조 한도로 Vercel WAF 사용자 규칙을 둔다: `/api/auth/dev-login` IP당 분당 약 20회, `/api/` IP당 분당 약 600회.
- [제안] 프로덕션 승격은 하지 않는다. 꼭 필요하면 그 전에 보호 범위를 All Deployments(프로덕션 포함)로 넓히고, 보호를 줄이는 결정은 KODA와 합의해 `docs/decisions.md`에 기록한 뒤에만 한다(KODA 로고·상표, 배포 제한이 붙은 원자료 때문).

## 4. 알려진 한계

- [사실] 데이터와 세션은 **인스턴스마다 따로** 메모리에 있다. 콜드 스타트·재배포·인스턴스 추가 때 처음 상태로 돌아간다. 화면은 응답 헤더 `X-Demo-Instance`가 바뀌면 "데모 서버가 새로 시작되었습니다" 안내와 「처음 화면으로」 버튼을 보이고, 로그인 화면에서도 같은 사실을 알린다.
- [사실] 요청 한도(전체 600회/분, 개발용 로그인 30회/분, IP 기준)도 인스턴스마다 따로 센다.
- [사실] 감사 기록 해시 체인 검증은 한 인스턴스 안에서만 의미가 있다. 로컬의 재시작 후 유지 테스트(`tests/api.test.ts`)는 로컬 모드에만 해당한다.
- [사실] 함수 응답 크기 상한(4.5 MB) 때문에 감사 기록 CSV 내보내기가 크면 실패할 수 있다. 모의 데이터 규모에서는 문제되지 않는다.
- [사실] 함수 최대 실행 시간은 15초(`vercel.json`)다.
- [미확인] Hobby 요금제는 비상업 용도 조건이 있다. KODA × 인하 프로젝트에 맞는 요금제인지 확인해야 한다.
- [미확인] 실제 배포 전에는 확인할 수 없는 것: 다시 쓰기 뒤에도 함수의 `req.url`이 원래 `/api/...` 경로를 유지하는지, 함수 번들 추적(nft)이 `node:sqlite`와 `includeFiles`를 기대대로 담는지, 런타임 로그의 Node 버전이 24인지.

## 5. 배포 게이트 (모두 통과한 커밋만 배포)

1. 패키지 브랜치마다 `npm run check`, `npm run e2e`, 새 테스트 통과.
2. 통합 브랜치에서 전체 `npm run check` + `npm run e2e` 통과(로컬).
3. 함수 빌드 확인: `npm run build:vercel` 후 `node scripts/smoke-deploy.mjs --local 4418`. 빌드된 함수를 `VERCEL=1 DEMO_PUBLIC=1`로 127.0.0.1:4418에 띄워 API 검사를 돌리고 닫는다(CDN·보호 검사는 건너뜀).
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
   먼저 우회 헤더 없이 401 또는 로그인 이동이 오는지(보호 켜짐) 확인하고, 200이면 즉시 중단한다. 이어서 healthz 공개 데모 모드, `/`와 깊은 경로의 보안 헤더, `/missing.js` 404, `/api/me` 401 + no-store, Secure·HttpOnly·SameSite=Strict 쿠키, CSRF 403, 본인 승인 403, 80,000 USDC 2인 승인, MOCK- 외 주소 거부, 화이트리스트 외 기관 422, 기관 도메인 불일치 422, 같은 IP 31번째 로그인 429를 확인한다. 마지막 검사가 로그인 한도를 다 쓰므로 6번을 먼저 돌리거나 1분 기다린다. 검사로 만든 출금 요청은 스크립트가 취소한다.
8. 프로덕션 승격은 1~7을 모두 통과하고 3절 [제안]의 조건을 채운 뒤에만 수동으로 한다.

## 6. 되돌리기

- Vercel 대시보드의 Instant Rollback으로 직전 배포로 되돌린다.
- 긴급 차단: 프로젝트 환경변수에서 `DEMO_PUBLIC`을 지우고 다시 배포하면 함수가 기동을 거부해 모든 `/api`가 실패한다. 프로젝트 일시 중지(Pause)도 쓸 수 있다.
- 공개 데모에는 보존할 데이터가 없다(인스턴스 메모리). 되돌린 뒤 데이터 이전은 필요 없다.

## 7. 실행할 때마다 사용자 확인이 필요한 일

다음은 그때그때 사용자에게 채팅으로 명시적인 확인을 받은 뒤에만 한다.

- 프로덕션 기동 거부를 `DEMO_PUBLIC=1` 예외로 여는 것 자체를 받아들이는지
- Vercel 프로젝트 생성·연결, 환경변수 설정
- 각 배포와 프로덕션 승격
- 배포 보호를 줄이거나 끄는 모든 변경(KODA 결정도 함께 필요)
- 요금제(Hobby는 비상업)가 이 프로젝트에 맞는지
