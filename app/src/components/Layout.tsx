import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconHome, IconWallet, IconListDetails, IconChecklist, IconStack2, IconBuildingBank, IconAddressBook, IconCoins,
  IconUsers, IconShieldCheck, IconNews, IconLogout, IconMenu2, IconX, IconFlask, IconPlus,
} from '@tabler/icons-react';
import { acknowledgeDemoSwitch, api, DEMO_INSTANCE_CHANGED, isDemoSwitchPending } from '../api.ts';
import { useMe, type Me } from '../auth.tsx';
import { dateTime } from '../format.ts';
import { Notice } from './ui.tsx';
import './layout-demo.css';

/** 메뉴 배지 하나: 눈에 보이는 짧은 글자(예: '승인 2')와 화면 낭독기가 읽는 조각(예: '승인할 요청 2건'). */
interface NavBadge { text: string; spoken: string; count: number }
interface Item { to: string; label: string; icon: typeof IconHome; perm: string; badges?: NavBadge[]; end?: boolean }

/**
 * 0건인 배지는 빼고 남은 배지의 건수를 더해 '처리할 일 3건: 승인할 요청 2건, 제출 전 내 요청 1건'처럼 읽힐 문장을 만든다.
 * 보이는 배지(aria-hidden)는 종류마다 따로 두고, 링크 이름에는 이 문장 하나만 들어간다.
 */
function badgeSpeech(badges: NavBadge[] | undefined): string | null {
  const shown = (badges ?? []).filter((b) => b.count > 0);
  if (!shown.length) return null;
  const total = shown.reduce((sum, b) => sum + b.count, 0);
  return `처리할 일 ${total}건: ${shown.map((b) => b.spoken).join(', ')}`;
}

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

/**
 * 공개 데모에서 다른 서버 인스턴스가 응답하기 시작했는지(아직 닫지 않은 안내가 있는지).
 * 로그인은 그대로 유지된다. 데이터는 인스턴스마다 따로라 방금 만든 항목이 보이지 않을 수 있다는 것만 알린다.
 */
export function useDemoSwitch(): [boolean, () => void] {
  const [pending, setPending] = useState(isDemoSwitchPending);
  useEffect(() => {
    const on = () => setPending(true);
    window.addEventListener(DEMO_INSTANCE_CHANGED, on);
    if (isDemoSwitchPending()) setPending(true);
    return () => window.removeEventListener(DEMO_INSTANCE_CHANGED, on);
  }, []);
  const acknowledge = useCallback(() => { acknowledgeDemoSwitch(); setPending(false); }, []);
  return [pending, acknowledge];
}

/** 안내를 닫아 버튼이 사라진 뒤 포커스가 문서 맨 앞으로 떨어지지 않도록 화면 제목으로 옮긴다. */
const focusPageTitle = () => requestAnimationFrame(() => document.getElementById('page-title')?.focus({ preventScroll: true }));

/** 화면 제목이 늦게 나타날 때 기다리는 최대 시간. 이보다 늦으면 포커스를 옮기지 않는다. */
const TITLE_WAIT_MS = 10_000;

/**
 * 화면을 옮긴 뒤 새 화면의 제목(#page-title)으로 포커스를 옮긴다.
 * 상세 화면은 먼저 '불러오는 중'을 보이고 조회가 끝난 뒤에 제목을 그린다. 그 사이 누른 링크는 사라져 포커스가
 * 문서 맨 앞(body)으로 떨어지므로, 제목이 아직 없으면 본문(main)을 지켜보다가 제목이 생기는 순간 옮긴다.
 * 기다리는 동안 사용자가 다른 곳으로 포커스를 옮겼으면(focusin) 건드리지 않는다. 다음 화면 이동이나 제한 시간이 지나면 그만 지켜본다.
 * 돌려준 함수는 지켜보기를 멈춘다.
 */
function focusTitleWhenReady(): () => void {
  const now = document.getElementById('page-title');
  if (now) { now.focus({ preventScroll: false }); return () => {}; }
  const main = document.getElementById('main');
  if (!main) return () => {};
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    document.removeEventListener('focusin', stop, true);
    window.clearTimeout(timer);
  };
  const observer = new MutationObserver(() => {
    const h = document.getElementById('page-title');
    if (!h) return;
    stop();
    h.focus({ preventScroll: false });
  });
  observer.observe(main, { childList: true, subtree: true });
  document.addEventListener('focusin', stop, true);
  const timer = window.setTimeout(stop, TITLE_WAIT_MS);
  return stop;
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
  const [demoSwitch, acknowledgeSwitch] = useDemoSwitch();
  const env = me.environment;
  const lastPath = useRef<string | null>(null);
  const startOver = useRef(false);
  const can = (p: string) => me.permissions.includes(p);
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/api/dashboard'), enabled: can('dashboard.read'), refetchInterval: 15_000 });
  const taskCount = (k: string) => dash.data?.tasks.find((t: any) => t.kind === k)?.count ?? 0;
  // 메뉴 배지는 내가 바로 처리할 수 있는 일만 종류별로 센다(A1): 승인할 요청(승인자) '승인 n', 제출 전 내 요청(요청자) '초안 n', 확인할 주소 '확인 n'.
  // 받는 주소가 사용 중지되어 승인할 수 없는 요청은 홈의 별도 위험 항목으로 보여 주고 배지에는 더하지 않는다(A-17).
  const approveN = taskCount('approve_requests');
  const draftN = taskCount('my_drafts');
  const reviewN = taskCount('review_addresses');
  // 요청 권한이 있으면 어느 화면에서나 머리글에서 출금 요청 작성으로 갈 수 있다(작성 화면 자체에는 두지 않는다).
  const showSend = can('request.create') && loc.pathname !== '/requests/new';

  useEffect(() => {
    setOpen(false);
    // 첫 화면에서는 포커스를 옮기지 않아 '본문으로 건너뛰기'가 첫 Tab 대상이 되게 하고, 이후 화면 전환 때만 제목으로 옮긴다.
    // 경로로 비교하므로 개발 모드(StrictMode)에서 효과가 두 번 실행돼도 첫 화면을 화면 전환으로 보지 않는다.
    const first = lastPath.current === null;
    const same = lastPath.current === loc.pathname;
    lastPath.current = loc.pathname;
    if (first || same) return;
    return focusTitleWhenReady();
  }, [loc.pathname]);

  // 「처음 화면으로」는 홈에 실제로 도착한 뒤에만 조회 결과를 비운다. 작성 중인 화면에서 이동 확인을 받고
  // 「계속 작성」을 고르면 아무것도 비우지 않아 입력이 그대로 남는다. 로그인 정보(me)는 비우지 않고 다시 확인만 한다.
  useEffect(() => {
    if (!startOver.current) return;
    startOver.current = false;
    if (loc.pathname !== '/') return;
    void qc.resetQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    void qc.invalidateQueries({ queryKey: ['me'] });
  }, [loc, qc]);

  // 메뉴 이름은 방향과 쓰임을 말한다(A1): 보낼 곳(주소록)과 우리 회사 입금 주소를 구분하고, 조회만 하는 화면은 '참고'로 묶는다. 경로·권한은 그대로다.
  const groups: { title?: string; items: Item[] }[] = [
    { items: [{ to: '/', label: '홈', icon: IconHome, perm: 'dashboard.read', end: true }] },
    { title: '업무', items: [
      { to: '/requests', label: '결재 및 요청', icon: IconChecklist, perm: 'request.read', badges: [
        { text: `승인 ${approveN}`, spoken: `승인할 요청 ${approveN}건`, count: approveN },
        { text: `초안 ${draftN}`, spoken: `제출 전 내 요청 ${draftN}건`, count: draftN },
      ] },
      { to: '/addresses', label: '보낼 곳 주소록', icon: IconAddressBook, perm: 'address.read', badges: [
        { text: `확인 ${reviewN}`, spoken: `확인할 주소 ${reviewN}건`, count: reviewN },
      ] },
    ] },
    { title: '자산', items: [
      { to: '/balances', label: '잔고', icon: IconWallet, perm: 'asset.read' },
      { to: '/activity', label: '자산 활동 내역', icon: IconListDetails, perm: 'activity.read' },
    ] },
    { title: '참고', items: [
      { to: '/wallets', label: '우리 회사 입금 주소', icon: IconBuildingBank, perm: 'wallet.read' },
      { to: '/staking', label: '스테이킹 현황', icon: IconStack2, perm: 'staking.read' },
      { to: '/tokens', label: '지원 자산·네트워크', icon: IconCoins, perm: 'catalog.read' },
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

  const dismissDemoSwitch = () => {
    acknowledgeSwitch();
    focusPageTitle();
  };

  // 로그아웃하지 않는다. 이전 서버에서 받아 둔 화면 데이터만 버리고 홈에서 지금 서버의 데이터를 다시 불러온다.
  const goStartScreen = () => {
    acknowledgeSwitch();
    startOver.current = true;
    nav('/', { replace: loc.pathname === '/' });
    focusPageTitle();
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
        {/* 이동만 한다(미리 채우는 값 없음). 권한 검사는 화면 경로(g('request.create'))와 서버가 그대로 한다. 작성 중인 화면에서 누르면 이탈 확인을 거친다.
            좁은 화면(≤560px)에서는 '출금 요청'만 보이고, 아주 좁으면(<380px) 아이콘만 보인다. 이름은 어느 폭에서나 '출금 요청 작성'이다. */}
        {showSend && (
          <Link className="btn btn-primary btn-sm topbar-send" to="/requests/new" title="출금 요청 작성">
            <IconPlus size={16} aria-hidden="true" />
            <span className="topbar-send-text">출금 요청<span className="topbar-send-more"> 작성</span></span>
          </Link>
        )}
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
                {items.map((i) => {
                  const speech = badgeSpeech(i.badges);
                  const shown = (i.badges ?? []).filter((b) => b.count > 0);
                  return (
                    <li key={i.to}>
                      <NavLink to={i.to} end={i.end ?? i.to === '/insights'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
                        <i.icon size={18} aria-hidden="true" />
                        <span className="nav-label">{i.label}</span>
                        {speech && (
                          <span className="nav-badges">
                            {shown.map((b) => <span key={b.text} className="nav-badge" aria-hidden="true">{b.text}</span>)}
                            <span className="sr-only">{speech}</span>
                          </span>
                        )}
                      </NavLink>
                    </li>
                  );
                })}
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
            {demoSwitch && (
              <div className="demo-switch">
                <Notice tone="info">
                  <strong>다른 데모 서버로 연결되었습니다.</strong> 로그인은 유지되지만, 방금 만든 요청·주소가 이 서버에는 없을 수 있습니다. 모든 데이터는 모의 데이터입니다.
                  <div className="demo-switch-actions">
                    <button type="button" className="btn btn-sm" onClick={dismissDemoSwitch}>닫기</button>
                    <button type="button" className="btn btn-sm" onClick={goStartScreen}>처음 화면으로</button>
                  </div>
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