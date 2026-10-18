import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { ApiErrorNotice, Loading, Notice, ErrorState } from '../components/ui.tsx';
import { ROLE_LABEL, type Role } from '../../shared/terms.ts';

interface DevUser { id: string; name: string; title: string; org_name: string; org_id: string; roles: Role[] }

export function LoginPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['dev-users'], queryFn: () => api<DevUser[]>('/api/auth/dev-users') });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const next = sp.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';

  const login = async (id: string) => {
    setBusy(id); setErr(null);
    try {
      await api('/api/auth/dev-login', { method: 'POST', body: { userId: id } });
      qc.clear();
      nav(safeNext, { replace: true });
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };

  const orgs = new Map<string, DevUser[]>();
  for (const u of users.data ?? []) orgs.set(u.org_name, [...(orgs.get(u.org_name) ?? []), u]);

  return (
    <div className="login">
      <div className="login-card">
        <img src="/koda-logo.svg" alt="KODA" width={140} height={31} />
        <h1 id="page-title" tabIndex={-1}>법인 대시보드 로그인</h1>
        <Notice tone="warning" title="개발용 로그인입니다">
          비밀번호 없이 모의 사용자를 골라 들어갑니다. 실제 KODA 계정·SSO 인증이 아니며, 모든 사람·법인·자산·주소는 모의 데이터입니다.
        </Notice>
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
      </div>
    </div>
  );
}