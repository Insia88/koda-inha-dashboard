import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCircleCheck } from '@tabler/icons-react';
import { acknowledgeDemoSwitch, api, type HealthInfo } from '../api.ts';
import { ApiErrorNotice, Loading, Notice, ErrorState, useDocumentTitle } from '../components/ui.tsx';
import { DemoFooter } from '../components/DemoFooter.tsx';
import { ROLE_LABEL, type Role } from '../../shared/terms.ts';
import './login-stage.css';

interface DevUser { id: string; name: string; title: string; org_name: string; org_id: string; roles: Role[] }

// 넓은 화면은 16:9 전체 필름, 좁은 화면(무대가 위쪽 띠일 때)은 4:5 전체 필름을 쓴다. 16:9를 세로 띠에 cover로 넣으면 문장 왼쪽이 잘린다.
// 42.45초 원본을 웹용으로만 줄인 파일(1280×720 1.24MB / 720×900 775KB, 무음, 0.5초 페이드 인·1.0초 페이드 아웃으로 반복 이음새 정리).
const TRAILER_ASSETS = {
  wide: { src: '/brand/koda-brand-film-16x9.mp4', poster: '/brand/koda-brand-film-poster.jpg' },
  narrow: { src: '/brand/koda-brand-film-4x5.mp4', poster: '/brand/koda-brand-film-poster-4x5.jpg' },
} as const;
type TrailerAsset = keyof typeof TRAILER_ASSETS;

/** 무대 폭에 맞는 전체 필름을 고른다(넓은 화면 16:9 · 좁은 화면 4:5). */
function useTrailerAsset(): TrailerAsset {
  const [asset, setAsset] = useState<TrailerAsset>(() => (typeof window !== 'undefined' && window.matchMedia('(min-width: 960px)').matches ? 'wide' : 'narrow'));
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 960px)');
    const update = () => setAsset(mq.matches ? 'wide' : 'narrow');
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return asset;
}

/**
 * 무음 자동재생을 허용할지 정한다. 줄인 움직임(prefers-reduced-motion: reduce)이나 데이터 절약 모드(saveData)에서는 재생하지 않는다.
 * 첫 렌더에서는 false로 두어, 미디어 설정을 확인하기 전에 영상이 먼저 재생되기 시작하지 않게 한다.
 */
function useTrailerMotion(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    const update = () => setAllowed(!mq.matches && connection?.saveData !== true);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return allowed;
}

/**
 * 로그인 무대의 KODA 브랜드 필름 전체(42.45초, 무음). 장식이므로 aria-hidden이고 포커스를 받지 않는다.
 * 재생이 차단되면 포스터가 그대로 보인다. 영상이 준비되면 포스터 위로 부드럽게 나타난다(글자가 아니라 영상에만 투명도 전환).
 */
function LoginTrailer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const motion = useTrailerMotion();
  const asset = useTrailerAsset();
  const { src, poster } = TRAILER_ASSETS[asset];
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!motion) { video.pause(); return; }
    // 자동재생이 막히면(브라우저 설정 등) 포스터가 남는다. 오류는 화면에 알리지 않는다(장식).
    void video.play().catch(() => {});
  }, [motion, asset]);
  return (
    <aside className="login-stage" aria-label="KODA 브랜드 필름">
      <div className="login-stage-inner">
        <div className="login-stage-frame">
          <img className="login-stage-poster" src={poster} alt="" width={1280} height={720} />
      <video
        key={asset}
        ref={videoRef}
        className={`login-stage-video${ready ? ' is-ready' : ''}`}
        src={src}
        poster={poster}
        autoPlay={motion}
        muted
        loop
        playsInline
        preload={motion ? 'auto' : 'none'}
        aria-hidden="true"
        tabIndex={-1}
        disablePictureInPicture
        onCanPlay={() => setReady(true)}
      />
      <div className="login-stage-scrim" />
        </div>
        <p className="login-stage-copy">확인이 쌓여, 신뢰가 됩니다.<span>KODA 브랜드 필름 · 15초 · 무음</span></p>
      </div>
    </aside>
  );
}

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
      <LoginTrailer />
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
        {/* A7(신뢰·직관): 들어오기 전에 이 대시보드가 지키는 안전 장치를 세 줄로 알린다. 구현된 동작만 쓴다. */}
        <section className="login-trust" aria-labelledby="login-trust-h">
          <h2 id="login-trust-h">이 대시보드가 지키는 것</h2>
          <ul>
            <li><IconCircleCheck size={16} aria-hidden="true" /><span>모든 출금은 <b>작성자와 다른 승인자</b>의 승인을 거칩니다.</span></li>
            <li><IconCircleCheck size={16} aria-hidden="true" /><span>새 받는 주소는 확인과 <b>사용 대기</b>를 거친 뒤에만 출금에 쓸 수 있습니다.</span></li>
            <li><IconCircleCheck size={16} aria-hidden="true" /><span>요청·승인·주소·역할 변경은 <b>감사 기록</b>에 남습니다.</span></li>
          </ul>
        </section>
        <p className="login-guide small muted">
          처음이면 <b>한지수</b>(자산 담당자) → <b>오민재</b>(승인자) → <b>문태호</b>(감사 담당자) 순으로 둘러보세요. 역할에 따라 보이는 화면이 다릅니다.
        </p>
        {users.isPending && <Loading />}
        {users.error && <ErrorState error={users.error} onRetry={() => users.refetch()} />}
        {[...orgs.entries()].map(([org, list]) => (
          <section key={org} className="login-org" aria-labelledby={`org-${list[0]!.org_id}`}>
            <h2 id={`org-${list[0]!.org_id}`}>{org}</h2>
            <ul className="login-users">
              {list.map((u) => (
                <li key={u.id}>
                  <button className="login-user" onClick={() => login(u.id)} disabled={busy !== null} aria-busy={busy === u.id}>
                    <span className="login-user-head">
                      <span className="login-user-name">{u.name}<span className="muted"> · {u.title}</span></span>
                      <span className="login-user-roles">{u.roles.map((r) => <span key={r} className="login-user-role">{ROLE_LABEL[r].label}</span>)}</span>
                    </span>
                    <span className="sr-only">{u.roles.map((r) => ROLE_LABEL[r].description).join(' ')}</span>
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
