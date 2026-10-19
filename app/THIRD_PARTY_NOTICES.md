# 제3자 구성요소 고지

이 앱은 아래 오픈소스 패키지를 정확한 버전으로 고정해 사용한다(`package.json`, `package-lock.json`). 배포물은 두 갈래이고, 고지 방식이 다르다.

- **화면(`dist/`, Vercel이 정적 파일로 제공):** `node_modules` 없이 `dist/`만 배포된다. 화면 스크립트 `dist/assets/index-*.js`에는 React·React DOM(함께 묶이는 scheduler 포함), React Router, TanStack Query(함께 묶이는 `@tanstack/query-core` 포함), Tabler Icons(사용한 아이콘만)와 Vite가 넣는 모듈 미리 불러오기 보조 코드가 번들된다. 압축 과정에서 패키지의 저작권 주석이 빠지므로, 이 구성요소들의 저작권 표시와 MIT 라이선스 원문은 `public/THIRD_PARTY_LICENSES.txt`에 모아 두었고 빌드 때 **`dist/THIRD_PARTY_LICENSES.txt`**로 함께 배포된다. 번들 구성이 바뀌거나 버전을 올려 원문이 달라지면 `tests/third-party-licenses.test.ts`가 실패하므로 이 파일을 새 원문으로 고친다. Pretendard 글꼴 파일(가변 글꼴 동적 서브셋 woff2)과 그 라이선스 원문(`dist/fonts/PRETENDARD-LICENSE.txt`)도 함께 들어간다(아래).
- **서버 함수(`.vercel-server/handler.mjs`):** 앱 서버 코드만 묶고 패키지는 묶지 않는다(`build:api`의 `--packages=external`). Fastify·Zod 등은 실행 때 `node_modules`에서 불러오며, 각 패키지의 저작권·라이선스 원문은 그 패키지의 `node_modules/<패키지>/` LICENSE 파일에 있다. 서버 코드는 이용자 브라우저로 전달되지 않는다. Zod는 서버 입력 검증에만 쓰여 화면 번들에는 들어가지 않는다.

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
| zod | 4.6.7 | MIT | 서버 입력 검증 스키마(`shared/schemas.ts`, 화면 번들에는 들어가지 않음) |
| @tabler/icons-react | 3.49.0 | MIT | 아이콘 (Copyright (c) 2020-2026 Paweł Kuna) |
| vite / @vitejs/plugin-react | 8.3.4 / 6.1.2 | MIT | 빌드(개발 도구). Vite가 화면 스크립트에 넣는 모듈 미리 불러오기 보조 코드의 고지는 `dist/THIRD_PARTY_LICENSES.txt`에 있다 |
| typescript | 7.0.2 | Apache-2.0 | 타입 검사(개발 도구) |
| tsx | 4.23.15 | MIT | TypeScript 서버 실행 |
| vitest | 5.0.5 | MIT | 단위·API 테스트(개발 도구) |
| @playwright/test | 1.64.1 | Apache-2.0 | 브라우저 E2E·스크린샷(개발 도구) |
| @axe-core/playwright | 4.14.0 | MPL-2.0 | 접근성 자동 검사(개발 도구, 배포물에 포함하지 않음) |
| fast-check | 4.10.2 | MIT | 수량 파싱 속성 기반 테스트(개발 도구, 배포물에 포함하지 않음) |
| @fast-check/vitest | 0.5.0 | MIT | fast-check를 Vitest 테스트로 실행(개발 도구, 배포물에 포함하지 않음) |
| esbuild | 0.28.2 | MIT | 서버 코드 번들(`build:api`, 빌드 도구). tsx가 잠근 버전과 같은 버전으로 고정 |
| pretendard | 1.3.9 | OFL-1.1 | 화면 서체(Pretendard Variable). `src/main.tsx`가 `pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css`를 불러오고, 빌드 때 그 CSS가 가리키는 woff2 파일(92개)이 `dist/assets/`에 번들된다. 화면은 같은 출처에서만 글꼴을 내려받고 외부 CDN을 쓰지 않는다 |

Pretendard는 SIL Open Font License 1.1로 배포된다(Copyright (c) 2021, Kil Hyung-jin, Reserved Font Name Pretendard). 라이선스 원문은 `node_modules/pretendard/dist/LICENSE.txt`에 있고, 같은 파일을 `public/fonts/PRETENDARD-LICENSE.txt`로 복사해 두어 빌드 결과물에는 `dist/fonts/PRETENDARD-LICENSE.txt`로 글꼴 파일과 함께 들어간다(OFL 1.1 제2조). 번들된 CSS는 압축 과정에서 원본 CSS 머리말의 저작권 주석이 빠지므로, 이 별도 파일이 고지 역할을 한다. 패키지 버전을 바꾸면 이 파일도 새 버전의 원문으로 다시 복사한다. 글꼴 파일만 따로 판매하지 않고, 글꼴을 수정해 배포할 때는 예약된 글꼴 이름 "Pretendard"를 쓰지 않는다.

fast-check(Copyright (c) 2017 Nicolas DUBIEN), @fast-check/vitest(Copyright (c) 2020 Nicolas DUBIEN), esbuild(Copyright (c) 2020 Evan Wallace)는 테스트·빌드에만 쓰며 배포물에 포함하지 않는다.

데이터 저장은 Node.js 내장 `node:sqlite`(SQLite 3.53, Node.js 라이선스/SQLite 퍼블릭 도메인)를 사용해 네이티브 빌드 의존성을 추가하지 않았다.

확인: 2026-10-19 `npm audit` 결과 알려진 취약점 0건. 버전 갱신 시 `npm audit`와 전체 테스트를 다시 실행한다.

## 로고·에셋
`public/koda-logo.svg`는 KODA 공식 웹사이트 헤더에서 추출된 공식 로고(공동 작업 에셋 `logos/koda/KODA-official-web-logo.svg`)다. 상표·저작권은 KODA에 있으며 **오픈소스 라이선스가 부여되지 않는다**. 산학과제의 기관 식별 용도로 원본 비율·색상을 유지해 사용한다.
## 생성 이미지
`public/insights/covers/*.webp`(8종: stablecoin, ethereum, bitcoin, kaia, payments, regulation, security, market)는 2026-10-19에 Higgsfield의 이미지 생성 기능(모델 `gpt_image_2_5`)으로 만든 주제별 장식용 그림이다. 실제 리서치 기관의 리포트 표지가 아니며, 모의 데이터 화면에서 자료의 주제를 시각적으로 구분하는 데만 쓴다. 글자·로고·인물은 넣지 않았고, 480px 너비 WebP로 줄여 같은 출처에서 제공한다(합계 약 46KB). 실제 운영에서는 기관이 제공한 표지나 KODA가 승인한 그림으로 바꾼다.
