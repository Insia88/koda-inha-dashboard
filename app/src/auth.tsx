import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { api, setCsrf, ApiError } from './api.ts';
import type { Role } from '../shared/terms.ts';

export interface Me {
  user: { id: string; name: string; email: string; title: string };
  org: { id: string; name: string; kind: 'customer' | 'operator'; isMock: boolean };
  roles: Role[];
  roleLabels: string[];
  permissions: string[];
  csrfToken: string;
  environment: { name: string; authMode: string; custody: string; custodyIsMock: boolean; dataIsMock: boolean };
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
  useEffect(() => {
    const onUnauth = () => {
      qc.clear();
      nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}&reason=expired`, { replace: true });
    };
    window.addEventListener('koda:unauthenticated', onUnauth);
    return () => window.removeEventListener('koda:unauthenticated', onUnauth);
  }, [nav, loc, qc]);
  useEffect(() => {
    if (q.error instanceof ApiError && q.error.status === 401) {
      nav(`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`, { replace: true });
    }
  }, [q.error, nav, loc]);
  if (q.isPending) return <>{fallback}</>;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 401) return <>{fallback}</>;
    return (
      <div className="center-screen" role="alert">
        <h1>대시보드를 불러오지 못했습니다</h1>
        <p>{(q.error as Error).message}</p>
        <button className="btn btn-primary" onClick={() => q.refetch()}>다시 시도</button>
      </div>
    );
  }
  return <Ctx.Provider value={q.data}>{children}</Ctx.Provider>;
}