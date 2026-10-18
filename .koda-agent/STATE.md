# KODA 대시보드 작업 상태

갱신: 2026-10-19 (회차 2)

## 기준 사실
- 브랜치: `feat/enterprise-dashboard-app` (main 5d7ab25에서 분기). origin/main 5d7ab25 — fetch로 확인, 원격에 새 커밋·앱 코드 없음. 로컬 커밋만 있음(푸시·PR 안 함, main 병합 안 함).
- 커밋 작성자: 저장소에 git 사용자 설정이 없어 커밋마다 `-c user.name="KODA build agent" -c user.email="agent@localhost.invalid"`를 사용(전역 설정 변경 안 함). 푸시 전 작성자 정책은 저장소 소유자가 결정.
- Notion/Drive 연결 도구 없음 → 로컬 사본(context/)만 사용. 최신 Notion/Drive 변경은 확인하지 못함.
- 원본 앱 없음 → `app/`에 새로 구축. 이전 회차의 package.json/lock/node_modules 보존(스크립트·의존성 3개 추가: @fastify/rate-limit, @fastify/helmet, @axe-core/playwright(dev)).

## 완료
- 서버: Fastify + node:sqlite, 마이그레이션·시드, 개발용 로그인(운영 모드 기동 거부), 역할·조직 권한(서버), CSRF, 요청 한도, 보안 헤더, 감사 로그(해시 체인 + UPDATE/DELETE 금지 트리거), 주소록(형식·중복·유사 주소·끝자리 재입력·2인 확인), 출금 요청 상태기계(작성→검토→승인 대기→처리 중→완료/실패, 반려, 취소), 자기 승인 금지(API+DB 트리거), 2인 승인 정책, 멱등성, 낙관적 잠금, 수량 예약, 모의 커스터디, CSV 내보내기(수식 무력화), Market Insight 화이트리스트·운영자 게시, 실험 플래그(기본 꺼짐).
- 화면: 로그인·홈·잔고·활동·요청(목록/작성/상세)·주소록(목록/등록/상세)·지갑·스테이킹·토큰·조직·감사·인사이트·인사이트 관리. URL 상태 유지, 로딩/오류/권한 없음/빈 상태.
- 문서: app/README.md, app/DESIGN.md, app/THIRD_PARTY_NOTICES.md, app/docs/{api,assumptions,traceability,tab-design,operations,experiments}.md. 루트 README에 앱 링크 1줄.

## 검증 결과 (마지막 실행 2026-10-19)
- `npm run typecheck` 통과, `npm run build` 통과, `npm audit` 0건.
- `npm test` 38/38 통과 (단위 + API: 조직 격리, 자기 승인, 역할, 전이, 멱등, 동시 승인, 2인 승인, 정밀도, 주소/네트워크 불일치, 감사 불변, CSV, 500 롤백, 재시작 유지, 요청 한도, 실험 플래그).
- `npm run e2e` 22/22 통과 (실제 Chromium: 수직 흐름, 반려, 목록, 권한, 키보드·세션 만료 복귀, 인사이트, 모바일, axe 15화면 위반 0).
- 스크린샷 45장(15화면×데스크톱/태블릿/모바일) 콘솔 오류 0: app/artifacts/screenshots/ (git 제외, 저장소 규칙상 이미지는 Drive).
- 미실시: 실제 사용자 테스트·3초 이해도 측정(측정 없음), 스크린리더 실사용, 운영 SSO·커스터디 연동.

## 실행
```
cd app && npm ci && npm run db:reset && npm run build && npm start   # http://127.0.0.1:4300
npm test ; npm run build && npm run e2e ; node scripts/screens.mjs ; bash scripts/stop-server.sh
```

- CI: .github/workflows/app-check.yml (PR 시 typecheck·test·build·e2e). `npm run check` 로컬 통과.

## 대기(WAIT) 근거
명시된 수용 기준(DASH-001~007, 서버 권한·격리·자기 승인·전이·멱등·동시성·정밀도·감사 불변·CSV·오류·새로고침·E2E·반응형·접근성 자동 검사)이 위 검사로 충족됨. 남은 항목은 KODA 측 자료·테스트 환경이 있어야 진행 가능하므로 범위를 임의로 넓히지 않고 대기한다. 새 지시나 자료가 오면 이 파일부터 읽고 재개.

## 남은 항목 / 다음 작업
- 외부 자료 필요(차단): 실제 역할·상태·승인 정책, 주소 검증 규칙, 인사이트 운영 기준, 익명화 인터뷰, SSO·커스터디 테스트 환경 (app/docs/operations.md).
- 선택 개선 후보: 요청 목록 금액 정렬, 감사 CSV 대량 스트리밍, 주소 변경(수정) 흐름 — 요구사항에 명시되지 않음.
