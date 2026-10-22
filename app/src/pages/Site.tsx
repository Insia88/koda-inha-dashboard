import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  IconArrowLeft, IconArrowRight, IconArrowUpRight, IconBuildingBank, IconCertificate,
  IconFileCertificate, IconLock, IconMail, IconMapPin, IconMenu2, IconPlayerPause, IconPhone, IconPlayerPlay,
  IconShieldCheck, IconWallet, IconWorld, IconX,
} from '@tabler/icons-react';
import './site.css';

const NAV = [
  { id: 'about', label: '회사 소개' },
  { id: 'services', label: '서비스' },
  { id: 'trust', label: '신뢰·보안' },
  { id: 'news', label: '보도자료' },
  { id: 'dashboard', label: '대시보드 데모' },
];

const STATS = [
  {
    value: '86.6%', label: '국내 커스터디 시장 점유율',
    note: '2024년 하반기 수탁고 기준 · 전체 1.5조 원 / KODA 1.3조 원',
    source: '출처: 금융위원회 2024년 하반기 가상자산사업자 실태조사',
  },
  {
    value: '$40M', label: '고객자산 전용 보험 보장 한도',
    note: 'KB손해보험 · 약 573억 원 · 2026.08',
    source: '국내 커스터디 업계 최고 보장 한도',
  },
  {
    value: '15+', label: '지원 메인넷',
    note: 'Bitcoin · Ethereum · Solana · Base · BSC · Kaia 등',
    source: 'EVM 계열 1주 이내, 그 외 2~3주 이내 추가 지원',
  },
  {
    value: '100%', label: '콜드월렛 보관',
    note: '네트워크와 물리적으로 단절된 콜드월렛·콜드룸',
    source: '다중서명 HSM · MPC 기반 키 통제',
  },
];

const TIMELINE = [
  ['2020.11', 'KB국민은행·해시드·해치랩스 공동 설립'],
  ['2021.12', '가상자산사업자(VASP) 신고 완료'],
  ['2024.04', 'Pre-A 투자 유치'],
  ['2025.11', '시리즈A 100억 원 유치'],
  ['2026.06', '삼일PwC SOC1 Type 2 인증'],
  ['2026.08', 'KB손보 보험 한도 $40M 확대'],
  ['2026.10', 'Figment 기관용 ETH 스테이킹 파트너십'],
];

const INVESTORS = ['KB국민은행', '해시드', '해치랩스', '알토스벤처스', '삼성자산운용', '한화투자증권', 'IBK캐피탈', '교보증권'];

interface Service { no: string; en: string; title: string; desc: string; points: string[]; icon: typeof IconLock }
const SERVICES: Service[] = [
  {
    no: '01', en: 'Custody', title: '안전한 보관', icon: IconLock,
    desc: '고객의 모든 자산을 100% 콜드월렛에 보관합니다. 네트워크와 물리적으로 단절된 콜드룸에서 관리합니다.',
    points: ['100% 콜드월렛', 'MPC 다중서명', 'FIPS 140-2/3 HSM'],
  },
  {
    no: '02', en: 'Staking', title: '스테이킹', icon: IconWorld,
    desc: '보관 중인 자산을 블록체인 네트워크에 위임해 보상을 받습니다. 기관 내부통제 기준에 맞춰 운영합니다.',
    points: ['ETH·SOL 등 주요 자산', 'Figment 파트너십(2026.10)', 'DAT 법인 대응'],
  },
  {
    no: '03', en: 'Supply & Lock-up', title: '유통량·락업 관리', icon: IconCertificate,
    desc: '발행 코인의 유통량과 투자 코인의 락업 스케줄을 수탁·관리합니다.',
    points: ['유통량 관리', '락업 스케줄', '발행사 리포팅'],
  },
  {
    no: '04', en: 'Enterprise Controls', title: '법인 맞춤 기능', icon: IconBuildingBank,
    desc: '법인 구조에 맞춰 구성원 권한을 나누고, 지갑별 결재선으로 다중 승인 구조를 만듭니다.',
    points: ['권한 분리', '지갑별 결재선', '증명서 발급'],
  },
  {
    no: '05', en: 'Monitoring', title: '모니터링·보안', icon: IconShieldCheck,
    desc: 'OTP·IP 화이트리스팅, 실시간 모니터링, 이상거래 탐지와 트래블룰·STR 대응을 제공합니다.',
    points: ['OTP · IP 인증', '이상거래 탐지', '트래블룰 · STR'],
  },
  {
    no: '06', en: 'Integration', title: '시스템 연동', icon: IconWallet,
    desc: 'API로 거래소와 기업 재무시스템을 연동해 자산 관리와 대사를 자동화합니다.',
    points: ['API 연동', '거래소·재무시스템', '자동 대사'],
  },
];

const TRUST = [
  { icon: IconShieldCheck, kicker: 'ISMS', title: '정보보호 관리체계 인증', desc: '가상자산 수탁 서비스 범위로 ISMS 인증을 취득·유지하고 있습니다.', meta: '유효기간 2024.09–2027.08' },
  { icon: IconFileCertificate, kicker: 'VASP', title: '가상자산사업자 등록', desc: '금융위원회에 등록된 가상자산사업자로 법인·기관 고객을 수탁합니다.', meta: 'VASP 등록번호 2025-04' },
  { icon: IconCertificate, kicker: 'SOC1 Type 2', title: '삼일PwC SOC1 인증', desc: '콜드룸·지갑 생성·출금·접근통제 등 수탁 내부통제를 외부 감사로 검증받았습니다.', meta: '2026.06 인증 획득' },
  { icon: IconBuildingBank, kicker: 'INSURANCE', title: '고객자산 전용 보험', desc: 'KB손해보험과 고객자산 전용 보험 계약을 체결했습니다.', meta: '$40M · 약 573억 원 (2026.08)' },
  { icon: IconLock, kicker: 'COLD WALLET', title: '100% 콜드월렛·콜드룸', desc: '모든 자산을 네트워크와 단절된 콜드월렛에 보관하고, 콜드룸 출입·반출을 통제합니다.', meta: '내화금고 · UPS · 출입통제 · CCTV' },
  { icon: IconShieldCheck, kicker: 'MPC · HSM', title: '다중서명 키 통제', desc: '키 하나가 유출되어도 자산이 탈취되지 않도록 MPC와 멀티시그 HSM으로 서명을 통제합니다.', meta: 'FIPS 140-2/3 인증 HSM' },
];

interface Press { date: string; source: string; title: string; summary: string; href: string }
const PRESS: Press[] = [
  {
    date: '2026.10.08', source: '헤럴드경제', title: 'KODA, 피그먼트와 기관용 이더리움 스테이킹 서비스 확대',
    summary: '수탁 체계를 유지하면서 ETH 스테이킹에 참여하고 추가 보상을 받을 수 있도록 지원합니다.',
    href: 'https://biz.heraldcorp.com/article/10896521',
  },
  {
    date: '2026.08.03', source: '연합뉴스', title: '커스터디 보험 보장한도 4천만 달러로 확대',
    summary: 'KB손해보험과 약 573억 원 규모의 고객자산 전용 보험 계약을 체결했습니다.',
    href: 'https://www.yna.co.kr/view/AKR20260803047600002',
  },
  {
    date: '2026.06.02', source: '이데일리', title: '삼일PwC SOC1 Type 2 인증 획득',
    summary: '콜드룸 운영, 지갑 생성·출금, 접근통제 등 수탁 내부통제 전반을 검증받았습니다.',
    href: 'https://www2.edaily.co.kr/News/Read?newsId=03516166645477784&mediaCodeNo=257',
  },
  {
    date: '2025.11.26', source: '이투데이', title: '시리즈A 100억 원 투자 유치',
    summary: '한화투자증권·IBK캐피탈·교보증권이 신규 주주로 참여했습니다.',
    href: 'https://m.etoday.co.kr/news/view/2529785',
  },
  {
    date: '2025.09', source: 'KODA 공식', title: '가상자산사업자 최초 벤처기업 확인 획득',
    summary: '중소벤처기업부의 벤처기업 확인을 가상자산사업자 최초로 획득했습니다.',
    href: 'https://www.kodax.com/news',
  },
  {
    date: '2025.07', source: 'KODA 공식', title: '삼성화재와 가상자산 보험계약 체결',
    summary: '최대 2,000만 달러 한도의 가상자산 보험 계약으로 고객 자산 보호를 강화했습니다.',
    href: 'https://www.kodax.com/news',
  },
];

const DASHBOARD_FEATURES = [
  '최고관리자 계정 · OTP/IP 인증',
  '조직 구성원 · 권한 관리',
  '지갑 생성 · 지갑별 결재선',
  '토큰 · 주소록(트래블룰)',
  '출금 결재 · 요청 처리',
];

const DASHBOARD_SLIDES = [
  { img: '/site/screens/home.jpg', title: '홈 · 확인 상태', desc: '자산 담당자가 오늘 확인할 주소와 승인 차례, 진행 중 요청을 한눈에 봅니다.' },
  { img: '/site/screens/request-detail.jpg', title: '요청 상세 · 결정 카드', desc: '받는 주소·금액·승인 지문과 점검 결과를 다시 확인하고 승인합니다.' },
  { img: '/site/screens/audit.jpg', title: '감사 기록 · 무결성', desc: '추가 전용 감사 기록과 해시 체인으로 결정을 확인합니다.' },
];

function useSiteMeta() {
  useEffect(() => {
    document.title = '한국디지털에셋(KODA) | 법인·기관 투자자를 위한 디지털 자산 파트너';
    const add = (attr: 'name' | 'property', key: string, content: string) => {
      let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
      if (!el) { el = document.createElement('meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
      el.content = content;
    };
    add('name', 'description', '한국디지털에셋(KODA)은 KB국민은행이 직접 출자한 법인으로, 비트코인 수탁 등 법인·기관 투자자를 위한 디지털 자산 원스탑 서비스를 제공합니다.');
    add('name', 'robots', 'noindex, nofollow');
    add('property', 'og:title', '한국디지털에셋(KODA) | 법인·기관 투자자를 위한 디지털 자산 파트너');
    add('property', 'og:description', 'KB국민은행이 직접 출자한 법인·기관 전문 디지털 자산 커스터디. 보관·스테이킹·권한·감사까지 한곳에서.');
    add('property', 'og:image', '/site/screens/home.jpg');
    add('property', 'og:type', 'website');
  }, []);
}

export function SitePage() {
  useSiteMeta();
  const [scrolled, setScrolled] = useState(false);
  const [progress, setProgress] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('top');
  const [reduced, setReduced] = useState(false);

  // 히어로 주요 지표 캐러셀
  const [statIndex, setStatIndex] = useState(0);
  const [statPaused, setStatPaused] = useState(false);

  // 서비스·보도자료·대시보드 화면 캐러셀
  const [serviceIndex, setServiceIndex] = useState(0);
  const [pressIndex, setPressIndex] = useState(0);
  const [dashIndex, setDashIndex] = useState(0);
  const serviceTrack = useRef<HTMLDivElement>(null);
  const pressTrack = useRef<HTMLDivElement>(null);
  const dashTrack = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // 스크롤 진행선·현재 섹션
  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 16);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);
    };
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
    const els = [...document.querySelectorAll<HTMLElement>('.koda [data-rv]')];
    if (!els.length) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      els.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.08 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // 주요 지표 자동 넘김: 호버·포커스·일시정지·reduced motion에서 멈춘다.
  useEffect(() => {
    if (statPaused || reduced) return;
    const t = window.setInterval(() => setStatIndex((i) => (i + 1) % STATS.length), 6000);
    return () => window.clearInterval(t);
  }, [statPaused, reduced]);

  const goCarousel = (ref: React.RefObject<HTMLDivElement | null>, index: number, setIndex: (n: number) => void, length: number) => {
    const track = ref.current;
    if (!track) return;
    const i = Math.max(0, Math.min(length - 1, index));
    const card = track.children[i] as HTMLElement | undefined;
    if (card) {
      const left = card.offsetLeft - (track.clientWidth - card.clientWidth) / 2;
      track.scrollTo({ left: Math.max(0, left), behavior: reduced ? 'auto' : 'smooth' });
    }
    setIndex(i);
  };
  const onTrackScroll = (ref: React.RefObject<HTMLDivElement | null>, setIndex: (n: number) => void) => {
    const track = ref.current;
    if (!track) return;
    const center = track.scrollLeft + track.clientWidth / 2;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    [...track.children].forEach((child, i) => {
      const el = child as HTMLElement;
      const distance = Math.abs(el.offsetLeft + el.clientWidth / 2 - center);
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    });
    setIndex(best);
  };
  const onTrackKey = (e: KeyboardEvent<HTMLDivElement>, ref: React.RefObject<HTMLDivElement | null>, index: number, setIndex: (n: number) => void, length: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    goCarousel(ref, index + (e.key === 'ArrowRight' ? 1 : -1), setIndex, length);
  };
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className="koda" id="top">
      <a className="koda-skip" href="#main">본문으로 건너뛰기</a>

      <header className={`koda-nav${scrolled ? ' is-scrolled' : ''}${menuOpen ? ' is-open' : ''}`}>
        <span className="koda-nav-progress" aria-hidden="true" style={{ transform: `scaleX(${progress})` }} />
        <div className="koda-nav-in">
          <a className="koda-brand" href="#top" onClick={closeMenu}>
            <img src="/koda-logo.svg" alt="KODA" width={117} height={26} />
            <span className="koda-brand-sub">Korea Digital Asset</span>
          </a>
          <nav id="koda-nav-links" className="koda-nav-links" aria-label="사이트 바로가기">
            {NAV.map((n) => (
              <a key={n.id} href={`#${n.id}`} aria-current={activeSection === n.id ? 'true' : undefined} onClick={closeMenu}>{n.label}</a>
            ))}
            <a className="koda-nav-cta" href="mailto:hello@kodax.com" onClick={closeMenu}>서비스 문의 <IconArrowUpRight size={15} aria-hidden="true" /></a>
          </nav>
          <button className="koda-nav-toggle" type="button" aria-expanded={menuOpen} aria-controls="koda-nav-links" aria-label={menuOpen ? '메뉴 닫기' : '메뉴 열기'} onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? <IconX size={20} aria-hidden="true" /> : <IconMenu2 size={20} aria-hidden="true" />}
          </button>
        </div>
      </header>

      <main id="main">
        <section className="koda-hero" aria-labelledby="koda-hero-h">
          <div className="koda-wrap koda-hero-grid">
            <div className="koda-hero-copy">
              <p className="koda-kicker koda-rv">KOREA DIGITAL ASSET · KODA</p>
              <h1 className="koda-hero-h koda-rv" id="koda-hero-h">
                <span>디지털 자산의</span>
                <span><em>가장 신뢰할 수 있는</em></span>
                <span>파트너.</span>
              </h1>
              <p className="koda-hero-lead koda-rv">KB국민은행이 직접 출자한 법인·기관 전문 디지털 자산 커스터디 기업. 보관부터 스테이킹, 권한·결재, 증명까지 한곳에서 제공합니다.</p>
              <div className="koda-actions koda-rv">
                <a className="koda-btn koda-btn-primary" href="mailto:hello@kodax.com">서비스 문의 <IconArrowUpRight size={18} aria-hidden="true" /></a>
                <a className="koda-btn koda-btn-line" href="#dashboard">대시보드 데모 보기</a>
              </div>
              <ul className="koda-hero-meta koda-rv" aria-label="KODA 주요 정보">
                <li>KB국민은행 직접 출자</li>
                <li>가상자산사업자(VASP) 등록</li>
                <li>2020년 설립</li>
              </ul>
            </div>

            <div className="koda-hero-art">
              <span className="koda-hero-shape koda-shape-band" aria-hidden="true" />
              <span className="koda-hero-shape koda-shape-circle" aria-hidden="true" />
              <div
                className="koda-stat-card"
                role="region"
                aria-roledescription="carousel"
                aria-label="KODA 주요 지표"
                onMouseEnter={() => setStatPaused(true)}
                onMouseLeave={() => setStatPaused(false)}
                onFocusCapture={() => setStatPaused(true)}
                onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setStatPaused(false); }}
              >
                <div className="koda-stat-head">
                  <span className="koda-stat-label">KODA AT A GLANCE</span>
                  <button className="koda-icon-btn" type="button" aria-pressed={statPaused} aria-label={statPaused ? '지표 자동 넘김 다시 시작' : '지표 자동 넘김 일시정지'} onClick={() => setStatPaused((p) => !p)}>
                    {statPaused ? <IconPlayerPlay size={15} aria-hidden="true" /> : <IconPlayerPause size={15} aria-hidden="true" />}
                  </button>
                </div>
                <div className="koda-stat-slides" aria-live="off">
                  {STATS.map((s, i) => (
                    <div key={s.value} className={`koda-stat-slide${i === statIndex ? ' is-active' : ''}`} aria-hidden={i !== statIndex}>
                      <p className="koda-stat-value">{s.value}</p>
                      <p className="koda-stat-name">{s.label}</p>
                      <p className="koda-stat-note">{s.note}</p>
                      <p className="koda-stat-source">{s.source}</p>
                    </div>
                  ))}
                </div>
                <p className="koda-sr-only" aria-live="polite">{`${statIndex + 1} / ${STATS.length}. ${STATS[statIndex]!.label}: ${STATS[statIndex]!.value}`}</p>
                <div className="koda-stat-foot">
                  <div className="koda-stat-bars" role="group" aria-label="지표 선택">
                    {STATS.map((s, i) => (
                      <button key={s.value} type="button" className={i === statIndex ? 'is-active' : ''} aria-label={`${i + 1}번 지표 보기`} aria-current={i === statIndex ? 'true' : undefined} onClick={() => setStatIndex(i)} />
                    ))}
                  </div>
                  <span className="koda-stat-progress" aria-hidden="true"><i key={statIndex} className={statPaused || reduced ? 'is-paused' : ''} /></span>
                </div>
              </div>
            </div>
          </div>
          <div className="koda-hero-foot">
            <div className="koda-wrap koda-hero-foot-in">
              <span>KB국민은행 · 해시드 · 해치랩스 공동 설립</span>
              <span>법인·기관 디지털 자산 원스탑 서비스</span>
            </div>
          </div>
        </section>

        <section className="koda-sec" id="about" aria-labelledby="about-h">
          <div className="koda-wrap">
            <div className="koda-head">
              <p className="koda-eyebrow" data-rv>01 · COMPANY</p>
              <div className="koda-head-row">
                <h2 className="koda-h2" id="about-h" data-rv>국내 커스터디 시장을<br />선도하는 금융기관 출자 기업.</h2>
                <div className="koda-head-copy" data-rv>
                  <p>한국디지털에셋(KODA)은 2020년 11월 KB국민은행·해시드·해치랩스가 공동 설립한 법인·기관 전문 디지털 자산 커스터디 기업입니다.</p>
                  <p>금융기관이 직접 출자한 국내 최초의 커스터디 기업으로, 고객 자산을 안전하고 투명하게 보관·운영·증명하는 종합 인프라를 제공합니다.</p>
                </div>
              </div>
            </div>

            <div className="koda-about-grid">
              <div className="koda-facts" data-rv>
                <div className="koda-fact"><span className="koda-fact-k">설립</span><strong>2020.11</strong><p>KB국민은행, 해시드, 해치랩스 공동 설립</p></div>
                <div className="koda-fact"><span className="koda-fact-k">등록</span><strong>VASP 2025-04</strong><p>금융위원회 가상자산사업자 등록</p></div>
                <div className="koda-fact"><span className="koda-fact-k">투자</span><strong>Series A 100억</strong><p>2025.11 금융기관 중심 신규 주주 참여</p></div>
              </div>
              <ol className="koda-timeline" data-rv aria-label="KODA 연혁">
                {TIMELINE.map(([year, text]) => (
                  <li key={year}><span className="koda-timeline-year">{year}</span><p>{text}</p></li>
                ))}
              </ol>
            </div>

            <div className="koda-investors" data-rv>
              <p className="koda-investors-k">주요 주주</p>
              <ul>{INVESTORS.map((i) => <li key={i}>{i}</li>)}</ul>
            </div>
          </div>
        </section>

        <section className="koda-sec koda-sec-soft" id="services" aria-labelledby="services-h">
          <div className="koda-wrap">
            <div className="koda-head">
              <p className="koda-eyebrow" data-rv>02 · SERVICES</p>
              <div className="koda-head-row">
                <h2 className="koda-h2" id="services-h" data-rv>보관부터 운영까지,<br />법인에 필요한 모든 기능.</h2>
                <p className="koda-head-copy" data-rv>콜드월렛 보관, 스테이킹, 유통량·락업 관리, 권한·결재, 모니터링, 시스템 연동까지 법인 고객에게 필요한 기능을 한곳에서 제공합니다.</p>
              </div>
            </div>

            <div className="koda-carousel-head" data-rv>
              <p className="koda-count"><b>{String(serviceIndex + 1).padStart(2, '0')}</b> / {String(SERVICES.length).padStart(2, '0')} <span className="koda-hint">← → 키로 넘기기</span></p>
              <div className="koda-arrows">
                <button type="button" onClick={() => goCarousel(serviceTrack, serviceIndex - 1, setServiceIndex, SERVICES.length)} disabled={serviceIndex === 0} aria-label="이전 서비스"><IconArrowLeft size={18} aria-hidden="true" /></button>
                <button type="button" onClick={() => goCarousel(serviceTrack, serviceIndex + 1, setServiceIndex, SERVICES.length)} disabled={serviceIndex === SERVICES.length - 1} aria-label="다음 서비스"><IconArrowRight size={18} aria-hidden="true" /></button>
              </div>
            </div>
            <div className="koda-carousel" role="region" aria-roledescription="carousel" aria-label="KODA 서비스" data-rv>
              <div
                className="koda-track" ref={serviceTrack} onScroll={() => onTrackScroll(serviceTrack, setServiceIndex)}
                tabIndex={0} onKeyDown={(e) => onTrackKey(e, serviceTrack, serviceIndex, setServiceIndex, SERVICES.length)}
              >
                {SERVICES.map((s, i) => {
                  const Icon = s.icon;
                  return (
                    <article key={s.no} className={`koda-card koda-service${i === serviceIndex ? ' is-current' : ''}`}>
                      <div className="koda-service-top"><span className="koda-num">{s.no}</span><Icon size={24} aria-hidden="true" /></div>
                      <p className="koda-card-en">{s.en}</p>
                      <h3>{s.title}</h3>
                      <p>{s.desc}</p>
                      <ul>{s.points.map((p) => <li key={p}>{p}</li>)}</ul>
                    </article>
                  );
                })}
              </div>
            </div>
            <div className="koda-dots" role="group" aria-label="서비스 선택">
              {SERVICES.map((s, i) => (
                <button key={s.no} type="button" className={i === serviceIndex ? 'is-active' : ''} aria-label={`${s.title} 보기`} aria-current={i === serviceIndex ? 'true' : undefined} onClick={() => goCarousel(serviceTrack, i, setServiceIndex, SERVICES.length)} />
              ))}
            </div>
          </div>
        </section>

        <section className="koda-sec" id="trust" aria-labelledby="trust-h">
          <div className="koda-wrap">
            <div className="koda-head">
              <p className="koda-eyebrow" data-rv>03 · TRUST &amp; SECURITY</p>
              <div className="koda-head-row">
                <h2 className="koda-h2" id="trust-h" data-rv>기관이 요구하는 기준을,<br />외부 검증으로 증명합니다.</h2>
                <p className="koda-head-copy" data-rv>ISMS, VASP, 삼일PwC SOC1 Type 2, 고객자산 전용 보험, 100% 콜드월렛과 다중서명 HSM까지. 금융기관 수준의 통제 체계를 갖추고 있습니다.</p>
              </div>
            </div>
            <div className="koda-trust-grid">
              {TRUST.map((t) => {
                const Icon = t.icon;
                return (
                  <article key={t.kicker} className="koda-trust-card" data-rv>
                    <div className="koda-trust-top"><span className="koda-trust-kicker">{t.kicker}</span><Icon size={24} aria-hidden="true" /></div>
                    <h3>{t.title}</h3>
                    <p>{t.desc}</p>
                    <span className="koda-trust-meta">{t.meta}</span>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="koda-sec koda-sec-soft" id="news" aria-labelledby="news-h">
          <div className="koda-wrap">
            <div className="koda-head">
              <p className="koda-eyebrow" data-rv>04 · NEWSROOM</p>
              <div className="koda-head-row">
                <h2 className="koda-h2" id="news-h" data-rv>KODA의 최근 소식.</h2>
                <div className="koda-head-copy" data-rv>
                  <p>보도자료와 언론 보도로 전해진 KODA의 최근 행보를 확인하세요.</p>
                  <div className="koda-inline-links">
                    <a className="koda-text-link" href="https://www.kodax.com/news" target="_blank" rel="noreferrer">언론 보도 전체 보기 <IconArrowUpRight size={14} aria-hidden="true" /></a>
                    <a className="koda-text-link" href="https://www.kodax.com/blog" target="_blank" rel="noreferrer">기술 블로그 <IconArrowUpRight size={14} aria-hidden="true" /></a>
                  </div>
                </div>
              </div>
            </div>

            <div className="koda-carousel-head" data-rv>
              <p className="koda-count"><b>{String(pressIndex + 1).padStart(2, '0')}</b> / {String(PRESS.length).padStart(2, '0')} <span className="koda-hint">최근 보도 순</span></p>
              <div className="koda-arrows">
                <button type="button" onClick={() => goCarousel(pressTrack, pressIndex - 1, setPressIndex, PRESS.length)} disabled={pressIndex === 0} aria-label="이전 보도자료"><IconArrowLeft size={18} aria-hidden="true" /></button>
                <button type="button" onClick={() => goCarousel(pressTrack, pressIndex + 1, setPressIndex, PRESS.length)} disabled={pressIndex === PRESS.length - 1} aria-label="다음 보도자료"><IconArrowRight size={18} aria-hidden="true" /></button>
              </div>
            </div>
            <div className="koda-carousel" role="region" aria-roledescription="carousel" aria-label="KODA 보도자료" data-rv>
              <div
                className="koda-track" ref={pressTrack} onScroll={() => onTrackScroll(pressTrack, setPressIndex)}
                tabIndex={0} onKeyDown={(e) => onTrackKey(e, pressTrack, pressIndex, setPressIndex, PRESS.length)}
              >
                {PRESS.map((p, i) => (
                  <a key={`${p.date}-${p.title}`} className={`koda-card koda-press${i === pressIndex ? ' is-current' : ''}`} href={p.href} target="_blank" rel="noreferrer">
                    <span className="koda-press-meta">{p.date} · {p.source}</span>
                    <h3>{p.title}</h3>
                    <p>{p.summary}</p>
                    <span className="koda-press-more">기사 보기 <IconArrowUpRight size={15} aria-hidden="true" /></span>
                  </a>
                ))}
              </div>
            </div>
            <div className="koda-dots" role="group" aria-label="보도자료 선택">
              {PRESS.map((p, i) => (
                <button key={p.title} type="button" className={i === pressIndex ? 'is-active' : ''} aria-label={`${p.title} 보도 보기`} aria-current={i === pressIndex ? 'true' : undefined} onClick={() => goCarousel(pressTrack, i, setPressIndex, PRESS.length)} />
              ))}
            </div>
          </div>
        </section>

        <section className="koda-dashboard" id="dashboard" aria-labelledby="dashboard-h">
          <div className="koda-wrap koda-dashboard-grid">
            <div className="koda-dashboard-copy">
              <p className="koda-eyebrow koda-eyebrow-light" data-rv>05 · DASHBOARD DEMO</p>
              <h2 className="koda-h2 koda-h2-light" id="dashboard-h" data-rv>고객 대시보드로<br />권한과 결재를 관리합니다.</h2>
              <p className="koda-dashboard-lead" data-rv>최고관리자 계정과 OTP·IP 인증으로 시작해 조직·권한, 지갑별 결재선, 주소록과 출금 결재까지. 최신 이용가이드의 흐름을 데모에서 확인할 수 있습니다.</p>
              <ul className="koda-dashboard-features" data-rv>
                {DASHBOARD_FEATURES.map((f) => <li key={f}>{f}</li>)}
              </ul>
              <div className="koda-actions" data-rv>
                <a className="koda-btn koda-btn-primary" href="/login">데모 대시보드 열기 <IconArrowRight size={18} aria-hidden="true" /></a>
                <a className="koda-btn koda-btn-ghost" href="/site/koda-3min-demo-guide.pdf" download>데모 가이드 PDF</a>
              </div>
              <p className="koda-dashboard-note" data-rv>이 데모는 공개 시연용 모의 환경입니다. 실제 KODA 고객 대시보드(app.kodax.com)와 데이터가 분리되어 있으며 실제 자산·고객 정보가 없습니다.</p>
            </div>

            <div className="koda-dashboard-visual" data-rv>
              <div className="koda-carousel-head koda-carousel-head-dark">
                <p className="koda-count"><b>{String(dashIndex + 1).padStart(2, '0')}</b> / {String(DASHBOARD_SLIDES.length).padStart(2, '0')}</p>
                <div className="koda-arrows">
                  <button type="button" onClick={() => goCarousel(dashTrack, dashIndex - 1, setDashIndex, DASHBOARD_SLIDES.length)} disabled={dashIndex === 0} aria-label="이전 데모 화면"><IconArrowLeft size={18} aria-hidden="true" /></button>
                  <button type="button" onClick={() => goCarousel(dashTrack, dashIndex + 1, setDashIndex, DASHBOARD_SLIDES.length)} disabled={dashIndex === DASHBOARD_SLIDES.length - 1} aria-label="다음 데모 화면"><IconArrowRight size={18} aria-hidden="true" /></button>
                </div>
              </div>
              <div className="koda-carousel koda-carousel-dark" role="region" aria-roledescription="carousel" aria-label="데모 대시보드 화면">
                <div
                  className="koda-track" ref={dashTrack} onScroll={() => onTrackScroll(dashTrack, setDashIndex)}
                  tabIndex={0} onKeyDown={(e) => onTrackKey(e, dashTrack, dashIndex, setDashIndex, DASHBOARD_SLIDES.length)}
                >
                  {DASHBOARD_SLIDES.map((d, i) => (
                    <figure key={d.img} className={`koda-dash-slide${i === dashIndex ? ' is-current' : ''}`}>
                      <div className="koda-browser">
                        <div className="koda-browser-bar" aria-hidden="true"><span /><span /><span /><em>koda demo</em></div>
                        <img src={d.img} alt={`데모 대시보드 ${d.title} 화면`} width={1440} height={900} loading={i === 0 ? 'eager' : 'lazy'} />
                      </div>
                      <figcaption><b>{d.title}</b> {d.desc}</figcaption>
                    </figure>
                  ))}
                </div>
              </div>
              <div className="koda-dots koda-dots-dark" role="group" aria-label="데모 화면 선택">
                {DASHBOARD_SLIDES.map((d, i) => (
                  <button key={d.img} type="button" className={i === dashIndex ? 'is-active' : ''} aria-label={`${d.title} 화면 보기`} aria-current={i === dashIndex ? 'true' : undefined} onClick={() => goCarousel(dashTrack, i, setDashIndex, DASHBOARD_SLIDES.length)} />
                ))}
              </div>
              <span className="koda-demo-badge">DEMO · 모의 데이터</span>
            </div>
          </div>
        </section>

        <section className="koda-contact" id="contact" aria-labelledby="contact-h">
          <div className="koda-wrap">
            <p className="koda-eyebrow" data-rv>06 · CONTACT</p>
            <div className="koda-contact-grid">
              <h2 className="koda-h2" id="contact-h" data-rv>도입과 서비스,<br />KODA와 함께 시작하세요.</h2>
              <div className="koda-contact-info" data-rv>
                <a href="mailto:hello@kodax.com"><IconMail size={18} aria-hidden="true" />hello@kodax.com</a>
                <a href="tel:025614762"><IconPhone size={18} aria-hidden="true" />02-561-4762</a>
                <p><IconMapPin size={18} aria-hidden="true" />서울시 강남구 테헤란로 238, 마크로젠빌딩 9층</p>
              </div>
              <div className="koda-actions" data-rv>
                <a className="koda-btn koda-btn-primary" href="mailto:hello@kodax.com">서비스 문의 <IconArrowUpRight size={18} aria-hidden="true" /></a>
                <a className="koda-btn koda-btn-line" href="https://www.kodax.com" target="_blank" rel="noreferrer">공식 홈페이지 <IconArrowUpRight size={16} aria-hidden="true" /></a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="koda-footer">
        <div className="koda-wrap koda-footer-grid">
          <div className="koda-footer-brand">
            <img src="/koda-logo.svg" alt="KODA" width={104} height={23} />
            <p>주식회사 한국디지털에셋<br />Korea Digital Asset Co., Ltd.</p>
          </div>
          <div className="koda-footer-info">
            <p>서울시 강남구 테헤란로 238, 마크로젠빌딩 9층</p>
            <p>대표 조진석 · 사업자등록번호 618-81-36254 · 가상자산사업자 등록번호 2025-04</p>
            <p>대표번호 02-561-4762 · hello@kodax.com</p>
          </div>
          <div className="koda-footer-links">
            <a href="https://www.kodax.com" target="_blank" rel="noreferrer">공식 홈페이지</a>
            <a href="https://www.kodax.com/news" target="_blank" rel="noreferrer">보도자료</a>
            <a href="https://app.kodax.com" target="_blank" rel="noreferrer">고객 대시보드</a>
            <a href="/login">데모 대시보드</a>
          </div>
          <p className="koda-footer-copy">© 2020–2026 Korea Digital Asset Co., Ltd. All rights reserved. 이 페이지는 제공된 KODA 자료와 공개 보도 내용을 바탕으로 구성한 사이트이며, 데모 대시보드의 화면과 데이터는 모의 환경입니다.</p>
        </div>
      </footer>
    </div>
  );
}
