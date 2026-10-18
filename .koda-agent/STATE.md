# KODA 대시보드 작업 상태

갱신: 2026-10-19 (회차 2 시작)

## 현재 상태 (확인한 사실)
- 브랜치: `feat/enterprise-dashboard-app` (main 5d7ab25에서 분기, 커밋 없음). origin/main도 5d7ab25 — fetch로 확인, 새 브랜치/커밋 없음.
- Notion/Drive 도구 연결 없음 → 로컬 사본(context/)만 사용. 최신 Notion/Drive 변경은 확인하지 못함.
- 저장소에 AGENTS.md/CLAUDE.md 없음. 원본 앱 코드 없음 → `app/`에 새로 구축.
- 이전 회차: `app/package.json`, `package-lock.json`, `node_modules`만 존재(의존성 설치까지). 보존함.

## 이번 회차 계획
1. 스택: Fastify(서버) + node:sqlite(내장, 네이티브 빌드 불필요) + React/Vite + TanStack Query + zod + Playwright/Vitest (이미 설치된 버전 사용).
2. 첫 수직 흐름: 개발 로그인 → 자산 현황 → 주소 등록(확인 절차) → 출금 요청 → 다른 승인자 승인/반려 → 감사 기록.
3. 서버 권한(테넌트·역할·리소스), 상태 전이, 멱등성, 낙관적 잠금, 감사 로그 불변 트리거.
4. 나머지 탭(활동 내역, 스테이킹, 지갑, 토큰, 조직, 마켓 인사이트), DESIGN.md, 테스트, 스크린샷.

## 진행 기록
- [완료] 서버 골격: Fastify + node:sqlite, 마이그레이션 001, 모의 시드, 인증(개발용)·권한·감사(해시 체인·불변 트리거)·주소록·출금 요청 상태기계·멱등성. `/api/healthz` 기동 확인.
- [완료] API 테스트 37건 통과(vitest): 조직 격리, 자기 승인 거부(API+DB 트리거), 역할별 접근, 상태 전이, 멱등성, 동시 승인 충돌, 2인 승인, 금액 정밀도, 주소/네트워크 불일치, 감사 불변·해시 체인, CSV 수식 주입, 500 시 롤백, 재시작 후 유지, 요청 한도.
- 수정한 결함: 승인 1/2일 때 UPDATE SQL 구문 오류(bump 빈 sets) → 수정.
- 다음: React 화면(로그인→홈→주소 등록→요청→승인→감사) 구축.
