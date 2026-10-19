# 제3자 구성요소 고지

이 앱은 아래 오픈소스 패키지를 정확한 버전으로 고정해 사용한다(`package.json`, `package-lock.json`). 각 패키지의 저작권·라이선스 원문은 `node_modules/<패키지>/LICENSE`에 포함되어 배포된다. 빌드 결과물(`dist/`)에는 런타임 의존성 중 React, React DOM, React Router, TanStack Query, Zod, Tabler Icons(사용한 아이콘만)가 번들된다.

| 패키지 | 버전 | 라이선스 | 도입 이유 |
| --- | --- | --- | --- |
| fastify | 5.12.7 | MIT | API 서버. 스키마 친화적 라우팅, `inject` 기반 서버 테스트 |
| @fastify/cookie | 11.1.3 | MIT | HttpOnly 세션 쿠키 |
| @fastify/helmet | 13.2.0 | MIT | CSP·보안 헤더 |
| @fastify/rate-limit | 11.2.1 | MIT | 요청 한도(로그인 별도 한도) |
| @fastify/static | 10.1.6 | MIT | 빌드된 화면 서빙 |
| react / react-dom | 19.3.1 | MIT | 화면 |
| react-router | 8.4.0 | MIT | 라우팅, URL 검색 파라미터로 목록 상태 유지 |
| @tanstack/react-query | 5.104.4 | MIT | 서버 상태 캐시·재시도·무한 목록 |
| zod | 4.6.7 | MIT | 서버·화면 공용 입력 검증 스키마 |
| @tabler/icons-react | 3.49.0 | MIT | 아이콘 (Copyright (c) 2020-2024 Paweł Kuna) |
| vite / @vitejs/plugin-react | 8.3.4 / 6.1.2 | MIT | 빌드(개발 도구) |
| typescript | 7.0.2 | Apache-2.0 | 타입 검사(개발 도구) |
| tsx | 4.23.15 | MIT | TypeScript 서버 실행 |
| vitest | 5.0.5 | MIT | 단위·API 테스트(개발 도구) |
| @playwright/test | 1.64.1 | Apache-2.0 | 브라우저 E2E·스크린샷(개발 도구) |
| @axe-core/playwright | 4.14.0 | MPL-2.0 | 접근성 자동 검사(개발 도구, 배포물에 포함하지 않음) |
| fast-check | 4.10.2 | MIT | 수량 파싱 속성 기반 테스트(개발 도구, 배포물에 포함하지 않음) |
| @fast-check/vitest | 0.5.0 | MIT | fast-check를 Vitest 테스트로 실행(개발 도구, 배포물에 포함하지 않음) |
| esbuild | 0.28.2 | MIT | 서버 코드 번들(`build:api`, 빌드 도구). tsx가 잠근 버전과 같은 버전으로 고정 |
| pretendard | 1.3.9 | OFL-1.1 | 화면 서체(Pretendard). 화면에서 불러온 글꼴 파일은 빌드 결과물(`dist/`)에 번들되어 외부 CDN을 쓰지 않는다 |

Pretendard는 SIL Open Font License 1.1로 배포된다(Copyright (c) 2021, Kil Hyung-jin, Reserved Font Name Pretendard). 라이선스 원문은 `node_modules/pretendard/dist/LICENSE.txt`에 있다. 글꼴 파일만 따로 판매하지 않고, 글꼴을 수정해 배포할 때는 예약된 글꼴 이름 "Pretendard"를 쓰지 않는다. 글꼴 파일을 `dist/`에 함께 배포할 때는 이 저작권 고지와 라이선스를 함께 둔다(OFL 1.1 제2조).

fast-check(Copyright (c) 2017 Nicolas DUBIEN), @fast-check/vitest(Copyright (c) 2020 Nicolas DUBIEN), esbuild(Copyright (c) 2020 Evan Wallace)는 테스트·빌드에만 쓰며 배포물에 포함하지 않는다.

데이터 저장은 Node.js 내장 `node:sqlite`(SQLite 3.53, Node.js 라이선스/SQLite 퍼블릭 도메인)를 사용해 네이티브 빌드 의존성을 추가하지 않았다.

확인: 2026-10-19 `npm audit` 결과 알려진 취약점 0건. 버전 갱신 시 `npm audit`와 전체 테스트를 다시 실행한다.

## 로고·에셋
`public/koda-logo.svg`는 KODA 공식 웹사이트 헤더에서 추출된 공식 로고(공동 작업 에셋 `logos/koda/KODA-official-web-logo.svg`)다. 상표·저작권은 KODA에 있으며 **오픈소스 라이선스가 부여되지 않는다**. 산학과제의 기관 식별 용도로 원본 비율·색상을 유지해 사용한다.