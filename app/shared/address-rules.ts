// 개발 환경 주소 규칙. 실제 네트워크 주소 형식이 아니라 "MOCK-" 접두의 모의 형식만 허용한다.
// 네트워크별 실제 형식·체크섬 검증 어댑터는 아직 구현되지 않았다(docs/operations.md '주소 검증' 참고).
// 아래 기준(유사 주소 판정, 가운데 8자리 재입력, 소액 입금 기준·비교 기간)은 설계 가정이며 KODA가 확정한 정책이 아니다.
import { parseUnits } from './decimal.ts';

export type AddressFamily = 'MOCK_BTC' | 'MOCK_EVM' | 'MOCK_XRP';

/** 유사 주소 판정 규칙 버전. 저장된 점검 결과·감사 기록에 함께 남긴다. */
export const LOOKALIKE_RULE_VERSION = 'lookalike-v2';
/** 등록·확인 때 원본을 보고 다시 입력하는 가운데 글자 수 */
export const CONFIRM_MIDDLE_LENGTH = 8;
/** 유사 주소 경고에 담는 최대 일치 건수 */
export const LOOKALIKE_MAX_MATCHES = 3;
/** XRP Ledger 데스티네이션 태그: 0 ~ 4294967295(부호 없는 32비트 정수). 화면·서버가 같은 규칙을 쓴다. */
export const XRPL_TAG_PATTERN = /^(?:[0-9]{1,9}|[1-3][0-9]{9}|4[0-1][0-9]{8}|42[0-8][0-9]{7}|429[0-3][0-9]{6}|4294[0-8][0-9]{5}|42949[0-5][0-9]{4}|429496[0-6][0-9]{3}|4294967[0-1][0-9]{2}|42949672[0-8][0-9]|429496729[0-5])$/;

export const FAMILY_RULES: Record<AddressFamily, { pattern: RegExp; example: string; caseInsensitive: boolean; label: string }> = {
  MOCK_BTC: { pattern: /^MOCK-BTC-[A-Z2-7]{20,40}$/, example: 'MOCK-BTC-ABCDEFGHJKLMNPQRSTUV', caseInsensitive: false, label: 'Bitcoin 모의 형식' },
  MOCK_EVM: { pattern: /^MOCK-EVM-[0-9A-Fa-f]{40}$/, example: 'MOCK-EVM-0000000000000000000000000000000000000000', caseInsensitive: true, label: 'EVM 계열 모의 형식' },
  MOCK_XRP: { pattern: /^MOCK-XRP-[A-Z2-7]{20,34}$/, example: 'MOCK-XRP-ABCDEFGHJKLMNPQRSTUV', caseInsensitive: false, label: 'XRP Ledger 모의 형식' },
};

export interface NetworkRule {
  code: string;
  name: string;
  family: AddressFamily;
  memoRequired: boolean;
  memoLabel: string | null;
  memoPattern: RegExp | null;
}

export type FindingLevel = 'error' | 'warning' | 'info';
/** 유사 주소 경고에 붙는 기존 주소 정보(같은 조직 주소록 기준) */
export interface LookalikeFindingMatch {
  id: string;
  label: string;
  status: string;
  address: string;
  prefix: number;
  suffix: number;
}
/** 주소 오염 의심 점검에 걸린 최근 소액 입금(같은 조직 거래 내역 기준). 보낸 주소 전체는 담지 않는다. */
export interface DustFindingMatch {
  txRef: string;
  occurredAt: string;
  assetCode: string;
  networkCode: string;
  /** 표시용 수량(예: "0") */
  amount: string;
  /** 비슷한 주소일 때만: 고유부 앞·뒤에서 같은 글자 수 */
  prefix?: number;
  suffix?: number;
}
export interface Finding {
  code: string;
  level: FindingLevel;
  message: string;
  action?: string;
  /** 화면이 요청할 때만 쓰는 부가 정보. 기본 표시(Findings)는 message·action만 쓴다. */
  data?: { matches?: LookalikeFindingMatch[]; dust?: DustFindingMatch[] };
}

export function normalizeAddress(address: string, family: AddressFamily): string {
  const t = address.trim();
  return FAMILY_RULES[family].caseInsensitive ? t.toUpperCase() : t;
}

export function detectFamily(address: string): AddressFamily | null {
  const t = address.trim();
  for (const [fam, rule] of Object.entries(FAMILY_RULES) as [AddressFamily, (typeof FAMILY_RULES)[AddressFamily]][]) {
    if (rule.pattern.test(t)) return fam;
  }
  return null;
}

/** 형식 점검. 소유자·안전성은 확인하지 않는다. */
export function checkAddressFormat(
  input: { address: string; memo?: string | null },
  network: NetworkRule,
  allNetworks: NetworkRule[],
): Finding[] {
  const findings: Finding[] = [];
  const raw = input.address ?? '';
  const address = raw.trim();
  if (!address) {
    findings.push({ code: 'ADDRESS_REQUIRED', level: 'error', message: '주소를 입력하세요.', action: '받는 곳에서 받은 주소를 복사해 붙여 넣으세요.' });
    return findings;
  }
  if (/\s/.test(address)) {
    findings.push({ code: 'ADDRESS_WHITESPACE', level: 'error', message: '주소 중간에 공백이나 줄바꿈이 있습니다.', action: '주소를 다시 복사해 붙여 넣으세요. 일부만 복사되었을 수 있습니다.' });
    return findings;
  }
  const rule = FAMILY_RULES[network.family];
  if (!rule.pattern.test(address)) {
    const detected = detectFamily(address);
    const owners = detected ? allNetworks.filter((n) => n.family === detected).map((n) => n.name) : [];
    findings.push({
      code: 'ADDRESS_NETWORK_MISMATCH',
      level: 'error',
      message: detected
        ? `입력한 주소는 ${network.name} 형식이 아닙니다. ${owners.join('·')} 네트워크 주소 형식으로 보입니다.`
        : `입력한 주소가 ${network.name} 주소 형식과 맞지 않습니다.`,
      action: '받는 곳에 자산과 네트워크를 다시 확인하세요. 네트워크를 잘못 선택해 보내면 회수가 어려울 수 있습니다.',
    });
  } else {
    const sharing = allNetworks.filter((n) => n.family === network.family && n.code !== network.code);
    if (sharing.length > 0) {
      findings.push({
        code: 'ADDRESS_SHARED_FORMAT',
        level: 'warning',
        message: `${[network.name, ...sharing.map((n) => n.name)].join('·')}은(는) 같은 주소 형식을 씁니다. 형식만으로는 네트워크를 구분할 수 없습니다.`,
        action: `받는 곳이 ${network.name} 네트워크로 받을 수 있는지 직접 확인하세요.`,
      });
    }
  }
  const memo = (input.memo ?? '').trim();
  if (network.memoRequired) {
    if (!memo) {
      findings.push({ code: 'MEMO_REQUIRED', level: 'error', message: `${network.name}에서는 ${network.memoLabel ?? '메모'}가 필요합니다.`, action: `받는 곳에서 안내한 ${network.memoLabel ?? '메모'}를 입력하세요. 개인 지갑처럼 필요 없는 곳이라면 받는 곳에 확인하세요.` });
    } else if (network.memoPattern && !network.memoPattern.test(memo)) {
      findings.push({ code: 'MEMO_FORMAT', level: 'error', message: `${network.memoLabel ?? '메모'} 형식이 올바르지 않습니다.`, action: '0 ~ 4294967295 사이의 숫자만 입력하세요(최대 10자리).' });
    }
  } else if (memo) {
    findings.push({ code: 'MEMO_NOT_USED', level: 'warning', message: `${network.name}은(는) 메모를 쓰지 않습니다. 입력한 값은 전송에 쓰이지 않습니다.`, action: '받는 곳이 다른 네트워크를 안내했는지 확인하세요.' });
  }
  findings.push({
    code: 'NOT_OWNERSHIP_VERIFIED',
    level: 'info',
    message: '형식 점검은 주소의 주인이나 안전성을 확인하지 않습니다.',
    action: '주소는 문서·이메일만 믿지 말고 받는 곳과 별도 연락 수단으로 가운데를 포함한 전체 글자를 대조하세요.',
  });
  return findings;
}

/** 비교용 고유부: MOCK-<계열>- 접두를 떼고 대문자로 맞춘다. */
export function addressBody(address: string): string {
  return address.trim().replace(/^MOCK-[A-Z]+-/, '').toUpperCase();
}

/**
 * 유사 주소 판정(lookalike-v2): 고유부의 앞·뒤가 같고 가운데가 다른 주소.
 * 앞·뒤 각각 4자 이상 같거나, 앞+뒤 합이 8자 이상 같으면 일치로 본다.
 * 고유부가 완전히 같으면 null(같은 주소는 중복 점검이 다룬다). 앞·뒤 글자 수는 서로 겹쳐 세지 않는다.
 */
export function lookalikeMatch(a: string, b: string): { prefix: number; suffix: number } | null {
  const x = addressBody(a);
  const y = addressBody(b);
  if (x === y || x.length < 10 || y.length < 10) return null;
  const max = Math.min(x.length, y.length);
  let prefix = 0;
  while (prefix < max && x[prefix] === y[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && x[x.length - 1 - suffix] === y[y.length - 1 - suffix]) suffix++;
  if ((prefix >= 4 && suffix >= 4) || prefix + suffix >= 8) return { prefix, suffix };
  return null;
}

/** 이전 규칙(앞 6자·뒤 4자)과 호환되는 판정. lookalikeMatch의 상위 집합이므로 기존 일치는 계속 일치한다. */
export function isLookalike(a: string, b: string): boolean {
  return lookalikeMatch(a, b) !== null;
}

/**
 * 고유부 가운데 8자. start·end는 화면 안내용 1부터 세는 위치(양 끝 포함).
 * 앞·뒤만 맞춘 가짜 주소는 가운데가 다르므로, 원본을 보고 이 부분을 다시 입력하게 한다.
 */
export function middleSegment(address: string): { text: string; start: number; end: number } {
  const body = address.trim().replace(/^MOCK-[A-Z]+-/, '');
  const len = Math.min(CONFIRM_MIDDLE_LENGTH, body.length);
  const from = Math.max(0, Math.floor((body.length - CONFIRM_MIDDLE_LENGTH) / 2));
  return { text: body.slice(from, from + len), start: from + 1, end: from + len };
}

/**
 * 주소 오염(0원·소액 입금) 비교 기간. 주소 등록 점검은 최근 이 기간의 입금만 본다(설계 가정).
 */
export const POISON_LOOKBACK_DAYS = 90;

/**
 * 소액(더스트) 입금 기준(설계 가정, KODA 정책 아님). 수량이 0이거나 이 값보다 작은 입금을
 * 주소 오염 공격에서 자주 보이는 입금으로 본다. 목록에 없는 자산은 0인 입금만 해당한다.
 */
export const DUST_THRESHOLD: Readonly<Record<string, string>> = {
  BTC: '0.00001',
  ETH: '0.00001',
  USDC: '0.01',
  KAIA: '0.01',
  XRP: '0.01',
};

/** 입금 수량(최소 단위)이 소액 기준에 해당하는지. 0 이하이면 항상 해당한다. */
export function isDustAmount(units: bigint | string, precision: number, assetCode: string): boolean {
  const u = typeof units === 'string' ? BigInt(units) : units;
  if (u <= 0n) return true;
  const t = DUST_THRESHOLD[assetCode];
  if (!t) return false;
  return u < parseUnits(t, precision);
}

/** 같은 주소인지(접두·대소문자 무시). 모의 형식은 고유부를 대문자로 비교한다. */
export function sameAddress(a: string, b: string): boolean {
  const x = a.trim().toUpperCase();
  const y = b.trim().toUpperCase();
  return x.length > 0 && x === y;
}

/** 육안 대조용으로 4자씩 묶는다. */
export function chunkAddress(address: string): string[] {
  const m = address.match(/^(MOCK-[A-Z]+-)(.*)$/);
  const prefix = m ? m[1]! : '';
  const body = m ? m[2]! : address;
  const chunks = body.match(/.{1,4}/g) ?? [];
  return prefix ? [prefix.replace(/-$/, ''), ...chunks] : chunks;
}
