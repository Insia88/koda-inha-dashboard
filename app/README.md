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

## 검증

```bash
npm run typecheck      # TypeScript
npm test               # 단위 + API 통합 테스트 (vitest, 메모리 DB)
npm run build && npm run e2e   # 실제 Chromium E2E + 접근성 자동 검사 (전용 DB, 포트 4400)
node scripts/screens.mjs       # 실행 중인 서버의 주요 화면 캡처 → artifacts/screenshots/
```

## 스택 선택 이유

| 선택 | 이유 |
| --- | --- |
| Fastify + TypeScript | 서버 권한 검사·오류 형식을 한곳에서 통제, `inject`로 네트워크 없이 API 테스트 |
| node:sqlite (SQLite) | 별도 DB 서버·네이티브 빌드 없이 트랜잭션·트리거·부분 고유 인덱스로 데이터 일관성과 감사 불변성을 저장 계층에서 검증. 운영에서는 PostgreSQL 등으로 교체 전제(`docs/operations.md`) |
| React + React Router + TanStack Query | 목록 상태를 URL에 보관, 서버 상태 캐시·재시도, 무한 목록 |
| Zod (공용 스키마) | 화면과 서버가 같은 검증 규칙과 한국어 메시지를 사용 |
| Vitest / Playwright / axe | API·권한 회귀 테스트, 실제 브라우저 흐름·반응형·접근성 자동 검사 |

## 구조

```
server/   app.ts(라우트) auth.ts authz.ts audit.ts db.ts migrations/ seed.ts
          domain/ (addresses, requests, readmodels, catalog, idempotency)  adapters/custody.ts
shared/   decimal.ts(정밀 소수) address-rules.ts terms.ts(용어·상태) schemas.ts(Zod)
src/      pages/ components/ (화면)   tests/ (vitest)   e2e/ (Playwright)
config/   policy.json(승인·주소 정책 가정) insight-policy.json(인사이트 운영 설정)
docs/     api.md assumptions.md traceability.md tab-design.md operations.md experiments.md
```

설계 규칙은 [DESIGN.md](DESIGN.md), 오픈소스 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).