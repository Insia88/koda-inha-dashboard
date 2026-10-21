# KODA 법인 대시보드 — 개발용 애플리케이션

[대시보드 요구사항](../docs/dashboard.md) DASH-001~007을 실제로 실행·검증할 수 있게 만든 애플리케이션이다. KODA 실서비스 소스가 아니라, 제공된 요구사항·회의록·기존 화면 캡처를 근거로 새로 구축했다. **개발용 로그인과 모의 데이터·모의 커스터디로만 동작**하며 실제 자산 전송, 개인키 접근, 운영 지갑 연결을 하지 않는다.

## 실행

Node.js 22.13 이상(내장 `node:sqlite` 사용, 확인 버전 24.19).

```bash
cd app
npm ci                 # 의존성 설치 (버전 고정)
npm run db:reset       # 개발 DB 초기화 + 모의 데이터 (data/koda-dev.sqlite)
npm run build          # 화면 빌드 (dist/)
npm start              # http://127.0.0.1:4300 — API + 빌드된 화면
# 또는 개발 모드: npm run dev  (API 4300 + Vite 5173, 화면 수정 즉시 반영)
```

로그인 화면에서 모의 사용자를 골라 들어간다. 추천 순서: 한지수(자산 담당자) → 오민재(승인자) → 문태호(감사 담당자). 모의법인 B 사용자는 조직 격리와 빈 상태 확인용이다.

환경변수는 `.env.example` 참조. `MOCK_PRICE_FEED=off`로 실행하면 30분 뒤 평가액에 '시세 지연' 상태가 표시된다.

새로 등록한 주소는 다른 사람이 확인한 뒤에도 기본 24시간 '사용 대기'라 그동안 출금 요청에 쓸 수 없다(설계 가정 A-31, 대기 중 정지는 주소 상세에서). 주소 등록 → 확인 → 출금 요청을 한 번에 시연하려면 `ADDRESS_COOLDOWN_HOURS=0 npm start`처럼 환경변수를 주고 서버를 띄운다(서버는 `.env` 파일을 읽지 않는다). E2E도 이 값으로 돌며, 사용 대기 자체는 시드의 사용 대기 주소로 따로 검사한다(`e2e/address-lifecycle.spec.ts`).

감사 담당자(문태호)가 감사 기록에서 내려받는 CSV는 맨 위에 표지(기간·조건·내보낸 사람·내보낸 시각(한국 시간)·해시 연결 확인 결과·보관용 값)가 붙고, 빈 줄 하나 뒤에 표가 온다. 표지와 승인·반려 행의 '결정 근거' 열은 내보낼 때 계산한 값이며 해시 대상이 아니고, 표의 각 행과 마지막 '해시' 열은 저장된 기록 그대로다. 프로그램으로 읽을 때는 빈 줄 다음 '순번'으로 시작하는 줄을 머리글로 쓴다(`docs/api.md` '감사 기록 CSV').

## 검증

```bash
npm run typecheck      # TypeScript
npm test               # 단위 + API 통합 테스트 (vitest, 메모리 DB)
npm run build && npm run e2e   # 실제 Chromium E2E + 접근성 자동 검사 (전용 DB, 포트 4400)
node scripts/screens.mjs       # 실행 중인 서버의 주요 화면 캡처 → artifacts/screenshots/
node scripts/screens-states.mjs  # 대화상자·이탈 확인·폼 오류·검색 상태 캡처
```

## Vercel 공개 데모

같은 앱을 **모의 데이터 공개 데모**로 Vercel에 올릴 수 있다. 구성·프로젝트 설정·배포 게이트·되돌리기는 [docs/deploy-vercel.md](docs/deploy-vercel.md)에 있다. 프로젝트 연결·환경변수 설정·배포는 그때마다 사용자 확인을 받은 뒤에만 한다.

- **켜는 조건:** `VERCEL=1` 또는 `NODE_ENV=production`에서는 기동을 거부하고, Vercel 프로젝트 환경변수에 `DEMO_PUBLIC=1`(그리고 `NODEJS_HELPERS=0`, `DEMO_SESSION_SECRET`)을 명시했을 때만 공개 데모로 뜬다. `NODE_ENV`·`AUTH_MODE`·`DB_PATH`는 설정하지 않는다. Root Directory `app`, Node.js 24.x. git 푸시로는 배포되지 않으며(`vercel.json`), 전체 검증을 통과한 뒤 수동으로만 배포한다. `DEMO_SESSION_SECRET`은 32바이트 이상 무작위 값(운영·미리보기 환경변수, 저장소에 넣지 않음)이며, 없거나 짧으면 함수가 기동을 거부한다.
- **공개 범위:** 운영 주소(`koda-inha-dashboard.vercel.app`)는 보호 없이 공개한다. 화면에 넣는 값이 모두 더미·가상 데이터이기 때문이다([DEC-004](../docs/decisions.md#제안-기록), DEC-001 대체). 미리보기 배포는 Vercel Authentication으로 보호한다.

공개 데모의 한계:

- 로컬과 같은 **개발용 로그인(비밀번호 없음)·모의 데이터·모의 커스터디**로만 동작한다. 모의가 아닌 커스터디 어댑터나 조직이 있으면 기동하지 않는다. KODA 공식 서비스가 아니며 실제 계정·자산과 연결되지 않는다.
- 데이터·세션·요청 한도는 **인스턴스마다 메모리**에 있어 재시작·재배포·인스턴스 추가 때 처음 상태로 돌아간다. 화면 상단 띠와 로그인 화면이 이를 알리고, 인스턴스가 바뀌면 안내를 띄운다. 재시작 뒤에도 요청·세션이 남는 동작(`tests/api.test.ts`)은 로컬 모드에만 해당한다.
- 인스턴스당 새로 만들 수 있는 주소 등록·출금 요청·인사이트 게시는 종류별 200건(422 `DEMO_LIMIT`)이고, 세션은 기본 120분, 함수 실행 시간은 15초까지다. 감사 기록 해시 검증은 한 인스턴스 안에서만 의미가 있다.
- 실제 Vercel 배포에서의 동작(경로 다시 쓰기, 함수 번들 내용, 런타임 Node 버전)은 아직 확인하지 않았다([docs/deploy-vercel.md](docs/deploy-vercel.md) 4절).

```bash
npm run build:vercel                          # dist/ + .vercel-server/handler.mjs
node scripts/smoke-deploy.mjs --local 4418    # 빌드된 함수를 공개 데모 모드로 띄워 API 안전 장치 확인 후 종료
# 배포 후(보호된 미리보기 주소, 우회 값은 셸에만. 공개 운영 주소는 smoke-deploy에 --public):
E2E_BASE_URL=https://<preview> VERCEL_AUTOMATION_BYPASS_SECRET=<값> npx playwright test   # a11y·responsive만
VERCEL_AUTOMATION_BYPASS_SECRET=<값> node scripts/smoke-deploy.mjs https://<preview>
```

## 스택 선택 이유

| 선택 | 이유 |
| --- | --- |
| Fastify + TypeScript | 서버 권한 검사·오류 형식을 한곳에서 통제, `inject`로 네트워크 없이 API 테스트 |
| node:sqlite (SQLite) | 별도 DB 서버·네이티브 빌드 없이 트랜잭션·트리거·부분 고유 인덱스로 데이터 일관성과 감사 불변성을 저장 계층에서 검증. 운영에서는 PostgreSQL 등으로 교체 전제(`docs/operations.md`) |
| React + React Router + TanStack Query | 목록 상태를 URL에 보관, 서버 상태 캐시·재시도, 무한 목록 |
| Zod (서버 입력 스키마) | 입력 검증 규칙과 한국어 메시지를 `shared/schemas.ts` 한곳에 두고, 화면은 서버가 돌려준 필드 오류를 그대로 보인다(화면 번들에는 들어가지 않음) |
| Vitest / Playwright / axe | API·권한 회귀 테스트, 실제 브라우저 흐름·반응형·접근성 자동 검사 |

## 구조

```
server/   app.ts(라우트) auth.ts authz.ts audit.ts db.ts migrations/ seed.ts
          domain/ (addresses, requests, readmodels, catalog, idempotency)  adapters/custody.ts
shared/   decimal.ts(정밀 소수) address-rules.ts terms.ts(용어·상태) schemas.ts(Zod)
src/      pages/ components/ (화면)   tests/ (vitest)   e2e/ (Playwright)
config/   policy.json(승인·주소 정책 가정) insight-policy.json(인사이트 운영 설정)
docs/     api.md assumptions.md traceability.md tab-design.md operations.md experiments.md
          deploy-vercel.md(공개 데모) oss-tracking.md(오픈소스 후보·결정 기록)
          structure-benchmark.md(다른 법인용 대시보드와의 구조 비교, A1 근거)
```

설계 규칙은 [DESIGN.md](DESIGN.md), 상호작용 소유권·검증은 [UX-CONTRACT.md](UX-CONTRACT.md)(정적 검사 설정 `premium-ui.json`), 오픈소스 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). 검토한 오픈소스 후보와 결정(적용·보류·제외), 버전 고정·출시 2주·라이선스 규칙은 [docs/oss-tracking.md](docs/oss-tracking.md)에 기록한다.