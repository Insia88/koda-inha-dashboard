import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconHome, IconWallet, IconListDetails, IconChecklist, IconStack2, IconBuildingBank, IconAddressBook, IconCoins,
  IconUsers, IconShieldCheck, IconNews, IconLogout, IconMenu2, IconX, IconFlask,
} from '@tabler/icons-react';
import { api } from '../api.ts';
import { useMe } from '../auth.tsx';

interface Item { to: string; label: string; icon: typeof IconHome; perm: string; badge?: number; end?: boolean }

export function Layout() {
  const me = useMe();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const firstRender = useRef(true);
  const can = (p: string) => me.permissions.includes(p);
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/api/dashboard'), enabled: can('dashboard.read'), refetchInterval: 15_000 });
  const taskCount = (k: string) => dash.data?.tasks.find((t: any) => t.kind === k)?.count ?? 0;

  useEffect(() => {
    setOpen(false);
    // 첫 화면에서는 포커스를 옮기지 않아 '본문으로 건너뛰기'가 첫 Tab 대상이 되게 하고, 이후 화면 전환 때만 제목으로 옮긴다.
    if (firstRender.current) { firstRender.current = false; return; }
    const h = document.getElementById('page-title');
    if (h) h.focus({ preventScroll: false });
  }, [loc.pathname]);

  const groups: { title?: string; items: Item[] }[] = [
    { items: [{ to: '/', label: '홈', icon: IconHome, perm: 'dashboard.read', end: true }] },
    { title: '자산', items: [
      { to: '/balances', label: '잔고', icon: IconWallet, perm: 'asset.read' },
      { to: '/activity', label: '자산 활동 내역', icon: IconListDetails, perm: 'activity.read' },
    ] },
    { title: '업무', items: [
      { to: '/requests', label: '결재 및 요청', icon: IconChecklist, perm: 'request.read', badge: taskCount('approve_requests') + taskCount('my_drafts') },
      { to: '/addresses', label: '주소록 관리', icon: IconAddressBook, perm: 'address.read', badge: taskCount('review_addresses') },
      { to: '/staking', label: '스테이킹', icon: IconStack2, perm: 'staking.read' },
      { to: '/wallets', label: '지갑 관리', icon: IconBuildingBank, perm: 'wallet.read' },
      { to: '/tokens', label: '토큰 목록', icon: IconCoins, perm: 'catalog.read' },
    ] },
    { title: '관리', items: [
      { to: '/org', label: '조직 관리', icon: IconUsers, perm: 'org.read' },
      { to: '/audit', label: '감사 기록', icon: IconShieldCheck, perm: 'audit.read' },
    ] },
    { title: '정보', items: [
      { to: '/insights', label: '마켓 인사이트', icon: IconNews, perm: 'insight.read' },
      { to: '/insights/manage', label: '인사이트 자료 관리', icon: IconNews, perm: 'insight.manage' },
    ] },
  ];

  const logout = async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } finally {
      qc.clear();
      nav('/login', { replace: true });
    }
  };

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <a href="#main" className="skip-link">본문으로 건너뛰기</a>
      <div className="env-ribbon" role="note">
        <IconFlask size={16} aria-hidden="true" />
        <span><b>개발 환경</b> · 개발용 로그인 · 모의 데이터 · {me.environment.custody} — 실제 자산 전송이나 운영 인증이 일어나지 않습니다.</span>
      </div>
      <header className="topbar">
        <button className="btn btn-icon nav-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="sidenav" aria-label={open ? '메뉴 닫기' : '메뉴 열기'}>
          {open ? <IconX size={20} aria-hidden="true" /> : <IconMenu2 size={20} aria-hidden="true" />}
        </button>
        <img src="/koda-logo.svg" alt="KODA" className="logo" width={117} height={26} />
        <span className="org-name" title={me.org.name}>{me.org.name}{me.org.isMock && <span className="mock-tag">모의</span>}</span>
        <div className="topbar-user">
          <span className="user-name">{me.user.name}</span>
          <span className="user-roles">{me.roleLabels.join(' · ')}</span>
          <button className="btn btn-ghost" onClick={logout}><IconLogout size={16} aria-hidden="true" />로그아웃</button>
        </div>
      </header>
      <nav id="sidenav" className="sidenav" aria-label="주 메뉴">
        {groups.map((g, gi) => {
          const items = g.items.filter((i) => can(i.perm));
          if (!items.length) return null;
          return (
            <div key={gi} className="nav-group">
              {g.title && <div className="nav-title">{g.title}</div>}
              <ul>
                {items.map((i) => (
                  <li key={i.to}>
                    <NavLink to={i.to} end={i.end ?? i.to === '/insights'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                      <i.icon size={18} aria-hidden="true" />
                      <span>{i.label}</span>
                      {i.badge ? <span className="nav-badge" aria-label={`처리할 일 ${i.badge}건`}>{i.badge}</span> : null}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="nav-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
      <main id="main" className="main">
        <Outlet />
      </main>
    </div>
  );
}