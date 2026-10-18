// 개발 환경 주소 규칙. 실제 네트워크 주소 형식이 아니라 "MOCK-" 접두의 모의 형식만 허용한다.
// 운영 환경에서는 server/adapters/address-validator.ts의 어댑터를 실제 규칙으로 교체해야 한다.

export type AddressFamily = 'MOCK_BTC' | 'MOCK_EVM' | 'MOCK_XRP';

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
export interface Finding {
  code: string;
  level: FindingLevel;
  message: string;
  action?: string;
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
      findings.push({ code: 'MEMO_FORMAT', level: 'error', message: `${network.memoLabel ?? '메모'} 형식이 올바르지 않습니다.`, action: '숫자만 입력하세요(최대 10자리).' });
    }
  } else if (memo) {
    findings.push({ code: 'MEMO_NOT_USED', level: 'warning', message: `${network.name}은(는) 메모를 쓰지 않습니다. 입력한 값은 전송에 쓰이지 않습니다.`, action: '받는 곳이 다른 네트워크를 안내했는지 확인하세요.' });
  }
  findings.push({
    code: 'NOT_OWNERSHIP_VERIFIED',
    level: 'info',
    message: '형식 점검은 주소의 주인이나 안전성을 확인하지 않습니다.',
    action: '주소는 문서·이메일만 믿지 말고 받는 곳과 별도 연락 수단으로 앞·뒤 글자를 대조하세요.',
  });
  return findings;
}

/** 주소의 고유 부분(접두 제외) 앞 6자·뒤 4자가 같고 전체는 다른 주소 → 유사 주소 의심 */
export function isLookalike(a: string, b: string): boolean {
  if (a === b) return false;
  const body = (s: string) => s.replace(/^MOCK-[A-Z]+-/, '').toUpperCase();
  const x = body(a);
  const y = body(b);
  if (x === y || x.length < 10 || y.length < 10) return false;
  return x.slice(0, 6) === y.slice(0, 6) && x.slice(-4) === y.slice(-4);
}

/** 육안 대조용으로 4자씩 묶는다. */
export function chunkAddress(address: string): string[] {
  const m = address.match(/^(MOCK-[A-Z]+-)(.*)$/);
  const prefix = m ? m[1]! : '';
  const body = m ? m[2]! : address;
  const chunks = body.match(/.{1,4}/g) ?? [];
  return prefix ? [prefix.replace(/-$/, ''), ...chunks] : chunks;
}
