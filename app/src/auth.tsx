import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { api, setCsrf, ApiError } from './api.ts';
import type { Role } from '../shared/terms.ts';
import { hasDirtyForms, releaseAllGuards } from './lib/unsaved.tsx';
import { ConfirmDialog } from './components/Dialog.tsx';
import { SoloScreen } from './components/DemoFooter.tsx';

export interface Me {
  user: { id: string; name: string; email: string; title: string };
  org: { id: string; name: string; kind: 'customer' | 'operator'; isMock: boolean };
  roles: Role[];
  roleLabels: string[];
  permissions: string[];
  csrfToken: string;
  /** mode·instanceId·seededAt는 실행 형태(api.ts DeploymentInfo)와 같은 값이다. 화면은 mode만 쓴다(A5). */
  environment: {
    name: string; authMode: string; custody: string; custodyIsMock: boolean; dataIsMock: boolean;
    mode?: 'local' | 'public-demo'; instanceId?: string; seededAt?: string | null;
  };
  policy: { confirmTailLength: number; approval: { defaultRequiredApprovals: number; highValueThresholdKrw: string; highValueRequiredApprovals: number } };
  insight: { experiments: { holdingRelatedFilter: boolean } };
}

const Ctx = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(Ctx);
  if (!me) throw new Error('useMe outside AuthGate');
  return me;
}

export function useCan() {
  const me = useMe();
  return (perm: string) => me.permissions.includes(perm);
}

export function AuthGate({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const me = await api<Me>('/api/me');
      setCsrf(me.csrfToken);
      return me;
    },
    retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2,
    staleTime: 60_000,
  });
  const [reauth, setReauth] = useState<{ busy: boolean; error: unknown } | null>(null);
  useEffect(() => {
    const onUnauth = () => {
      // 작성 중인 화면이 있으면 화면을 떠나지 않고 같은 계정으로 다시 로그인하게 한다(입력은 메모리에만 유지).
      if (hasDirtyForms() && q.data) { setReauth((p) => p ?? { busy: false, error: null }); return; }
      qc.clear();
      // 첫 화면(/)의 비로그인 방문은 공개 사이트로 보낸다. 대시보드 안에서 만료된 경우는 기존처럼 로그인으로 보낸다.
      if (loc.pathname === '/') nav('/site', { replace: true });
      else nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}&reason=expired`, { replace: true });
    };
    window.addEventListener('koda:unauthenticated', onUnauth);
    return () => window.removeEventListener('koda:unauthenticated', onUnauth);
  }, [nav, loc, qc, q.data]);
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 401) {
      if (loc.pathname === '/') nav('/site', { replace: true });
      else nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true });
    }
  }, [q.error, nav, loc]);
  if (q.isPending) return <>{fallback}</>;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 401) return <>{fallback}</>;
    // 셸 밖 단독 화면: 본문은 <main>, 공개 데모임을 알면(오류 응답에도 X-Demo-Instance가 온다) 맨 아래 한 줄을 붙인다(A5).
    return (
      <SoloScreen>
        <div className="center-screen" role="alert">
          <h1>대시보드를 불러오지 못했습니다</h1>
          <p>{(q.error as Error).message}</p>
          <button className="btn btn-primary" onClick={() => q.refetch()}>다시 시도</button>
        </div>
      </SoloScreen>
    );
  }
  const relogin = async () => {
    setReauth({ busy: true, error: null });
    try {
      // 개발용 인증 어댑터: 같은 사용자로만 재로그인한다. 운영에서는 SSO 재인증 창으로 교체한다.
      await api('/api/auth/dev-login', { method: 'POST', body: { userId: q.data.user.id } });
      await q.refetch();
      setReauth(null);
    } catch (e) { setReauth({ busy: false, error: e }); }
  };
  return (
    <Ctx.Provider value={q.data}>
      {children}
      <ConfirmDialog
        open={reauth !== null}
        title="로그인 세션이 만료되었습니다"
        safeAction="confirm"
        confirmLabel={`${q.data.user.name}(으)로 다시 로그인`}
        cancelLabel="작성 내용 버리고 로그인 화면으로"
        busy={reauth?.busy}
        error={reauth?.error}
        onConfirm={relogin}
        onCancel={() => {
          setReauth(null);
          releaseAllGuards();
          qc.clear();
          nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}&reason=expired`, { replace: true });
        }}
      >
        <p>작성 중인 내용은 이 화면에 그대로 남아 있습니다. 같은 계정으로 다시 로그인한 뒤 저장이나 제출을 다시 누르세요.</p>
        <p className="muted small">모의 로그인입니다. 운영에서는 KODA 인증(SSO) 재확인으로 바뀝니다.</p>
      </ConfirmDialog>
    </Ctx.Provider>
  );
}