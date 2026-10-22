import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { router } from './App.tsx';
import { ApiError } from './api.ts';
// Pretendard(OFL-1.1) 가변 글꼴의 동적 서브셋. 빌드할 때 글꼴 파일이 dist/assets에 함께 들어가 같은 출처에서만 내려받는다(외부 CDN 없음).
// 라이선스 원문은 public/fonts/PRETENDARD-LICENSE.txt로 함께 배포한다.
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
// Source Code Pro(OFL-1.1, Adobe 원본 그대로) 가변 글꼴 1개를 같은 출처에서. 주소·지문 같은 식별자에만 쓴다. 라이선스 원문은 public/fonts/SOURCE-CODE-PRO-LICENSE.txt.
// 같은 파일에 웹 글꼴이 오기 전 시스템 글꼴(맑은 고딕·Consolas)의 크기를 맞추는 local() 대체 글꼴도 둔다(내려받는 바이트 없음).
import './fonts.css';
import './styles.css';

// 공개 사이트 진입: 비로그인 방문자가 루트(/)로 오면 KODA 공식 사이트로 바로 보낸다.
// 로그인 사용자(표시 쿠키)와 로컬 E2E(localhost)에서는 기존 대시보드 흐름을 유지한다.
try {
  const host = location.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (!local && location.pathname === '/' && !document.cookie.includes('koda_logged_in=1')) {
    location.replace('/site');
  }
} catch {
  /* location을 쓸 수 없는 환경(테스트 러너의 초기화 등)은 무시한다. */
}

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && [401, 403, 404, 422].includes(e.status)) && n < 2,
      refetchOnWindowFocus: true,
      staleTime: 10_000,
    },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);