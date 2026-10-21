import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { acknowledgeDemoSwitch, api, type HealthInfo } from '../api.ts';
import { ApiErrorNotice, Loading, Notice, ErrorState, useDocumentTitle } from '../components/ui.tsx';
import { DemoFooter } from '../components/DemoFooter.tsx';
import { ROLE_LABEL, type Role } from '../../shared/terms.ts';

interface DevUser { id: string; name: string; title: string; org_name: string; org_id: string; roles: Role[] }

export function LoginPage() {
  const [sp] = useSearchParams();
  useDocumentTitle('로그인');
  const nav = useNavigate();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['dev-users'], queryFn: () => api<DevUser[]>('/api/auth/dev-users') });
  const health = useQuery({ queryKey: ['healthz'], queryFn: () => api<HealthInfo>('/api/healthz'), staleTime: 60_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const next = sp.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const isDemo = health.data?.mode === 'public-demo';

  const login = async (id: string) => {
    setBusy(id); setErr(null);
    try {
      await api('/api/auth/dev-login', { method: 'POST', body: { userId: id } });
      // 로그인 화면을 불러오는 동안 다른 데모 서버가 응답했더라도, 아직 만든 항목이 없으니 들어간 뒤 안내하지 않는다.
      acknowledgeDemoSwitch();
      qc.clear();
      nav(safeNext, { replace: true });
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };

  const orgs = new Map<string, DevUser[]>();
  for (const u of users.data ?? []) orgs.set(u.org_name, [...(orgs.get(u.org_name) ?? []), u]);

  return (
    <div className="login">
      {/* 로그인 카드가 이 화면의 본문(main 랜드마크)이다. 공개 데모의 맨 아래 한 줄(contentinfo)은 그 밖의 형제로 둔다(A5 검토). */}
      <main className="login-card">
        <img src="/koda-logo.svg" alt="KODA" width={140} height={31} />
        <h1 id="page-title" tabIndex={-1}>법인 대시보드 로그인</h1>
        {/* 실행 형태를 확인한 뒤 한 번만 그린다(공개 데모에서 개발 환경 문구가 잠깐 보였다 사라지지 않게).
            공개 데모는 안내 상자 없이 화면 맨 아래 한 줄(DemoFooter)만 둔다(A5, DEC-004). 로컬 실행의 개발용 로그인 안내는 그대로다. */}
        {!health.isPending && !isDemo && (
          <Notice tone="warning" title="개발용 로그인입니다">
            비밀번호 없이 모의 사용자를 골라 들어갑니다. 실제 KODA 계정·SSO 인증이 아니며, 모든 사람·법인·자산·주소는 모의 데이터입니다.
          </Notice>
        )}
        {/* 공개 데모에서도 다른 서버로 연결되는 것만으로는 로그아웃되지 않으므로, 여기서는 세션 만료만 알린다. */}
        {sp.get('reason') === 'expired' && <Notice tone="info" role="status">세션이 만료되어 로그아웃되었습니다. 다시 로그인하면 보던 화면으로 돌아갑니다.</Notice>}
        <ApiErrorNotice error={err} />
        {users.isPending && <Loading />}
        {users.error && <ErrorState error={users.error} onRetry={() => users.refetch()} />}
        {[...orgs.entries()].map(([org, list]) => (
          <section key={org} className="login-org" aria-labelledby={`org-${list[0]!.org_id}`}>
            <h2 id={`org-${list[0]!.org_id}`}>{org}</h2>
            <ul className="login-users">
              {list.map((u) => (
                <li key={u.id}>
                  <button className="login-user" onClick={() => login(u.id)} disabled={busy !== null} aria-busy={busy === u.id}>
                    <span className="login-user-name">{u.name}<span className="muted"> · {u.title}</span></span>
                    <span className="login-user-roles">{u.roles.map((r) => ROLE_LABEL[r].label).join(', ')}</span>
                    <span className="login-user-desc">{u.roles.map((r) => ROLE_LABEL[r].description).join(' ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </main>
      {/* 공개 데모: 화면 맨 아래 작은 한 줄(A5). 로컬 로그인 화면에는 없다(위 '개발용 로그인입니다' 안내를 쓴다). */}
      {isDemo && <DemoFooter />}
    </div>
  );
}