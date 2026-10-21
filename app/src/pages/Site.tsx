import { useEffect, useRef, useState } from 'react';
import { IconArrowRight, IconChevronDown, IconDownload, IconFileText, IconMenu2, IconMovie, IconVolume, IconVolumeOff, IconX } from '@tabler/icons-react';
import './site.css';

const NAV = [
  { id: 'change', label: '바뀌는 것' },
  { id: 'film', label: '브랜드 필름' },
  { id: 'screens', label: '화면' },
  { id: 'resources', label: '자료' },
  { id: 'contact', label: '도입 안내' },
];

interface ChangeItem { n: string; title: string; body: string; linkLabel: string; linkHref: string; image: string; caption: string }
const CHANGES: ChangeItem[] = [
  {
    n: '01', title: '한 화면에서 확인한다',
    body: '지갑·주소·잔고·평가금액을 한 화면에 모읍니다. 확인 대기 주소, 사용 대기 주소, 내 승인 차례, 진행 중 요청을 홈에서 먼저 보여 주어 담당자가 무엇을 먼저 봐야 하는지 알 수 있습니다.',
    linkLabel: '홈 화면 살펴보기', linkHref: '/login', image: '/site/screens/home.jpg', caption: '홈 · 확인 상태와 보유 자산 요약',
  },
  {
    n: '02', title: '한 번 더 확인하고 승인한다',
    body: '승인자는 요청의 받는 주소·금액·승인 지문을 다시 확인합니다. 정족수와 고액 기준에 따라 필요한 승인 수가 달라지고, 같은 사람이 작성하고 승인할 수는 없습니다.',
    linkLabel: '결정 카드 살펴보기', linkHref: '/login', image: '/site/screens/request-detail.jpg', caption: '요청 상세 · 결정 카드와 안전 확인',
  },
  {
    n: '03', title: '모든 결정을 기록으로 남긴다',
    body: '승인·반려·주소·권한 변경은 추가 전용 감사 기록으로 남습니다. 기록은 해시 체인으로 이어져 중간에 바뀌지 않았는지 확인할 수 있고, 권한이 있는 사람은 CSV로 내보낼 수 있습니다.',
    linkLabel: '감사 기록 살펴보기', linkHref: '/login', image: '/site/screens/audit.jpg', caption: '감사 기록 · 업무 기록 필터와 무결성 확인',
  },
];

const CHAPTERS = [
  { img: '/site/plates/start.jpg', k: '장면 01 · 시작', t: '확인은 작은 점 하나에서 시작됩니다.' },
  { img: '/site/plates/address.jpg', k: '장면 02 · 주소', t: '받는 주소 한 줄도 다시 확인합니다.' },
  { img: '/site/plates/hero.jpg', k: '장면 03 · 지문', t: '승인 대상이 바뀌지 않았는지 지문으로 확인합니다.' },
  { img: '/site/plates/flow.jpg', k: '장면 04 · 흐름', t: '확인에서 승인, 보관까지 이어집니다.' },
  { img: '/site/plates/mark.jpg', k: '장면 05 · 약속', t: '확인이 쌓여 신뢰가 됩니다.' },
  { img: '/site/plates/final.jpg', k: '장면 06 · KODA', t: '법인·기관 투자자를 위한 디지털 자산 파트너.' },
];

interface ScreenItem { img: string; tag: string; title: string; caption: string }
const SCREENS: ScreenItem[] = [
  { img: '/site/screens/home.jpg', tag: '01', title: '홈 · 확인 상태', caption: '오늘 확인할 주소와 승인 차례, 진행 중 요청을 한눈에.' },
  { img: '/site/screens/request-detail.jpg', tag: '02', title: '요청 상세 · 결정 카드', caption: '받는 주소·지문·점검 결과를 다시 확인한 뒤 승인.' },
  { img: '/site/screens/addresses.jpg', tag: '03', title: '주소 관리', caption: '등록·확인·사용 대기 상태를 담당자별로 관리.' },
  { img: '/site/screens/audit.jpg', tag: '04', title: '감사 기록 · 무결성', caption: '추가 전용 기록과 해시 체인 무결성 확인.' },
  { img: '/site/screens/org.jpg', tag: '05', title: '조직 · 권한', caption: '역할과 권한을 나누고 변경 이력을 남김.' },
  { img: '/site/screens/tokens.jpg', tag: '06', title: '토큰 카탈로그', caption: '지원 자산과 네트워크, 모의 시세를 한곳에서.' },
];

const RESOURCES = [
  { href: '/site/koda-dashboard-brief.pdf', type: 'PDF', title: 'KODA 대시보드 소개서', desc: '기능과 신뢰 장치, 데모 화면 6장을 6쪽으로 정리했습니다.', meta: '6쪽 · 1.0MB', icon: 'file' },
  { href: '/site/koda-3min-demo-guide.pdf', type: 'PDF', title: '3분 데모 가이드', desc: '발표 30분 전 체크리스트와 3분 스크립트, 알려진 한계.', meta: '2쪽 · 120KB', icon: 'file' },
  { href: '/brand/koda-brand-film-16x9.mp4', type: 'MP4', title: 'KODA 브랜드 필름', desc: '확인·승인·보관의 흐름을 담은 42초 브랜드 필름.', meta: '42초 · 2.1MB', icon: 'movie' },
];

/** 사이트 전용 문서 머리말. 대시보드 앱과 분리된 공개 페이지라 앱 셸 없이 그린다. */
function useSiteMeta() {
  useEffect(() => {
    document.title = 'KODA | 법인 디지털 자산 대시보드';
    const add = (attr: 'name' | 'property', key: string, content: string) => {
      let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
      if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
      el.content = content;
    };
    add('name', 'description', 'KODA 법인 대시보드는 법인·기관의 디지털 자산을 한 화면에서 확인하고, 승인하고, 감사 기록으로 남기는 산학 데모입니다. 모든 데이터는 모의 값입니다.');
    add('name', 'robots', 'noindex, nofollow');
    add('property', 'og:title', 'KODA | 법인 디지털 자산 대시보드');
    add('property', 'og:description', '확인이 쌓여, 신뢰가 됩니다. 자산 확인부터 승인·감사 기록까지 한 화면에서. 산학 데모용 모의 환경입니다.');
    add('property', 'og:image', '/site/plates/final.jpg');
    add('property', 'og:type', 'website');
  }, []);
}

export function SitePage() {
  useSiteMeta();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('top');
  const [activeChange, setActiveChange] = useState(0);
  const [lightbox, setLightbox] = useState<ScreenItem | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [soundOn, setSoundOn] = useState(false);

  // 스크롤에 맞춰 내비게이션 배경과 현재 섹션을 표시한다.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const sections = [...document.querySelectorAll<HTMLElement>('main section[id]')];
    if (!sections.length || !('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible?.target.id) setActiveSection(visible.target.id);
    }, { rootMargin: '-38% 0px -52% 0px', threshold: [0, 0.2, 0.5] });
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>('.site [data-rv]')];
    if (!els.length) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (lightbox && !d.open) d.showModal();
    if (!lightbox && d.open) d.close();
  }, [lightbox]);

  // 영상: 축소 모션·절전 모드에서는 재생하지 않고 포스터를 남긴다.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
    if (reduce || saveData) { v.pause(); return; }
    void v.play().catch(() => {});
  }, []);

  const toggleSound = async () => {
    const v = videoRef.current;
    if (!v) return;
    if (soundOn) { v.muted = true; setSoundOn(false); return; }
    v.muted = false;
    try { await v.play(); setSoundOn(true); } catch { v.muted = true; setSoundOn(false); }
  };

  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="site" id="top">
      <a className="site-skip" href="#main">본문으로 건너뛰기</a>

      <header className={`site-nav${scrolled ? ' is-scrolled' : ''}${menuOpen ? ' is-open' : ''}`}>
        <div className="site-nav-in">
          <a className="site-brand" href="#top" onClick={closeMenu} >
            <img src="/koda-logo.svg" alt="" width={117} height={26} />
            <span className="site-brand-div" aria-hidden="true" />
            <em>법인 대시보드</em>
          </a>
          <nav className="site-nav-links" aria-label="사이트 바로가기">
            {NAV.map((n) => (
              <a key={n.id} href={`#${n.id}`} aria-current={activeSection === n.id ? 'true' : undefined} onClick={closeMenu}>{n.label}</a>
            ))}
            <a className="site-nav-dash" href="/login" onClick={closeMenu}>대시보드 <IconArrowRight size={15} aria-hidden="true" /></a>
          </nav>
          <button className="site-nav-toggle" type="button" aria-expanded={menuOpen} aria-controls="site-nav-links" aria-label={menuOpen ? '메뉴 닫기' : '메뉴 열기'} onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? <IconX size={20} aria-hidden="true" /> : <IconMenu2 size={20} aria-hidden="true" />}
          </button>
        </div>
      </header>

      <main id="main">
        <section className="site-hero" aria-labelledby="site-hero-h">
          <div className="site-hero-media" aria-hidden="true">
            <video ref={videoRef} autoPlay muted loop playsInline preload="metadata" poster="/site/plates/hero.jpg" tabIndex={-1}>
              <source src="/brand/koda-brand-film-16x9.mp4" type="video/mp4" />
            </video>
            <img className="site-hero-poster" src="/site/plates/hero.jpg" alt="" width={1600} height={900} fetchPriority="high" />
          </div>
          <div className="site-hero-shade" aria-hidden="true" />
          <div className="site-hero-inner">
            <p className="site-kicker site-hero-kicker"><i aria-hidden="true" />KODA · 법인 디지털 자산 파트너</p>
            <h1 className="site-hero-h" id="site-hero-h">
              확인이 쌓여,<br /><em>신뢰가 됩니다.</em>
            </h1>
            <p className="site-hero-lead">
              법인·기관 투자자를 위한 디지털 자산 대시보드. 자산 확인부터 승인, 감사 기록까지 한 화면에서 이어집니다.
              이 사이트는 산학 데모용 모의 환경입니다.
            </p>
            <div className="site-hero-actions">
              <a className="site-btn site-btn-primary" href="/login">대시보드 열기 <IconArrowRight size={18} aria-hidden="true" /></a>
              <a className="site-btn site-btn-ghost" href="#film">브랜드 필름 보기</a>
            </div>
            <ul className="site-hero-meta" aria-label="데모 안내">
              <li>모의 데이터</li>
              <li>실제 자산 없음</li>
              <li>3분 데모</li>
            </ul>
          </div>
          <div className="site-hero-preview" aria-hidden="true">
            <p className="site-hero-preview-note"><i />대시보드 미리보기</p>
            <div className="site-browser">
              <div className="site-browser-bar">
                <span className="site-browser-dots"><i /><i /><i /></span>
                <span className="site-browser-url">koda-inha-dashboard.vercel.app</span>
              </div>
              <img src="/site/screens/home.jpg" alt="" width={1440} height={900} fetchPriority="high" />
            </div>
            <p className="site-caption"><b>HOME</b> 확인 상태 · 보유 자산 · 처리할 일</p>
          </div>
          <button className="site-hero-sound" type="button" aria-pressed={soundOn} aria-label={soundOn ? '배경음 끄기' : '배경음 켜기'} onClick={() => void toggleSound()}>
            {soundOn ? <IconVolumeOff size={17} aria-hidden="true" /> : <IconVolume size={17} aria-hidden="true" />}
            {soundOn ? '배경음 끄기' : '배경음 켜기'}
          </button>
          <a className="site-hero-scroll" href="#change" aria-label="스크롤 — 아래로 내려가 바뀌는 점 보기"><span aria-hidden="true">↓</span> 스크롤</a>
        </section>

        <section className="site-sec site-change" id="change" aria-labelledby="change-h">
          <div className="site-wrap">
            <p className="site-eyebrow" data-rv><i aria-hidden="true" />바뀌는 것 3가지</p>
            <div className="site-sec-head">
              <h2 className="site-h2" id="change-h" data-rv>자산을 확인하는 일에서,<br />결정을 증명하는 일까지.</h2>
              <p className="site-lead" data-rv>법인 자산 관리는 화면 한 곳에서 끝나지 않습니다. 확인하고, 승인하고, 기록으로 남기는 세 단계를 KODA가 이어 줍니다.</p>
            </div>
            <div className="site-change-grid">
              <div className="site-change-list" data-rv>
                {CHANGES.map((c, i) => {
                  const open = activeChange === i;
                  return (
                    <div key={c.n} className={`site-change-item${open ? ' is-open' : ''}`}>
                      <button type="button" className="site-change-head" aria-expanded={open} aria-controls={`change-body-${c.n}`} onClick={() => setActiveChange(i)}>
                        <span className="site-change-num">{c.n}</span>
                        <span className="site-change-title">{c.title}</span>
                        <IconChevronDown size={20} aria-hidden="true" className="site-change-caret" />
                      </button>
                      <div className="site-change-body" id={`change-body-${c.n}`} hidden={!open}>
                        <p>{c.body}</p>
                        <a className="site-text-link" href={c.linkHref}>{c.linkLabel} <IconArrowRight size={15} aria-hidden="true" /></a>
                      </div>
                    </div>
                  );
                })}
                <p className="site-note">세 단계 모두 이 데모에서 직접 확인할 수 있습니다. 화면 오른쪽은 실제 대시보드 화면을 옮긴 이미지입니다.</p>
              </div>
              <div className="site-change-visual" data-rv>
                <div className="site-browser">
                  <div className="site-browser-bar" aria-hidden="true">
                    <span className="site-browser-dots"><i /><i /><i /></span>
                    <span className="site-browser-url">koda-inha-dashboard.vercel.app</span>
                    <span className="site-browser-live">DEMO</span>
                  </div>
                  <img src={CHANGES[activeChange]!.image} alt={`${CHANGES[activeChange]!.caption} 화면`} width={1440} height={900} loading="lazy" />
                </div>
                <p className="site-caption"><b>{CHANGES[activeChange]!.n}</b> {CHANGES[activeChange]!.caption}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="site-sec site-film" id="film" aria-labelledby="film-h">
          <div className="site-wrap">
            <p className="site-eyebrow" data-rv><i aria-hidden="true" />브랜드 필름</p>
            <div className="site-sec-head">
              <h2 className="site-h2" id="film-h" data-rv>42초로 보는 KODA.</h2>
              <p className="site-lead" data-rv>확인하고, 승인하고, 보관하는 흐름을 한 편의 필름으로 담았습니다. 장면 6개를 따라가며 KODA의 방식과 대시보드의 화면을 함께 볼 수 있습니다.</p>
            </div>
            <div className="site-film-frame" data-rv>
              <video controls playsInline preload="metadata" poster="/site/plates/final.jpg">
                <source src="/brand/koda-brand-film-16x9.mp4" type="video/mp4" />
                브랜드 필름을 재생할 수 없는 브라우저입니다. <a href="/brand/koda-brand-film-16x9.mp4">영상 파일 내려받기</a>
              </video>
            </div>
            <div className="site-film-meta">
              <span>KODA 브랜드 필름 · 42초 · 16:9</span>
              <div className="site-film-links">
                <span className="site-film-note">배경음 포함 · 발표 장비에서 소리를 확인하세요.</span>
                <a className="site-text-link site-text-link-light" href="/brand/koda-brand-film-16x9.mp4" download>MP4 내려받기 <IconDownload size={15} aria-hidden="true" /></a>
              </div>
            </div>
            <ol className="site-chapters" data-rv>
              {CHAPTERS.map((c) => (
                <li key={c.k} className="site-chapter">
                  <img src={c.img} alt="" width={1600} height={900} loading="lazy" />
                  <div className="site-chapter-copy">
                    <p className="site-chapter-k">{c.k}</p>
                    <h3>{c.t}</h3>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="site-sec site-screens" id="screens" aria-labelledby="screens-h">
          <div className="site-wrap">
            <p className="site-eyebrow" data-rv><i aria-hidden="true" />화면 6장</p>
            <div className="site-sec-head">
              <h2 className="site-h2" id="screens-h" data-rv>대시보드에서 실제로 보게 되는 화면.</h2>
              <p className="site-lead" data-rv>로그인 화면부터 승인 결정 카드, 감사 기록까지. 데모 사용자로 직접 열어 볼 수 있습니다. 이미지를 누르면 크게 볼 수 있습니다.</p>
            </div>
            <div className="site-screen-grid" data-rv>
              {SCREENS.map((s) => (
                <button key={s.tag} type="button" className="site-screen" onClick={() => setLightbox(s)} aria-label={`${s.title} 화면 크게 보기`}>
                  <img src={s.img} alt={`${s.title} 화면`} width={1440} height={900} loading="lazy" />
                  <span className="site-screen-copy">
                    <span className="site-screen-tag">{s.tag} · {s.title}</span>
                    <span className="site-screen-caption">{s.caption}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="site-screens-cta" data-rv>
              <a className="site-btn site-btn-dark" href="/login">대시보드에서 직접 확인하기 <IconArrowRight size={18} aria-hidden="true" /></a>
              <span className="site-note">모의 데이터 · 실제 자산 없음</span>
            </div>
          </div>
        </section>

        <section className="site-sec site-resources" id="resources" aria-labelledby="resources-h">
          <div className="site-wrap">
            <p className="site-eyebrow" data-rv><i aria-hidden="true" />자료 3종</p>
            <div className="site-sec-head">
              <h2 className="site-h2" id="resources-h" data-rv>데모 전에 챙겨 볼 세 가지.</h2>
              <p className="site-lead" data-rv>소개서와 3분 데모 가이드, 브랜드 필름을 한곳에 두었습니다. 발표 전에 내려받아 확인해 보세요.</p>
            </div>
            <div className="site-res-grid" data-rv>
              {RESOURCES.map((r) => (
                <a key={r.href} className="site-res" href={r.href} download={r.icon === 'movie' ? undefined : true} target={r.icon === 'movie' ? '_blank' : undefined} rel={r.icon === 'movie' ? 'noreferrer' : undefined}>
                  <span className="site-res-top">
                    <span className="site-res-type">{r.type}</span>
                    <span className="site-res-icon" aria-hidden="true">{r.icon === 'movie' ? <IconMovie size={22} /> : <IconFileText size={22} />}</span>
                  </span>
                  <h3>{r.title}</h3>
                  <p>{r.desc}</p>
                  <span className="site-res-foot"><span>{r.meta}</span><IconDownload size={18} aria-hidden="true" /></span>
                </a>
              ))}
            </div>
          </div>
        </section>

        <section className="site-contact" id="contact" aria-labelledby="contact-h">
          <div className="site-wrap site-contact-grid">
            <div>
              <p className="site-eyebrow site-eyebrow-light" data-rv><i aria-hidden="true" />도입 안내</p>
              <h2 className="site-h2 site-contact-h" id="contact-h" data-rv>지금, 법인 데모를<br />열어 보세요.</h2>
              <p className="site-lead site-lead-light" data-rv>로그인 없이 데모 사용자를 고르면 바로 시작할 수 있습니다. 실제 자산 없이, 화면과 흐름만 확인하는 3분입니다.</p>
              <div className="site-contact-actions" data-rv>
                <a className="site-btn site-btn-primary" href="/login">대시보드 열기 <IconArrowRight size={18} aria-hidden="true" /></a>
                <a className="site-btn site-btn-outline" href="/site/koda-3min-demo-guide.pdf" download>3분 데모 가이드</a>
              </div>
            </div>
            <div className="site-contact-mark" aria-hidden="true">
              <span className="site-3min">3분</span>
              <span className="site-3min-note">확인하고, 승인하고, 기록으로.<br />법인 자산 관리의 한 화면.</span>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="site-wrap site-footer-in">
          <div className="site-footer-brand">
            <img src="/koda-logo.svg" alt="KODA" width={92} height={21} />
            <span className="site-footer-line">모의 데이터 · KODA 공식 서비스 아님</span>
          </div>
          <nav className="site-footer-links" aria-label="바닥글 링크">
            <a href="#change">바뀌는 것</a>
            <a href="#film">브랜드 필름</a>
            <a href="#resources">자료</a>
            <a href="/login">대시보드</a>
          </nav>
          <p className="site-footer-copy">이 사이트와 대시보드는 산학 데모용 모의 환경입니다. 실제 자산·고객 정보가 없으며 KODA 공식 서비스가 아닙니다. © 2026 KODA Demo.</p>
        </div>
      </footer>

      <dialog ref={dialogRef} className="site-lightbox" aria-label={lightbox ? `${lightbox.title} 화면` : '화면 확대'} onClose={() => setLightbox(null)} onClick={(e) => { if (e.target === dialogRef.current) setLightbox(null); }}>
        {lightbox && (
          <div className="site-lightbox-in">
            <div className="site-lightbox-head">
              <p><b>{lightbox.tag}</b> {lightbox.title}</p>
              <button type="button" className="site-lightbox-close" onClick={() => setLightbox(null)} aria-label="확대 화면 닫기"><IconX size={20} aria-hidden="true" /></button>
            </div>
            <img src={lightbox.img} alt={`${lightbox.title} 화면 확대`} width={1440} height={900} />
            <p className="site-lightbox-caption">{lightbox.caption} · 모의 데이터</p>
          </div>
        )}
      </dialog>
    </div>
  );
}
