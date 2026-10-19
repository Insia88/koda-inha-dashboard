import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconHome, IconWallet, IconListDetails, IconChecklist, IconStack2, IconBuildingBank, IconAddressBook, IconCoins,
  IconUsers, IconShieldCheck, IconNews, IconLogout, IconMenu2, IconX, IconFlask,
} from '@tabler/icons-react';
import { acknowledgeDemoReset, api, DEMO_INSTANCE_CHANGED, isDemoResetPending } from '../api.ts';
import { useMe, type Me } from '../auth.tsx';
import { dateTime } from '../format.ts';
import { Notice } from './ui.tsx';

interface Item { to: string; label: string; icon: typeof IconHome; perm: string; badge?: number; end?: boolean }

const NARROW = '(max-width: 560px)';
function useNarrow() {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(NARROW);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

/** 데이터 생성 시각(KST HH:mm). */
const seededTime = (seededAt?: string | null) => (seededAt ? dateTime(seededAt).slice(11) : null);

/** 공개 데모 고지 본문. 상단 띠와 로그인 화면이 같은 내용을 쓴다. */
export function DemoNoticeText({ seededAt }: { seededAt?: string | null }) {
  const t = seededTime(seededAt);
  return <>모든 사람·법인·자산·주소는 모의 데이터입니다. KODA 공식 서비스가 아니며 실제 계정·자산과 연결되지 않습니다. 서버가 다시 시작되면 데이터가 초기화됩니다{t ? ` (데이터 생성 ${t})` : ''}.</>;
}

/** 공개 데모 서버가 바뀌어(재시작·다른 인스턴스) 모의 데이터가 처음 상태로 돌아갔는지. */
export function useDemoReset(): [boolean, () => void] {
  const [pending, setPending] = useState(isDemoResetPending);
  useEffect(() => {
    const on = () => setPending(true);
    window.addEventListener(DEMO_INSTANCE_CHANGED, on);
    if (isDemoResetPending()) setPending(true);
    return () => window.removeEventListener(DEMO_INSTANCE_CHANGED, on);
  }, []);
  const acknowledge = useCallback(() => { acknowledgeDemoReset(); setPending(false); }, []);
  return [pending, acknowledge];
}

function EnvRibbon({ env }: { env: Me['environment'] }) {
  const narrow = useNarrow();
  if (env.mode !== 'public-demo') {
    // 좁은 화면에서는 네 가지 고지(개발 환경·개발용 로그인·모의 데이터·모의 커스터디)를 남기고 뒤 문장만 줄인다.
    if (narrow) return <span><b>개발 환경</b> · 개발용 로그인 · 모의 데이터 · {env.custody}</span>;
    return <span><b>개발 환경</b> · 개발용 로그인 · 모의 데이터 · {env.custody} — 실제 자산 전송이나 운영 인증이 일어나지 않습니다.</span>;
  }
  const t = seededTime(env.seededAt);
  // 좁은 화면에서도 네 가지(공개 데모·모의 데이터·KODA 공식 서비스 아님·초기화)는 빠뜨리지 않는다.
  if (narrow) return <span><b>공개 데모</b> · 모의 데이터 · KODA 공식 서비스가 아닙니다 · 재시작하면 데이터가 초기화됩니다{t ? ` (${t} 생성)` : ''}</span>;
  return <span><b>공개 데모</b> · 모든 사람·법인·자산·주소는 모의 데이터 · KODA 공식 서비스가 아니며 실제 계정·자산과 연결되지 않습니다 · 서버가 다시 시작되면 데이터가 초기화됩니다{t ? ` (데이터 생성 ${t})` : ''}</span>;
}

export function Layout() {
  const me = useMe();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [demoReset, acknowledgeReset] = useDemoReset();
  const env = me.environment;
  const firstRender = useRef(true);
  const can = (p: string) => me.permissions.includes(p);
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/api/dashboard'), enabled: can('dashboard.read'), refetchInterval: 15_000 });
  const taskCount = (k: string) => dash.data?.tasks.find((t: any) => t.kind === k)?.count ?? 0;
  // 메뉴 배지는 내가 바로 처리할 수 있는 일만 센다: 승인할 요청(승인자)과 제출 전 내 요청(요청자).
  // 받는 주소가 사용 중지되어 승인할 수 없는 요청은 홈의 별도 위험 항목으로 보여 주고 배지에는 더하지 않는다.

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

  const restartDemo = () => {
    acknowledgeReset();
    qc.clear();
    nav('/login', { replace: true });
  };

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <a href="#main" className="skip-link">본문으로 건너뛰기</a>
      <div className="env-ribbon" role="note">
        <IconFlask size={16} aria-hidden="true" />
        <EnvRibbon env={env} />
      </div>
      <header className="topbar">
        <button className="btn btn-icon nav-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="sidenav" aria-label={open ? '메뉴 닫기' : '메뉴 열기'}>
          {open ? <IconX size={20} aria-hidden="true" /> : <IconMenu2 size={20} aria-hidden="true" />}
        </button>
        <img src="/koda-logo.svg" alt="KODA" className="logo" width={117} height={26} />
        <span className="org-name">
          <span className="org-name-text" title={me.org.name}>{me.org.name}</span>
          {me.org.isMock && <span className="mock-tag">모의</span>}
        </span>
        <div className="topbar-user">
          <span className="user-name">{me.user.name}</span>
          <span className="user-roles">{me.roleLabels.join(' · ')}</span>
          <button className="btn btn-ghost btn-logout" onClick={logout}><IconLogout size={16} aria-hidden="true" /><span className="btn-logout-text">로그아웃</span></button>
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
                      {i.badge ? <span className="nav-badge"><span aria-hidden="true">{i.badge}</span><span className="sr-only">처리할 일 {i.badge}건</span></span> : null}
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
        {/* 공개 데모에서만: 미리 있는 알림 영역에 내용을 넣어야 화면 낭독기가 변경을 읽어 준다. 로컬 화면 구조는 그대로 둔다. */}
        {env.mode === 'public-demo' && (
          <div role="status" aria-live="polite">
            {demoReset && (
              <div style={{ marginBottom: 'var(--s4)' }}>
                <Notice tone="info" title="데모 서버가 새로 시작되었습니다">
                  모의 데이터가 처음 상태로 돌아갔습니다. 방금 만든 항목이나 로그인 상태가 남아 있지 않을 수 있습니다.
                  <div style={{ marginTop: 'var(--s2)' }}><button type="button" className="btn btn-sm" onClick={restartDemo}>처음 화면으로</button></div>
                </Notice>
              </div>
            )}
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}