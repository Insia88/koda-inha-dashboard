import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconHome, IconWallet, IconListDetails, IconChecklist, IconStack2, IconBuildingBank, IconAddressBook, IconCoins,
  IconUsers, IconShieldCheck, IconNews, IconLogout, IconMenu2, IconX, IconFlask, IconPlus,
} from '@tabler/icons-react';
import { acknowledgeDemoSwitch, api, DEMO_INSTANCE_CHANGED, isDemoSwitchPending } from '../api.ts';
import { useMe } from '../auth.tsx';
import { Notice } from './ui.tsx';
import { DemoFooter } from './DemoFooter.tsx';
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
/** 메뉴가 서랍(겹쳐 여는 메뉴)이 되는 폭. styles.css의 860px 미디어 쿼리와 같다. */
const DRAWER = '(max-width: 860px)';
function useMedia(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
const useNarrow = () => useMedia(NARROW);

/**
 * 메뉴 서랍이 열려 있는 동안 inert로 둘 곳(A3): 건너뛰기 링크, 환경 띠(로컬 실행), 머리글에서 토글을 뺀 나머지, 본문,
 * 공개 데모의 화면 맨 아래 한 줄(A5, 서랍 밖에 있다).
 * 서랍과 머리글의 토글(「메뉴 닫기」)만 남아 Tab이 그 안에서만 돌고, 화면 낭독기도 서랍 뒤 본문과 아래 한 줄을 읽지 않는다.
 * React가 다루지 않는 속성이라 직접 붙이고 뗀다(화면을 옮길 때 제목으로 포커스를 옮기기 전에 바로 뗄 수 있게).
 */
const OUTSIDE_DRAWER = '.skip-link, .env-ribbon, .topbar > :not(.nav-toggle), #main, .demo-footer';
function setOutsideDrawerInert(root: HTMLElement | null, on: boolean) {
  root?.querySelectorAll(OUTSIDE_DRAWER).forEach((el) => el.toggleAttribute('inert', on));
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

/**
 * 공개 데모에서만 보이는 '데모 사용자 전환' 메뉴(A7). 진행자가 로그아웃 없이 역할을 바꿔 시연할 수 있게 한다.
 * 로컬 실행에는 보이지 않고, 공개 데모의 세션은 그대로 둔 채 dev-login만 다시 호출한 뒤 홈으로 새로 고친다.
 */
function useDemoUsers(enabled: boolean) {
  return useQuery({
    queryKey: ['demo-users'],
    queryFn: () => api<{ id: string; name: string; title: string }[]>('/api/auth/dev-users'),
    enabled,
    staleTime: 60_000,
  });
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

/**
 * 로컬 실행(개발 환경)의 상단 띠. DESIGN.md '고지·환경 표시'에 따라 운영 연동 전에는 없애지 않는다.
 * 공개 데모는 이 띠 대신 화면 맨 아래 작은 한 줄(DemoFooter)만 쓴다(A5, DEC-004).
 */
function EnvRibbon({ custody }: { custody: string }) {
  const narrow = useNarrow();
  // 좁은 화면에서는 네 가지 고지(개발 환경·개발용 로그인·모의 데이터·모의 커스터디)를 남기고 뒤 문장만 줄인다.
  if (narrow) return <span><b>개발 환경</b> · 개발용 로그인 · 모의 데이터 · {custody}</span>;
  return <span><b>개발 환경</b> · 개발용 로그인 · 모의 데이터 · {custody} — 실제 자산 전송이나 운영 인증이 일어나지 않습니다.</span>;
}

export function Layout() {
  const me = useMe();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const drawerMode = useMedia(DRAWER);
  // 좁은 화면에서 메뉴가 열려 있으면 서랍을 대화상자처럼 다룬다(A3): 포커스를 서랍으로, 나머지는 inert, Escape로 닫기.
  const drawer = open && drawerMode;
  const [navTop, setNavTop] = useState(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [demoSwitch, acknowledgeSwitch] = useDemoSwitch();
  const env = me.environment;
  const demo = env.mode === 'public-demo';
  const demoUsers = useDemoUsers(demo);
  const [switching, setSwitching] = useState<string | null>(null);
  // 데모 진행자용: 로그아웃 없이 다른 역할로 바꾼다(공개 데모에서만 렌더). 공개 데모 세션은 서명 쿠키라 사용자만 바꾸면 된다.
  const switchUser = async (id: string) => {
    if (!demo || switching) return;
    setSwitching(id);
    try {
      await api('/api/auth/dev-login', { method: 'POST', body: { userId: id } });
      window.location.assign('/');
    } catch {
      setSwitching(null);
    }
  };
  const lastPath = useRef<string | null>(null);
  const startOver = useRef(false);
  const can = (p: string) => me.permissions.includes(p);
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/api/dashboard'), enabled: can('dashboard.read'), refetchInterval: 15_000 });
  const taskCount = (k: string) => dash.data?.tasks.find((t: any) => t.kind === k)?.count ?? 0;
  // 메뉴 배지는 내가 바로 처리할 수 있는 일만 종류별로 센다(A1): 승인할 요청(승인자) '승인 n', 제출 전 내 요청(요청자, 작성 중+검토 중) '제출 전 n', 확인할 주소 '확인 n'.
  // 검토 중 요청은 '초안'이 아니므로 탭('내가 작성한 요청 · 제출 전 n')·홈 할 일('제출 전 내 요청')과 같은 말을 쓴다.
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
    // 서랍이 열린 채 화면이 바뀌었으면 inert가 아직 붙어 있어 제목이 포커스를 받지 못한다. 닫는 렌더를 기다리지 않고 바로 뗀다.
    setOutsideDrawerInert(shellRef.current, false);
    return focusTitleWhenReady();
  }, [loc.pathname]);

  // 메뉴 서랍(A3). 닫을 때 returnFocus면 포커스를 토글로 돌려준다(Escape·막·메뉴 링크). 메뉴 링크로 다른 화면에 가면 그 뒤 새 화면 제목이 받는다.
  const closeNav = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) toggleRef.current?.focus();
  }, []);

  // 넓은 화면이 되면 서랍 상태를 남기지 않는다(다시 좁아졌을 때 저절로 열리지 않게).
  useEffect(() => { if (!drawerMode) setOpen(false); }, [drawerMode]);

  // 열려 있는 동안: 서랍은 머리글 아래 끝에서 시작하고(토글이 가리지 않음), 서랍 밖은 inert.
  useLayoutEffect(() => {
    if (!drawer) return;
    const shell = shellRef.current;
    const measure = () => setNavTop(Math.max(0, Math.round(headerRef.current?.getBoundingClientRect().bottom ?? 0)));
    measure();
    setOutsideDrawerInert(shell, true);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
      setOutsideDrawerInert(shell, false);
    };
  }, [drawer]);

  // 열면 포커스를 서랍의 첫 메뉴로 옮긴다. Tab·Shift+Tab은 토글과 메뉴 사이에서 돌고, Escape는 닫고 토글로 돌아온다.
  useEffect(() => {
    if (!drawer) return;
    navRef.current?.querySelector<HTMLElement>('a[href]')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeNav(true);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [toggleRef.current, ...(navRef.current?.querySelectorAll<HTMLElement>('a[href]') ?? [])].filter((x): x is HTMLElement => !!x);
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (!firstItem || !lastItem) return;
      const at = document.activeElement;
      if (!items.includes(at as HTMLElement)) { e.preventDefault(); (e.shiftKey ? lastItem : firstItem).focus(); }
      else if (e.shiftKey && at === firstItem) { e.preventDefault(); lastItem.focus(); }
      else if (!e.shiftKey && at === lastItem) { e.preventDefault(); firstItem.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer, closeNav]);

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
        { text: `제출 전 ${draftN}`, spoken: `제출 전 내 요청 ${draftN}건`, count: draftN },
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
    <div ref={shellRef} className={`shell ${open ? 'nav-open' : ''}`} style={{ '--nav-top': `${navTop}px` } as CSSProperties}>
      <a href="#main" className="skip-link">본문으로 건너뛰기</a>
      {/* 상단 환경 띠는 로컬 실행에만 둔다. 공개 데모는 띠 없이 맨 아래 한 줄(DemoFooter)만 둔다(A5, DEC-004). */}
      {!demo && (
        <div className="env-ribbon" role="note">
          <IconFlask size={16} aria-hidden="true" />
          <EnvRibbon custody={env.custody} />
        </div>
      )}
      <header ref={headerRef} className="topbar">
        <button ref={toggleRef} className="btn btn-icon nav-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="sidenav" aria-label={open ? '메뉴 닫기' : '메뉴 열기'}>
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
          {demo && (
            <details className="demo-switcher">
              <summary className="btn btn-ghost btn-sm demo-switcher-toggle">데모 사용자 전환</summary>
              <div className="demo-switcher-menu" role="group" aria-label="데모 사용자 선택">
                <p className="small muted">로그아웃 없이 역할만 바꿉니다. 화면 데이터는 홈에서 새로 불러옵니다.</p>
                {demoUsers.data?.map((u) => (
                  <button key={u.id} className="btn btn-ghost demo-switcher-item" onClick={() => void switchUser(u.id)} disabled={switching !== null} aria-busy={switching === u.id}>
                    {u.name} <span className="muted">· {u.title}</span>
                  </button>
                ))}
                {demoUsers.isPending && <span className="small muted">사용자 목록을 불러오는 중…</span>}
                {demoUsers.error && <span className="small muted">사용자 목록을 불러오지 못했습니다. 로그아웃 후 다시 들어와 주세요.</span>}
              </div>
            </details>
          )}
          <span className="user-name">{me.user.name}</span>
          <span className="user-roles">{me.roleLabels.join(' · ')}</span>
          <button className="btn btn-ghost btn-logout" onClick={logout}><IconLogout size={16} aria-hidden="true" /><span className="btn-logout-text">로그아웃</span></button>
        </div>
        {/* 공개 데모에서만: 좁은 화면에서도 지금 누구로 보고 있는지 탑바 안 둘째 줄로 보인다(A8). */}
        {demo && <div className="mobile-account" aria-label="현재 사용자"><span>{me.user.name}</span><span className="mobile-account-role">{me.roleLabels.join(' · ')}</span></div>}
      </header>
      <nav ref={navRef} id="sidenav" className="sidenav" aria-label="주 메뉴">
        {/* 좁은 화면에서도 지금 누구로 보고 있는지 알 수 있게 서랍 맨 위에 사용자와 데모 전환을 둔다(A7). */}
        <div className="nav-user">
          <span className="nav-user-name">{me.user.name}</span>
          <span className="nav-user-roles">{me.roleLabels.join(' · ')}</span>
          {demo && (
            <details className="demo-switcher nav-demo-switcher">
              <summary className="btn btn-ghost btn-sm demo-switcher-toggle">데모 사용자 전환</summary>
              <div className="demo-switcher-menu nav-demo-switcher-menu" role="group" aria-label="데모 사용자 선택">
                {demoUsers.data?.map((u) => (
                  <button key={u.id} className="btn btn-ghost demo-switcher-item" onClick={() => void switchUser(u.id)} disabled={switching !== null} aria-busy={switching === u.id}>
                    {u.name} <span className="muted">· {u.title}</span>
                  </button>
                ))}
                {demoUsers.isPending && <span className="small muted">사용자 목록을 불러오는 중…</span>}
              </div>
            </details>
          )}
        </div>
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
                      {/* 서랍에서 고르면 닫고, 화면을 옮기기 전에 포커스를 먼저 토글로 돌려준다(A3 검토). 화면이 바뀌면 위 경로 효과가 새 화면 제목으로 옮기고,
                          같은 경로이거나 작성 중인 화면의 이탈 확인에서 「계속 작성」을 고르면 토글에 남는다(확인 대화상자는 토글을 돌아갈 곳으로 기억한다).
                          닫힌 서랍(visibility: hidden) 안의 링크에 포커스가 남아 있다가 문서 맨 앞으로 떨어지지 않게 한다. */}
                      <NavLink to={i.to} end={i.end ?? i.to === '/insights'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} onClick={() => { if (drawer) closeNav(true); }}>
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
      <div className="nav-scrim" onClick={() => closeNav(true)} aria-hidden="true" />
      <main id="main" className="main">
        {/* 공개 데모에서만: 미리 있는 알림 영역에 내용을 넣어야 화면 낭독기가 변경을 읽어 준다. 로컬 화면 구조는 그대로 둔다. */}
        {demo && (
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
      {/* 공개 데모: 모든 화면 맨 아래 작은 한 줄(A5). 알림 영역 밖이고, 서랍이 열려 있는 동안에는 inert다(OUTSIDE_DRAWER). */}
      {demo && <DemoFooter />}
    </div>
  );
}