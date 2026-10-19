import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { router } from './App.tsx';
import { ApiError } from './api.ts';
// Pretendard(OFL-1.1) 가변 글꼴의 동적 서브셋. 빌드할 때 글꼴 파일이 dist/assets에 함께 들어가 같은 출처에서만 내려받는다(외부 CDN 없음).
// 라이선스 원문은 public/fonts/PRETENDARD-LICENSE.txt로 함께 배포한다.
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './styles.css';

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