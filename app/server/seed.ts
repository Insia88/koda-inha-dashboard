// 개발용 모의 데이터. 실제 고객·지갑 주소·거래·리서치가 아니다.
// 주소는 "MOCK-" 접두의 모의 형식이며 어떤 블록체인에서도 전송 가능한 주소가 아니다.
import { createHash } from 'node:crypto';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { writeAudit } from './audit.ts';
import { krwValue, parseUnits } from '../shared/decimal.ts';
import { LOOKALIKE_RULE_VERSION } from '../shared/address-rules.ts';
import { checkAddress, lookalikeMatchesOf } from './domain/addresses.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function mockAddress(family: 'BTC' | 'EVM' | 'XRP', label: string): string {
  const h = createHash('sha256').update(`koda-mock:${family}:${label}`).digest();
  if (family === 'EVM') return `MOCK-EVM-${h.subarray(0, 20).toString('hex').toUpperCase()}`;
  const body = [...h.subarray(0, family === 'BTC' ? 28 : 24)].map((b) => B32[b % 32]).join('');
  return `MOCK-${family}-${body}`;
}

const ago = (days: number, hours = 0) => new Date(Date.now() - days * 86400_000 - hours * 3600_000).toISOString();

/** 모의 시세(원). 시세 표와 제출 시 평가액 계산이 같은 값을 쓴다. */
const MOCK_KRW_PRICE: Record<string, string> = { BTC: '100000000', ETH: '4000000', USDC: '1400', KAIA: '200', XRP: '3000' };
/** config/policy.json approval.highValueThresholdKrw와 같은 값(설계 가정). tests/seed.test.ts가 둘이 같은지 확인한다. */
const SEED_HIGH_VALUE_THRESHOLD_KRW = 100_000_000n;
/** config/policy.json addressBook.cooldownHours 기본값과 같은 값(설계 가정). tests/address-lifecycle.test.ts가 둘이 같은지 확인한다. */
export const SEED_COOLDOWN_HOURS = 24;

/** 출금 거래의 상대방: 자산·네트워크마다 같은 자산·네트워크로 등록된 주소록 이름만 쓴다. */
const WITHDRAWAL_COUNTERPARTY: Record<string, string> = {
  'USDC/ETHEREUM': '모의 거래소 A 입금 (USDC)', // ab-01
  'USDC/KAIA': '정산 파트너 B (Kaia USDC)', // ab-02
  'ETH/ETHEREUM': '운영비 정산 (ETH)', // ab-05
  'BTC/BITCOIN': '그룹사 BTC 보관 이전용', // ab-03
  'KAIA/KAIA': '카이아 생태계 파트너', // ab-06
  'XRP/XRPL': '모의 거래소 A 입금 (XRP)', // ab-04
};

/**
 * 주소 오염 예시용 모의 주소: 원래 주소와 고유부 앞 head자·뒤 tail자가 같고, 그 사이 글자는 모두 다르다.
 * 끝 6자리 확인만으로는 구분되지 않고, 가운데 8자리를 대조하면 다르다는 것이 드러난다.
 */
function lookalikeOf(original: string, seedLabel: string, head: number, tail: number): string {
  const body = original.replace(/^MOCK-EVM-/, '');
  const filler = mockAddress('EVM', seedLabel).replace(/^MOCK-EVM-/, '');
  const differ = (c: string, from: string) => (c !== from ? c : ((parseInt(c, 16) + 7) % 16).toString(16).toUpperCase());
  const chars = [...body].map((c, i) => (i < head || i >= body.length - tail ? c : differ(filler[i]!, c)));
  return `MOCK-EVM-${chars.join('')}`;
}

export function seed(db: DB) {
  const events: { at: string; orgId: string; actorId: string | null; actorName: string; action: string; targetType: string; targetId: string; summary: string; detail?: Record<string, unknown> }[] = [];
  tx(db, () => {
    const ins = (sql: string, ...args: any[]) => db.prepare(sql).run(...args);
    const created = ago(200);
    // 조직
    ins("INSERT INTO organizations VALUES ('org-a', '모의법인 A', 'customer', 1, ?)", created);
    ins("INSERT INTO organizations VALUES ('org-b', '모의법인 B', 'customer', 1, ?)", created);
    ins("INSERT INTO organizations VALUES ('org-koda', 'KODA 운영(모의)', 'operator', 1, ?)", created);
    // 사용자 (가상 인물)
    const users: [string, string, string, string, string, string[]][] = [
      ['u-a-han', 'org-a', '한지수', 'han@mock-a.example', '재무팀 자산 담당', ['requester']],
      ['u-a-kang', 'org-a', '강도윤', 'kang@mock-a.example', '재무팀 과장', ['requester', 'approver']],
      ['u-a-oh', 'org-a', '오민재', 'oh@mock-a.example', '재무팀장', ['approver']],
      ['u-a-seo', 'org-a', '서예린', 'seo@mock-a.example', 'CFO', ['approver']],
      ['u-a-moon', 'org-a', '문태호', 'moon@mock-a.example', '내부감사', ['auditor']],
      ['u-a-yoon', 'org-a', '윤가람', 'yoon@mock-a.example', 'IT 보안 담당', ['admin']],
      ['u-b-bae', 'org-b', '배서준', 'bae@mock-b.example', '자금 담당', ['requester']],
      ['u-b-lim', 'org-b', '임하은', 'lim@mock-b.example', '자금팀장', ['approver']],
      ['u-b-jo', 'org-b', '조은비', 'jo@mock-b.example', '경영지원 이사', ['admin', 'auditor']],
      ['u-k-op', 'org-koda', 'KODA 운영 담당', 'ops@koda-mock.example', '리서치 큐레이션', ['operator']],
    ];
    for (const [id, org, name, email, title, roles] of users) {
      ins('INSERT INTO users (id, org_id, name, email, title, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, org, name, email, title, created);
      for (const r of roles) ins('INSERT INTO user_roles VALUES (?, ?)', id, r);
    }
    const name = (id: string) => users.find((u) => u[0] === id)![2];

    // 자산·네트워크
    for (const [code, n, p] of [['BTC', '비트코인', 8], ['ETH', '이더리움', 18], ['USDC', 'USD 코인', 6], ['KAIA', '카이아', 18], ['XRP', '엑스알피', 6]] as const) {
      ins('INSERT INTO assets VALUES (?, ?, ?)', code, n, p);
    }
    ins("INSERT INTO networks VALUES ('BITCOIN', 'Bitcoin', 'MOCK_BTC', 0, NULL)");
    ins("INSERT INTO networks VALUES ('ETHEREUM', 'Ethereum', 'MOCK_EVM', 0, NULL)");
    ins("INSERT INTO networks VALUES ('KAIA', 'Kaia', 'MOCK_EVM', 0, NULL)");
    ins("INSERT INTO networks VALUES ('XRPL', 'XRP Ledger', 'MOCK_XRP', 1, '데스티네이션 태그')");
    for (const [a, n] of [['BTC', 'BITCOIN'], ['ETH', 'ETHEREUM'], ['USDC', 'ETHEREUM'], ['USDC', 'KAIA'], ['KAIA', 'KAIA'], ['XRP', 'XRPL']]) ins('INSERT INTO asset_networks VALUES (?, ?)', a, n);
    const precision: Record<string, number> = { BTC: 8, ETH: 18, USDC: 6, KAIA: 18, XRP: 6 };
    const u = (amount: string, asset: string) => parseUnits(amount, precision[asset]!).toString();
    const t0 = new Date().toISOString();
    for (const [a, p] of Object.entries(MOCK_KRW_PRICE)) {
      ins("INSERT INTO prices VALUES (?, ?, ?, '모의 시세(개발용)')", a, p, t0);
    }

    // 지갑·잔고
    const wallets: [string, string, string, string, string | null][] = [
      ['w-a-btc', 'org-a', 'Bitcoin 보관 지갑', 'BITCOIN', null],
      ['w-a-eth', 'org-a', 'Ethereum 보관 지갑', 'ETHEREUM', null],
      ['w-a-kaia', 'org-a', 'Kaia 보관 지갑', 'KAIA', null],
      ['w-a-xrp', 'org-a', 'XRP 보관 지갑', 'XRPL', '20261016'],
      ['w-b-eth', 'org-b', 'Ethereum 보관 지갑', 'ETHEREUM', null],
    ];
    for (const [id, org, n, net, memo] of wallets) {
      const fam = net === 'BITCOIN' ? 'BTC' : net === 'XRPL' ? 'XRP' : 'EVM';
      ins('INSERT INTO wallets VALUES (?, ?, ?, ?, ?, ?, ?)', id, org, n, net, mockAddress(fam, `deposit:${id}`), memo, created);
    }
    const bal: [string, string, string][] = [
      ['w-a-btc', 'BTC', '12.5'], ['w-a-eth', 'ETH', '310.25'], ['w-a-eth', 'USDC', '1250000'], ['w-a-kaia', 'USDC', '300000'],
      ['w-a-kaia', 'KAIA', '2000000'], ['w-a-xrp', 'XRP', '150000'], ['w-b-eth', 'ETH', '10'], ['w-b-eth', 'USDC', '50000'],
    ];
    for (const [w, a, amt] of bal) ins('INSERT INTO balances VALUES (?, ?, ?, ?, ?)', w, a, u(amt, a), '0', t0);

    // 주소록 (모의법인 A 12건, B 1건)
    const book: [string, string, string, string, string, string, string, string, string, string | null, number, string | null][] = [
      // id, org, label, counterparty, asset, network, memo, status, createdBy, reviewedBy, daysAgo, note
      // ab-01~ab-06은 거래 내역의 출금 상대방이다. 출금은 확인된 주소로만 가므로 거래 내역 범위(최근 120일)보다 먼저 등록·확인되게
      // 126~146일 전으로 둔다. 서로의 순서와 다른 주소와의 순서(ab-11이 가장 오래됨)는 그대로다. 난수를 쓰지 않아 다른 모의 값은 바뀌지 않는다.
      ['ab-01', 'org-a', '모의 거래소 A 입금 (USDC)', '모의 거래소 A', 'USDC', 'ETHEREUM', '', 'ACTIVE', 'u-a-han', 'u-a-oh', 146, null],
      ['ab-02', 'org-a', '정산 파트너 B (Kaia USDC)', '모의 정산 파트너 B', 'USDC', 'KAIA', '', 'ACTIVE', 'u-a-han', 'u-a-seo', 142, null],
      ['ab-03', 'org-a', '그룹사 BTC 보관 이전용', '모의 그룹사 C', 'BTC', 'BITCOIN', '', 'ACTIVE', 'u-a-kang', 'u-a-oh', 138, null],
      ['ab-04', 'org-a', '모의 거래소 A 입금 (XRP)', '모의 거래소 A', 'XRP', 'XRPL', '1234567', 'ACTIVE', 'u-a-han', 'u-a-oh', 134, null],
      ['ab-05', 'org-a', '운영비 정산 (ETH)', '모의 서비스사 D', 'ETH', 'ETHEREUM', '', 'ACTIVE', 'u-a-kang', 'u-a-seo', 130, null],
      ['ab-06', 'org-a', '카이아 생태계 파트너', '모의 파트너 E', 'KAIA', 'KAIA', '', 'ACTIVE', 'u-a-han', 'u-a-kang', 126, null],
      ['ab-07', 'org-a', '해외 법인 결제 대행사 — 2026년 4분기 정산 전용 계정(분기 종료 후 사용 중지 예정)', '모의 결제 대행사 F (해외)', 'USDC', 'ETHEREUM', '', 'ACTIVE', 'u-a-kang', 'u-a-oh', 40, null],
      ['ab-08', 'org-a', '신규 거래처 G 입금 주소', '모의 거래처 G', 'USDC', 'ETHEREUM', '', 'PENDING_REVIEW', 'u-a-han', null, 1, null],
      ['ab-09', 'org-a', '그룹사 BTC 예비 주소', '모의 그룹사 C', 'BTC', 'BITCOIN', '', 'PENDING_REVIEW', 'u-a-kang', null, 2, null],
      ['ab-10', 'org-a', '거래처 H (네트워크 확인 필요)', '모의 거래처 H', 'USDC', 'KAIA', '', 'REJECTED', 'u-a-han', 'u-a-seo', 12, '거래처가 Ethereum 네트워크로만 받는다고 확인되었습니다. 네트워크를 바꿔 다시 등록하세요.'],
      ['ab-11', 'org-a', '종료된 거래처 I', '모의 거래처 I', 'ETH', 'ETHEREUM', '', 'DISABLED', 'u-a-kang', 'u-a-oh', 150, null],
      ['ab-12', 'org-a', '모의 거래소 J 입금 (Kaia)', '모의 거래소 J', 'KAIA', 'KAIA', '', 'ACTIVE', 'u-a-han', 'u-a-oh', 30, null],
      ['ab-b1', 'org-b', '모의 거래소 K 입금 (USDC)', '모의 거래소 K', 'USDC', 'ETHEREUM', '', 'ACTIVE', 'u-b-bae', 'u-b-lim', 20, null],
    ];
    // 다른 경로 확인 기록(받은 경로 → 다시 확인한 경로, 확인한 상대·연락처). 이 기록 방식 도입 뒤 등록된 확인 대기 주소에만 둔다.
    // 그 전에 등록된 주소는 기록이 없다(NULL, 화면에는 '기록 없음'). 가상의 연락처이며 실제 사람·번호가 아니다.
    const outOfBand: Record<string, { receivedVia: string; verifiedVia: string; verifiedWith: string }> = {
      'ab-08': { receivedVia: 'document', verifiedVia: 'registered_phone', verifiedWith: '모의 거래처 G 재무팀 대표번호(거래처 등록 연락처)' },
      'ab-09': { receivedVia: 'messenger', verifiedVia: 'video_call', verifiedWith: '모의 그룹사 C 자금팀장과 영상 통화' },
    };
    for (const [id, org, label, cp, asset, net, memo, status, by, rev, days, note] of book) {
      const fam = net === 'BITCOIN' ? 'BTC' : net === 'XRPL' ? 'XRP' : 'EVM';
      const at = ago(days);
      const revAt = rev ? ago(days - 0.5 > 0 ? days - 0.5 : 0, 0) : null;
      const oob = outOfBand[id] ?? null;
      ins('INSERT INTO address_book (id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at, reviewed_by, reviewed_at, review_note, version, received_via, verified_via, verified_with) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, org, label, cp, asset, net, mockAddress(fam, `book:${id}`), memo, status, by, at, rev, revAt, note, rev ? 2 : 1, oob?.receivedVia ?? null, oob?.verifiedVia ?? null, oob?.verifiedWith ?? null);
      events.push({ at, orgId: org, actorId: by, actorName: name(by), action: 'address.created', targetType: 'address', targetId: id, summary: `주소 등록 요청: ${label} (${asset}/${net})`, ...(oob ? { detail: { outOfBand: oob } } : {}) });
      if (rev && revAt) {
        const approved = status !== 'REJECTED';
        events.push({ at: revAt, orgId: org, actorId: rev, actorName: name(rev), action: approved ? 'address.approved' : 'address.rejected', targetType: 'address', targetId: id, summary: `${approved ? '주소 확인 완료' : '주소 등록 거절'}: ${label}`, detail: note ? { reason: note } : {} });
      }
      if (status === 'DISABLED') events.push({ at: ago(days - 100), orgId: org, actorId: 'u-a-yoon', actorName: name('u-a-yoon'), action: 'address.disabled', targetType: 'address', targetId: id, summary: `주소 사용 중지: ${label}` });
    }

    // 주소 오염 예시(확인 대기): 정산 파트너 B(ab-02)의 주소와 앞 4자·뒤 6자가 같은 주소를 이메일 안내만 보고 등록한 상황.
    // ab-01을 본뜨면 ab-01 자신을 다시 점검할 때도 유사 주소가 잡혀 기존 검사(tests/address-protection.test.ts)와 어긋나므로 ab-02를 쓴다.
    // 점검 결과는 실제 등록 경로와 같은 checkAddress로 계산해 저장한다(등록 전에 계산하므로 자기 자신과는 비교하지 않는다).
    {
      const id = 'ab-13';
      const label = '정산 파트너 B (Kaia USDC, 변경 안내분)';
      const address = lookalikeOf(mockAddress('EVM', 'book:ab-02'), `book:${id}`, 4, 6);
      const { findings, normalized } = checkAddress(db, 'org-a', { assetCode: 'USDC', networkCode: 'KAIA', address, memo: '' });
      const matches = lookalikeMatchesOf(findings);
      const reason = '정산 파트너 B 담당자가 이메일로 입금 주소 변경을 안내해 등록합니다. 메신저로 주소 앞·뒤 글자를 확인했습니다.';
      // 다시 확인한 연락처가 주소를 보낸 이메일에 적힌 것이라, 확인 담당자가 기록을 보고 다시 확인해야 하는 예시다.
      const oob = { receivedVia: 'email', verifiedVia: 'other', verifiedWith: '변경 안내 이메일에 적힌 담당자 메신저 계정' };
      const at = ago(0, 7);
      ins('INSERT INTO address_book (id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at, check_findings, lookalike_reason, version, received_via, verified_via, verified_with) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, 'org-a', label, '모의 정산 파트너 B', 'USDC', 'KAIA', normalized, '', 'PENDING_REVIEW', 'u-a-kang', at, JSON.stringify(findings), matches.length ? reason : null, 1, oob.receivedVia, oob.verifiedVia, oob.verifiedWith);
      events.push({
        at, orgId: 'org-a', actorId: 'u-a-kang', actorName: name('u-a-kang'), action: 'address.created', targetType: 'address', targetId: id,
        summary: `주소 등록 요청: ${label} (USDC/KAIA)`,
        detail: {
          assetCode: 'USDC', networkCode: 'KAIA', addressTail: normalized.slice(-6), memoSet: false,
          warnings: findings.filter((f) => f.level === 'warning').map((f) => f.code),
          ruleVersion: LOOKALIKE_RULE_VERSION,
          lookalike: matches.map((m) => ({ id: m.id, label: m.label, status: m.status, prefix: m.prefix, suffix: m.suffix })),
          lookalikeReason: matches.length ? reason : null,
          outOfBand: oob,
        },
      });
    }

    // 사용 대기 예시: 26시간 전 등록, 2시간 전 두 번째 담당자 확인 → 기본 대기 24시간이 지나는 22시간 뒤부터 사용 가능.
    // 대기 시간은 config/policy.json addressBook.cooldownHours의 기본값(24, 설계 가정)과 같게 둔다. 실행 설정이 달라도 이 행은 바꾸지 않는다.
    {
      const id = 'ab-14';
      const label = '신규 거래처 L 정산 주소';
      const address = mockAddress('EVM', `book:${id}`);
      const { findings, normalized } = checkAddress(db, 'org-a', { assetCode: 'USDC', networkCode: 'ETHEREUM', address, memo: '' });
      const oob = { receivedVia: 'email', verifiedVia: 'registered_phone', verifiedWith: '모의 거래처 L 재무팀 대표번호(거래처 등록 연락처)' };
      const at = ago(1, 2);
      const revAt = ago(0, 2);
      const activeFrom = new Date(Date.parse(revAt) + SEED_COOLDOWN_HOURS * 3600_000).toISOString();
      ins('INSERT INTO address_book (id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at, reviewed_by, reviewed_at, review_note, version, check_findings, lookalike_reason, active_from, received_via, verified_via, verified_with) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, 'org-a', label, '모의 거래처 L', 'USDC', 'ETHEREUM', normalized, '', 'COOLING_DOWN', 'u-a-han', at, 'u-a-seo', revAt, null, 2, JSON.stringify(findings), null, activeFrom, oob.receivedVia, oob.verifiedVia, oob.verifiedWith);
      events.push({
        at, orgId: 'org-a', actorId: 'u-a-han', actorName: name('u-a-han'), action: 'address.created', targetType: 'address', targetId: id,
        summary: `주소 등록 요청: ${label} (USDC/ETHEREUM)`,
        detail: {
          assetCode: 'USDC', networkCode: 'ETHEREUM', addressTail: normalized.slice(-6), memoSet: false,
          warnings: findings.filter((f) => f.level === 'warning').map((f) => f.code),
          ruleVersion: LOOKALIKE_RULE_VERSION, lookalike: [], lookalikeReason: null, outOfBand: oob,
        },
      });
      events.push({
        at: revAt, orgId: 'org-a', actorId: 'u-a-seo', actorName: name('u-a-seo'), action: 'address.approved', targetType: 'address', targetId: id,
        summary: `주소 확인 완료: ${label} (사용 대기 ${SEED_COOLDOWN_HOURS}시간)`,
        detail: { ruleVersion: LOOKALIKE_RULE_VERSION, findings: findings.map((f) => f.code), lookalike: [], cooldown: { hours: SEED_COOLDOWN_HOURS, activeFrom } },
      });
    }

    // 출금 요청 (모의법인 A)
    type Req = [string, string, string, string, string, string, string, string, string, number, number, string | null, string | null];
    const reqs: Req[] = [
      // id, wallet, asset, network, amount, addr, purpose, status, createdBy, required, daysAgo, approver/rejecter, reason
      ['wr-1', 'w-a-eth', 'USDC', 'ETHEREUM', '50000', 'ab-01', '9월 거래소 매도 대금 이동 (모의)', 'COMPLETED', 'u-a-han', 1, 20, 'u-a-oh', null],
      ['wr-2', 'w-a-eth', 'ETH', 'ETHEREUM', '20', 'ab-05', '10월 운영비 정산 (모의)', 'REJECTED', 'u-a-kang', 1, 5, 'u-a-seo', '목적에 적힌 정산 건과 수량이 다릅니다. 정산서 확인 후 다시 요청하세요.'],
      ['wr-3', 'w-a-kaia', 'USDC', 'KAIA', '120000', 'ab-02', '4분기 파트너 정산 1차분 (모의)', 'PENDING_APPROVAL', 'u-a-han', 2, 1, null, null],
      ['wr-4', 'w-a-btc', 'BTC', 'BITCOIN', '0.5', 'ab-03', '그룹사 보관 자산 일부 이전 (모의)', 'PENDING_APPROVAL', 'u-a-kang', 1, 0.2, null, null],
      ['wr-5', 'w-a-xrp', 'XRP', 'XRPL', '5000', 'ab-04', '거래소 유동성 공급 (모의)', 'REVIEW', 'u-a-han', 1, 0.1, null, null],
      ['wr-6', 'w-a-kaia', 'KAIA', 'KAIA', '10000', 'ab-06', '파트너 프로젝트 지원금 (모의)', 'DRAFT', 'u-a-han', 1, 0.05, null, null],
    ];
    let n = 0;
    for (const [id, w, asset, net, amt, addr, purpose, status, by, reqd, days, decider, reason] of reqs) {
      n++;
      const ref = `WR-${String(n).padStart(6, '0')}`;
      const at = ago(days);
      const submitted = ['PENDING_APPROVAL', 'COMPLETED', 'REJECTED'].includes(status) ? ago(days, -1) : null;
      const done = ['COMPLETED', 'REJECTED'].includes(status) ? ago(days, -3) : null;
      const units = u(amt, asset);
      // 제출된 요청은 제출 시 평가액과 필요 승인 수의 근거를 함께 남긴다(실제 제출 경로와 같은 기준, 모의 시세).
      const krwAtSubmit = submitted ? krwValue(units, precision[asset]!, MOCK_KRW_PRICE[asset]!) : null;
      const basis = krwAtSubmit === null ? null : krwAtSubmit >= SEED_HIGH_VALUE_THRESHOLD_KRW ? 'value_at_or_above_threshold' : 'value_below_threshold';
      ins(`INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, required_approvals, created_by, created_at, updated_at, submitted_at, processing_started_at, completed_at, reject_reason, custody_ref, version, krw_value_at_submit, approval_basis, price_as_of_at_submit)
           VALUES (?, 'org-a', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, ref, w, asset, net, units, addr, purpose, status, reqd, by, at, done ?? submitted ?? at, submitted, status === 'COMPLETED' ? ago(days, -2) : null, done, reason, status === 'COMPLETED' ? 'MOCK-CUSTODY-SEED0001' : null, 3,
        krwAtSubmit?.toString() ?? null, basis, submitted);
      events.push({ at, orgId: 'org-a', actorId: by, actorName: name(by), action: 'request.created', targetType: 'request', targetId: id, summary: `${ref} 출금 요청 작성: ${amt} ${asset}` });
      if (status !== 'DRAFT') events.push({ at: ago(days, -0.5), orgId: 'org-a', actorId: by, actorName: name(by), action: 'request.reviewing', targetType: 'request', targetId: id, summary: `${ref} 검토 단계로 이동` });
      if (submitted) events.push({ at: submitted, orgId: 'org-a', actorId: by, actorName: name(by), action: 'request.submitted', targetType: 'request', targetId: id, summary: `${ref} 승인 요청 (필요 승인 ${reqd}명)`, detail: { requiredApprovals: reqd, approvalBasis: basis, krwValue: krwAtSubmit?.toString() ?? null, priceAsOf: submitted } });
      if (status === 'PENDING_APPROVAL') {
        const b = db.prepare('SELECT reserved_units FROM balances WHERE wallet_id = ? AND asset_code = ?').get(w, asset) as any;
        db.prepare('UPDATE balances SET reserved_units = ? WHERE wallet_id = ? AND asset_code = ?').run((BigInt(b.reserved_units) + BigInt(units)).toString(), w, asset);
      }
      if (status === 'COMPLETED' && decider) {
        ins("INSERT INTO approvals VALUES (?, ?, 'approved', NULL, ?)", id, decider, ago(days, -2));
        events.push({ at: ago(days, -2), orgId: 'org-a', actorId: decider, actorName: name(decider), action: 'request.approved', targetType: 'request', targetId: id, summary: `${ref} 승인 (1/1)` });
        events.push({ at: ago(days, -2), orgId: 'org-a', actorId: null, actorName: '모의 커스터디(개발용)', action: 'request.processing', targetType: 'request', targetId: id, summary: `${ref} 커스터디 처리 시작 (MOCK-CUSTODY-SEED0001)` });
        events.push({ at: done!, orgId: 'org-a', actorId: null, actorName: '모의 커스터디(개발용)', action: 'request.completed', targetType: 'request', targetId: id, summary: `${ref} 처리 완료 (모의)` });
      }
      if (status === 'REJECTED' && decider) {
        ins("INSERT INTO approvals VALUES (?, ?, 'rejected', ?, ?)", id, decider, reason, done);
        events.push({ at: done!, orgId: 'org-a', actorId: decider, actorName: name(decider), action: 'request.rejected', targetType: 'request', targetId: id, summary: `${ref} 반려`, detail: { reason } });
      }
    }

    // 거래 내역: 모의법인 A 138건(완료된 요청 1건, 주소 오염 예시 0원 입금 1건 포함), B 5건 — 탐색 검증용 가정이며 실제 사용량이 아니다.
    const TX_COLUMNS = 'id, org_id, wallet_id, type, asset_code, network_code, amount_units, counterparty, status, occurred_at, request_id, tx_ref';
    const r = rng(20261016);
    const pick = <T,>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)]!;
    const flows = [
      { w: 'w-a-eth', asset: 'USDC', net: 'ETHEREUM', min: 1000, max: 80000, dp: 2 },
      { w: 'w-a-kaia', asset: 'USDC', net: 'KAIA', min: 500, max: 30000, dp: 2 },
      { w: 'w-a-eth', asset: 'ETH', net: 'ETHEREUM', min: 0.5, max: 25, dp: 4 },
      { w: 'w-a-btc', asset: 'BTC', net: 'BITCOIN', min: 0.01, max: 1.2, dp: 6 },
      { w: 'w-a-kaia', asset: 'KAIA', net: 'KAIA', min: 1000, max: 90000, dp: 2 },
      { w: 'w-a-xrp', asset: 'XRP', net: 'XRPL', min: 100, max: 20000, dp: 2 },
    ] as const;
    const outLabels = ['모의 거래소 A 입금 (USDC)', '정산 파트너 B (Kaia USDC)', '운영비 정산 (ETH)', '그룹사 BTC 보관 이전용', '카이아 생태계 파트너', '모의 거래소 A 입금 (XRP)'];
    const inLabels = ['모의 거래소 A', '모의 그룹사 C', '외부 입금 (모의)', '모의 정산 파트너 B'];
    ins(`INSERT INTO transactions (${TX_COLUMNS}) VALUES ('tx-wr-1', 'org-a', 'w-a-eth', 'withdrawal', 'USDC', 'ETHEREUM', ?, '모의 거래소 A 입금 (USDC)', 'completed', ?, 'wr-1', 'MOCK-CUSTODY-SEED0001')`, u('50000', 'USDC'), ago(20, -3));
    for (let i = 0; i < 136; i++) {
      const f = pick(flows);
      const roll = r();
      const type = roll < 0.5 ? 'deposit' : roll < 0.85 ? 'withdrawal' : 'staking_reward';
      const isReward = type === 'staking_reward';
      const flow = isReward ? (r() < 0.5 ? flows[2] : flows[4]) : f;
      const raw = isReward ? (flow.asset === 'ETH' ? 0.01 + r() * 0.2 : 50 + r() * 800) : flow.min + r() * (flow.max - flow.min);
      const amount = raw.toFixed(flow.dp);
      // 실패는 출금에만 둔다(입금·보상은 실패로 기록하지 않는다). 난수는 예전과 같은 순서로 소비해 금액·시각을 유지한다.
      const failRoll = i === 3 || i === 9 ? null : r();
      const status = failRoll === null ? 'processing' : failRoll < 0.04 && type === 'withdrawal' ? 'failed' : 'completed';
      const occurred = ago(Math.floor(r() * 120), Math.floor(r() * 24));
      // 출금 상대방은 같은 자산·네트워크로 등록된 주소록 이름으로 정한다. 예전 순서를 지키려고 pick은 그대로 부르고 결과는 쓰지 않는다.
      if (type === 'withdrawal') pick(outLabels);
      const cp = type === 'deposit' ? pick(inLabels) : type === 'withdrawal' ? WITHDRAWAL_COUNTERPARTY[`${flow.asset}/${flow.net}`]! : '모의 검증인 보상';
      ins(`INSERT INTO transactions (${TX_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`, `tx-a-${String(i + 1).padStart(3, '0')}`, 'org-a', flow.w, type, flow.asset, flow.net, u(amount, flow.asset), cp, status, occurred, `MOCK-TX-A${String(i + 1).padStart(4, '0')}`);
    }
    for (let i = 0; i < 5; i++) {
      ins(`INSERT INTO transactions (${TX_COLUMNS}) VALUES (?, 'org-b', 'w-b-eth', 'deposit', ?, 'ETHEREUM', ?, '외부 입금 (모의)', 'completed', ?, NULL, ?)`, `tx-b-${i + 1}`, i % 2 ? 'ETH' : 'USDC', i % 2 ? u('2', 'ETH') : u('10000', 'USDC'), ago(10 + i * 7), `MOCK-TX-B${i + 1}`);
    }

    // 주소 오염 예시(0원 입금): 3일 전, 주소록 ab-07(해외 법인 결제 대행사, USDC/Ethereum, 사용 가능)과 고유부 앞 4자·뒤 6자가 같고
    // 가운데가 모두 다른 모의 주소가 0 USDC를 보냈다. 거래 내역에서 이 주소를 복사해 등록하면 ADDRESS_POISON_SUSPECTED로 막힌다.
    // ab-01·ab-02를 본뜨지 않는다(그 주소들의 유사 주소를 만드는 다른 검사와 겹치지 않게). 난수를 쓰지 않아 위 모의 값은 바뀌지 않는다.
    // id는 'tx-a-' 접두를 쓰지 않는다(tests/seed.test.ts가 그 접두의 무작위 행 136건을 그대로인지 확인한다).
    ins(`INSERT INTO transactions (${TX_COLUMNS}, counterparty_address) VALUES ('tx-dust-a1', 'org-a', 'w-a-eth', 'deposit', 'USDC', 'ETHEREUM', '0', '알 수 없는 보낸 주소 (모의)', 'completed', ?, NULL, 'MOCK-TX-DUST01', ?)`,
      ago(3), lookalikeOf(mockAddress('EVM', 'book:ab-07'), 'dust:ab-07', 4, 6));

    // 스테이킹 (모의법인 A만)
    ins("INSERT INTO staking_positions VALUES ('st-1', 'org-a', 'ETH', 'ETHEREUM', '모의 검증인 A', ?, ?, 'active', ?)", u('64', 'ETH'), u('0.182', 'ETH'), ago(140));
    ins("INSERT INTO staking_positions VALUES ('st-2', 'org-a', 'KAIA', 'KAIA', '모의 검증인 B', ?, ?, 'active', ?)", u('500000', 'KAIA'), u('2150.5', 'KAIA'), ago(100));
    ins("INSERT INTO staking_positions VALUES ('st-3', 'org-a', 'KAIA', 'KAIA', '모의 검증인 C', ?, ?, 'unbonding', ?)", u('100000', 'KAIA'), u('120', 'KAIA'), ago(60));

    // Market Insight: 모의 기관·모의 자료. 실제 리서치 기관의 자료가 아니다.
    ins("INSERT INTO insight_providers VALUES ('prov-a', '모의 리서치 A', 1, 'https://example.com/mock-research-a')");
    ins("INSERT INTO insight_providers VALUES ('prov-b', '모의 리서치 B', 1, 'https://example.com/mock-research-b')");
    ins("INSERT INTO insight_providers VALUES ('prov-c', '모의 리서치 C', 1, 'https://example.com/mock-research-c')");
    ins("INSERT INTO insight_providers VALUES ('prov-x', '모의 미등록 기관', 0, 'https://example.com/mock-unlisted')");
    // 요약은 모두 가상의 한 줄 설명이며 실제 리서치 내용을 옮긴 것이 아니다. 기관 이름·원문 링크도 모의 값이다.
    const topics: [string, 'ko' | 'en', string, string][] = [
      ['스테이블코인 결제 인프라의 구조', 'ko', 'USDC', '발행사·결제 대행사·수취 기관으로 이어지는 가상의 결제 흐름으로 정산 단계별 확인 항목을 정리했습니다.'],
      ['토큰화 증권 시장의 거래 구조', 'ko', '', '토큰화 증권의 발행·유통·결제 단계를 가상의 거래 사례로 나누어 참여 기관별 역할을 설명합니다.'],
      ['법인의 디지털 자산 회계 처리 쟁점', 'ko', '', '가상의 법인 사례로 디지털 자산의 취득·평가·처분 시점별 회계 처리 쟁점을 짚었습니다.'],
      ['Validator economics on proof-of-stake networks', 'en', 'ETH', '지분증명 네트워크에서 검증인의 보상과 운영 비용 구조를 개념 중심으로 비교했습니다.'],
      ['디지털 자산 커스터디 제도 비교', 'ko', '', '가상의 세 관할 제도를 예로 들어 수탁 기관의 분리 보관·보고 의무를 비교합니다.'],
      ['비트코인 현물 상품의 수급 구조', 'ko', 'BTC', '현물 상품의 설정·환매 과정이 수급에 영향을 주는 경로를 가상의 흐름도로 설명합니다.'],
      ['Stablecoin reserve disclosure practices', 'en', 'USDC', '준비금 공시를 읽을 때 확인할 구성·감사 주기·공시 시점을 점검표로 정리했습니다.'],
      ['카이아 생태계 개발 동향', 'ko', 'KAIA', '생태계 동향을 볼 때 함께 확인할 개발·이용 지표를 가상의 예시로 소개합니다.'],
      ['가상자산 과세 제도 주요 쟁점', 'ko', '', '법인이 과세 시점과 평가 방법을 검토할 때 던질 질문을 가상의 사례로 묶었습니다.'],
      ['Cross-border settlement with tokenized deposits', 'en', 'XRP', '토큰화 예금으로 국가 간 정산을 하는 과정을 가상의 두 은행 사례로 단계별 설명합니다.'],
      ['오송금·주소 사기 유형 정리', 'ko', '', '앞·뒤만 같은 주소, 네트워크 착오, 메모 누락 같은 오송금 유형을 가상의 사례로 분류했습니다.'],
      ['스테이킹 보상의 회계·세무 처리', 'ko', 'ETH', '스테이킹 보상을 언제 어떤 기준으로 인식할지에 대한 쟁점을 가상의 법인 사례로 정리했습니다.'],
      ['Market liquidity during high-volatility weeks', 'en', 'BTC', '변동성이 큰 기간에 호가 깊이와 체결 비용을 살피는 지표를 개념 중심으로 소개합니다.'],
      ['기관 투자자 디지털 자산 운용 현황', 'ko', '', '가상의 기관 세 곳을 예로 들어 운용 정책·한도·보고 체계를 비교합니다.'],
      ['토큰 언락 일정과 가격 변동성', 'ko', '', '언락 일정이 공개되는 방식과 확인할 출처를 가상의 토큰 사례로 정리했습니다.'],
      ['Layer-2 networks and settlement risk', 'en', 'ETH', '레이어2의 출금 대기 기간과 브리지 구조가 정산 위험에 주는 영향을 개념 중심으로 설명합니다.'],
      ['국내 디지털 자산 제도 변화 요약', 'ko', '', '제도 변화가 법인의 보관·보고·내부 통제 실무에 주는 영향을 가상의 일정표로 정리했습니다.'],
      ['XRP Ledger 결제 활용 사례', 'ko', 'XRP', '데스티네이션 태그를 쓰는 입금 흐름을 가상의 거래소 사례로 설명합니다.'],
      ['On-chain analytics for treasury teams', 'en', '', '재무팀이 온체인 기록으로 입출금 내역을 대사하는 절차를 가상의 예시로 보여 줍니다.'],
      ['디지털 자산 보안 사고 사례 연구', 'ko', '', '권한 관리와 서명 절차가 허술할 때 생길 수 있는 가상의 사고 시나리오와 점검 항목을 담았습니다.'],
      ['스테이블코인 발행 구조 비교', 'ko', 'USDC', '담보 방식이 다른 가상의 스테이블코인 세 종류를 발행·상환 절차 중심으로 비교합니다.'],
      ['ETF flows and spot market depth', 'en', 'BTC', '상품 자금 흐름과 현물 호가 깊이를 함께 볼 때의 해석 방법을 개념 중심으로 설명합니다.'],
      ['법인 지갑 권한 분리 모범 사례', 'ko', '', '요청·승인·감사 권한을 나누는 방법을 가상의 조직도로 예시합니다.'],
      ['디지털 자산 시장 월간 정리', 'ko', '', '한 달 동안의 가상 시장 사건을 주제별로 묶고 함께 볼 지표를 정리한 예시 자료입니다.'],
    ];
    const provs = ['prov-a', 'prov-b', 'prov-c'];
    topics.forEach(([title, lang, tag, summary], i) => {
      const id = `ins-${String(i + 1).padStart(2, '0')}`;
      const pub = ago(i * 4 + 1).slice(0, 10);
      ins("INSERT INTO insights VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', 'u-k-op', ?)", id, provs[i % 3], title, `${summary} (모의 요약)`, lang, pub, `https://example.com/mock-research/${id}`, tag, ago(i * 4));
    });
    ins("INSERT INTO insights VALUES ('ins-h1', 'prov-a', '운영자가 숨긴 자료', '운영자가 게시를 멈춘 가상의 자료로, 고객 화면에는 보이지 않습니다. (모의 요약)', 'ko', ?, 'https://example.com/mock-research/ins-h1', '', 'hidden', 'u-k-op', ?)", ago(3).slice(0, 10), ago(3));
    ins("INSERT INTO insights VALUES ('ins-x1', 'prov-x', '화이트리스트 외 기관 자료', '화이트리스트에 없는 가상 기관의 자료로, 고객 화면에는 보이지 않습니다. (모의 요약)', 'ko', ?, 'https://example.com/mock-research/ins-x1', '', 'published', 'u-k-op', ?)", ago(2).slice(0, 10), ago(2));

    for (const [id, org, nm, , , roles] of users) {
      events.push({ at: created, orgId: org, actorId: null, actorName: '시스템(초기 설정)', action: 'member.roles_changed', targetType: 'user', targetId: id, summary: `${nm} 초기 역할 부여: ${roles.join(', ')}` });
    }
    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    for (const e of events) writeAudit(db, e);
  });
}