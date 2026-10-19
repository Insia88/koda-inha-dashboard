# 오픈소스 추적 기록

이 앱에 넣을지 검토한 오픈소스 후보와 그 결정을 한곳에 남긴다. 실제로 배포물에 들어간 구성요소의 저작권·라이선스 고지는 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)가 단일 출처다.

- 버전·출시일·라이선스·저장소는 2026-10-19에 npm 레지스트리(`npm view <패키지> time license repository`)로 확인했다. 출시일은 레지스트리 게시일(UTC)이다.
- 결정 근거의 크기·의존성 수·취약점(OSV) 조회는 2026-10-19 독립 검수(R1, 저장소 밖 로컬 자료)의 조사 결과를 옮긴 것이다. 조사 당시 후보와 그 런타임 의존성의 OSV 알려진 취약점은 0건이었다.
- 결정: **적용**(설치·고정했거나 버전을 지정해 실행), **보류**(쓸 만하지만 조건이 갖춰질 때까지 미룸), **제외**(쓰지 않기로 함).

## 후보 목록

| 패키지@버전 | GitHub 저장소 | 라이선스 | 출시일 | 결정 | 쓰는 곳 / 쓰지 않는 이유 | 확인일 |
| --- | --- | --- | --- | --- | --- | --- |
| vercel@62.2.0 (CLI) | https://github.com/vercel/vercel (`packages/cli`) | Apache-2.0 | 2026-10-02 | 적용 | 배포 게이트에서 `npx vercel@62.2.0 build`로 함수 산출물을 확인하고 보호된 미리보기를 수동 배포할 때만 쓴다([deploy-vercel.md](deploy-vercel.md) 5절). `package.json`에 넣지 않고 배포물에 포함되지 않는다. 확인일까지 실행한 적은 없다. 최신 64.5.0(2026-10-16)은 출시 2주가 안 되어 고르지 않았다. 고지 표에는 아직 없다(아래 열린 항목) | 2026-10-19 |
| esbuild@0.28.2 | https://github.com/evanw/esbuild | MIT | 2026-08-08 | 적용 | 개발 의존성. `npm run build:api`가 `server/vercel.ts`를 `.vercel-server/handler.mjs` 하나로 묶는다. tsx가 잠근 버전과 같은 버전으로 고정했다. 함수에는 묶은 결과만 들어가고 esbuild 자체는 배포되지 않는다. 고지 표에 있음 | 2026-10-19 |
| fast-check@4.10.2 | https://github.com/dubzzz/fast-check | MIT | 2026-09-19 | 적용 | 개발 의존성. `tests/decimal.property.test.ts`(수량 쉼표·왕복 속성 1,000회 이상), `tests/audit-chain.test.ts`(임의 문자열 감사 체인 속성). 배포물 미포함. 고지 표에 있음 | 2026-10-19 |
| @fast-check/vitest@0.5.0 | https://github.com/dubzzz/fast-check (`packages/vitest`) | MIT | 2026-09-11 | 적용 | 개발 의존성. `tests/decimal.property.test.ts`의 `test.prop`. 요구하는 vitest(^4.1.0 \|\| ^5.0.0)와 설치된 vitest 5.0.5가 맞는다. 배포물 미포함. 고지 표에 있음 | 2026-10-19 |
| pretendard@1.3.9 | https://github.com/orioncactus/pretendard | OFL-1.1 | 2023-11-05 | 적용 | 런타임 의존성으로 고정했고 화면에 적용했다. `src/main.tsx`가 `pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css`를 불러와 빌드 때 woff2 92개가 `dist/assets/`에 들어가고, OFL 원문은 `public/fonts/PRETENDARD-LICENSE.txt` → `dist/fonts/PRETENDARD-LICENSE.txt`로 함께 배포된다. 같은 출처에서만 내려받는지는 E2E `글꼴: Pretendard Variable을 같은 출처에서만 내려받는다`(`display.spec.ts`)로 확인한다. 글꼴이므로 라이선스 예외(아래 규칙). 고지 표에 있음 | 2026-10-19 |
| @noble/hashes@2.4.0 | https://github.com/paulmillr/noble-hashes | MIT | 2026-08-27 | 보류 | EIP-55 대소문자 체크섬(keccak_256)에 맞는 도구다(`node:crypto`의 sha3-256은 Keccak-256이 아니라 대신할 수 없음). 지금은 `MOCK-` 형식만 허용하고 체크섬은 실제 형식 검증과 함께 미룬다 | 2026-10-19 |
| oxlint@1.86.0 | https://github.com/oxc-project/oxc (`npm/oxlint`) | MIT | 2026-09-28 | 보류 | TypeScript 7.0.2와 함께 쓸 수 있는 타입 기반 린터(조사 기준). 첫 실행 결과가 여러 작업 묶음의 파일에 걸쳐 있어, 묶음 병합 뒤 보고 전용으로 먼저 돌린다. 최신 1.88.0(2026-10-13)은 출시 2주 미만 | 2026-10-19 |
| oxlint-tsgolint@7.0.2003 | https://github.com/oxc-project/tsgolint | MIT | 2026-09-24 | 보류 | oxlint 타입 기반 모드에 필요한 짝 패키지(>=7.0.2003). oxlint와 함께 결정한다. 최신 7.0.2004(2026-10-10)는 출시 2주 미만 | 2026-10-19 |
| qrcode.react@4.2.0 | https://github.com/zpao/qrcode.react | ISC | 2024-12-11 | 보류 | 입금 주소 QR(우선순위 낮음). React `<svg>`로 그려 현재 CSP에 맞는다. 메모·태그가 필요한 네트워크에서 QR에 메모가 들어가지 않는 문제를 어떻게 안내할지 먼저 정해야 한다 | 2026-10-19 |
| otpauth@9.5.2 | https://github.com/hectorm/otpauth | MIT | 2026-09-03 | 보류 | 승인 직전 재인증(단계 인증)은 KODA 결정 대기다. 같은 화면에 보이는 데모용 OTP는 보안 효과가 없고 실제 단계 인증으로 오해될 수 있다 | 2026-10-19 |
| react-idle-timer@5.7.3 | https://github.com/SupremeTechnopriest/react-idle-timer | MIT | 2026-03-20 (마지막 코드 변경 5.7.2: 2023-06-08) | 제외 | 5.7.3은 버전 번호만 바꾼 배포로, 실제 코드 갱신은 2023-06 이후 없다. 실제 통제는 서버 쪽 유휴 세션 만료이고, 화면 쪽이 필요하면 자체 훅으로 충분하다 | 2026-10-19 |
| bitcoin-address-validation@4.0.0 | https://github.com/ruigomeseu/bitcoin-address-validation | MIT | 2026-09-18 | 보류 | 실제 형식 검증 어댑터에서만 의미가 있다. KODA가 지원 네트워크를 확인하기 전에는 실제 형식 주소를 개발 데이터·화면에 넣지 않는다 | 2026-10-19 |
| @scure/base@2.4.0 | https://github.com/paulmillr/scure-base | MIT | 2026-08-28 | 보류 | 모의 bech32/base58check 체크섬을 만들 때의 대안. 체크섬 도입과 함께 결정한다 | 2026-10-19 |
| viem@2.57.7 | https://github.com/wevm/viem | MIT | 2026-10-14 | 제외 | 압축 해제 28.6 MB에 의존성 8개, `MOCK-` 접두 주소를 거부하고 `shared/decimal.ts`와 기능이 겹친다. 확인일 기준 출시 5일로 2주 규칙에도 맞지 않는다 | 2026-10-19 |
| fastest-levenshtein@1.0.16 | https://github.com/ka-weihe/fastest-levenshtein | MIT | 2022-08-02 | 제외 | 앞·뒤만 같게 만든 위조 주소는 가운데가 달라 편집 거리가 커서 찾지 못한다. 2022년 이후 배포가 없다 | 2026-10-19 |
| canonicalize@5.1.0 | https://github.com/erdtman/canonicalize | Apache-2.0 | 2026-09-18 | 제외 | 필요하지 않다. 감사 해시 v2는 고정 순서 배열의 `JSON.stringify`를 쓰고, WP-11에서 구현한 승인 대상 지문(A-29)은 자체 `canonicalJson`(`server/domain/checks.ts`: 객체 키를 정렬하고 공백 없이 이어 씀)을 쓴다. 지문에는 정수·문자열만 들어가 RFC 8785의 숫자 표기 규칙이 필요 없다 | 2026-10-19 |
| uqr@0.1.3 | https://github.com/unjs/uqr | MIT | 2026-04-03 | 제외 | SVG 문자열을 돌려줘 `dangerouslySetInnerHTML`이 필요하다. QR을 넣는다면 qrcode.react를 쓴다 | 2026-10-19 |
| zod@4.6.7 내장 ko 로케일 | https://github.com/colinhacks/zod | MIT | 2026-10-12 | 보류 | 새 의존성 없이 기본 검증 문구를 한국어로 바꿀 수 있지만 앱 전체의 기본 문구가 바뀌므로 문구 정리 작업과 함께 한다. 참고: zod 4.6.7은 앱이 처음부터 고정한 런타임 의존성이며, 확인일 기준 출시 7일이라 2주 규칙보다 새 버전이다(아래 열린 항목) | 2026-10-19 |
| @libsql/client (버전 미지정, 확인일 최신 0.18.0: 2026-09-02) | https://github.com/tursodatabase/libsql-client-ts | MIT | — | 보류 | 공개 데모의 영속 저장소 후보. `server/db.ts`의 `tx()`와 모든 업무 호출이 동기라 비동기로 바꾸는 큰 작업이 필요하다. 공개 데모는 인스턴스 메모리 SQLite를 쓰고 화면에 알린다 | 2026-10-19 |
| msw@3.0.3 (조사 때 검토 버전) | https://github.com/mswjs/msw | MIT | 2026-10-10 | 제외 | 브라우저 안 모의 백엔드로 정적 데모를 만들면 권한·승인 같은 안전 장치가 서버 밖으로 빠져 실제와 다르게 보인다. 공개 데모도 실제 서버를 모의 데이터로 돌린다. 확인일 기준 출시 9일 | 2026-10-19 |

## How we track (추적 규칙)

새 패키지를 넣거나 버전을 올릴 때 아래를 모두 지키고, 검토한 후보는 결과와 관계없이 위 표에 한 행으로 남긴다. 결정이 바뀌면 행을 지우지 않고 결정과 확인일을 고친 뒤 아래 '변경 이력'에 한 줄을 더한다.

1. **정확한 버전 고정.** `package.json`에 `^`·`~` 없이 정확한 버전을 적고 `package-lock.json`을 함께 커밋하며 `npm ci`로 설치한다. npx로 실행하는 도구도 버전을 붙인다(`npx vercel@62.2.0`).
2. **출시 2주 이상.** 확인일 기준 레지스트리 게시일이 14일 이상 지난 버전만 고른다. 더 새 버전은 표에 적어 두고 다음 확인 때 다시 본다.
3. **허용적 라이선스.** MIT·ISC·BSD·Apache-2.0. 글꼴은 OFL-1.1을 예외로 허용하되 글꼴 파일과 함께 저작권·라이선스 고지를 배포한다. 기존 개발 도구 @axe-core/playwright(MPL-2.0)는 배포물에 넣지 않는 조건으로 쓰고 있다.
4. **런타임 CDN 없음.** 화면과 서버는 실행 중에 외부 CDN에서 스크립트·스타일·글꼴을 받지 않는다. 필요한 파일은 빌드에 포함하고 CSP는 `'self'`로 둔다.
5. **배포하면 고지.** 빌드 결과물(`dist/`)이나 서버 함수에 들어가는 구성요소는 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)에 패키지·버전·라이선스·도입 이유·저작권 고지를 적는다. 현재 고지 표는 개발 도구도 함께 적고 있다. `dist/`는 `node_modules` 없이 배포되므로, 화면 번들에 들어가는 구성요소는 저작권 표시와 라이선스 원문을 `public/THIRD_PARTY_LICENSES.txt`(빌드 때 `dist/THIRD_PARTY_LICENSES.txt`)에도 옮긴다. 빠지거나 버전이 어긋나면 `tests/third-party-licenses.test.ts`가 실패한다.

검토 때는 알려진 취약점(OSV·`npm audit`), 런타임 의존성 수, 설치 스크립트 유무, 최근 유지 보수 여부를 함께 본다.

## Next candidates (다음 후보)

- **@noble/hashes@2.4.0** — 실제 형식 주소를 허용하게 될 때 EIP-55 체크섬 검사. 실제 형식 검증 어댑터(`docs/operations.md` 주소 검증)와 함께 넣는다.
- **qrcode.react@4.2.0** — 입금 주소 QR. 메모·태그가 필요한 네트워크의 안내 방식을 정한 뒤.
- **oxlint@1.86.0 + oxlint-tsgolint@7.0.2003** — 타입 기반 린트. 보고 전용으로 먼저 돌려 결과를 나눈 뒤 검사 단계로 올린다. 그때 2주 규칙에 맞는 최신 버전을 다시 확인한다.
- **bitcoin-address-validation@4.0.0 또는 @scure/base@2.4.0** — 실제 BTC 형식 검증 또는 모의 체크섬. KODA가 지원 네트워크를 확인한 뒤.
- **zod 내장 ko 로케일** — 기본 검증 문구 정리 작업과 함께.

## 열린 항목

- vercel@62.2.0을 처음 실행하기 전에 고지 표에 개발 도구로 적을지 정한다(배포물에는 들어가지 않음).
- zod 4.6.7(2026-10-12 출시)은 2주 규칙보다 새 버전이다. 규칙을 정하기 전에 고정한 런타임 의존성이며, 다음 의존성 갱신 때 2주가 지난 버전인지 다시 확인한다.
- 고지 표의 `npm audit` 0건 기록은 fast-check·esbuild·pretendard 추가 전 확인이었다. 2026-10-19 현재 lockfile(97ecd92)로 `npm audit`를 다시 실행한 결과도 알려진 취약점 0건(의존성 209개)이다. 의존성을 바꿀 때마다 다시 실행한다.

## 변경 이력

| 날짜 | 내용 |
| --- | --- |
| 2026-10-19 | 기록 시작. 독립 검수의 OSS 결정 19건(oxlint 묶음은 두 행)과 fedb25d에서 추가한 4개 패키지를 정리. 현재 lockfile로 `npm audit` 재실행(0건) |
| 2026-10-19 | 문서 정정(검수 G3). pretendard 행: 화면 적용(`src/main.tsx` 불러오기, `dist/assets/` woff2 92개, `dist/fonts/PRETENDARD-LICENSE.txt`)을 반영하고 열린 항목 '화면에서 불러오지 않는다'를 닫음. canonicalize 행: 승인 대상 지문은 미룬 것이 아니라 WP-11에서 자체 `canonicalJson`으로 구현했음을 반영. 규칙 5에 화면 번들 고지 파일(`public/THIRD_PARTY_LICENSES.txt`)을 더함. 결정(적용·제외)은 바뀌지 않음 |
