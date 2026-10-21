// 화면·서버 오류 메시지에서 같은 용어를 쓰기 위한 단일 출처.

export type RequestStatus =
  | 'DRAFT' | 'REVIEW' | 'PENDING_APPROVAL' | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'FAILED';

export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

/**
 * 요청 상태. label·tone·step은 화면·서버 메시지·E2E가 함께 쓰는 값이라 바꾸지 않는다(tests/glossary.test.ts).
 * turn: 지금 누구 차례인지 알려 주는 짧은 표시용 문구(A1). 서버는 쓰지 않으며, 끝난 상태는 빈 문자열이다.
 */
export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone; description: string; step: number; turn: string }> = {
  DRAFT: { label: '작성 중', tone: 'neutral', step: 0, turn: '요청자 작성 중', description: '요청자가 내용을 작성하고 있습니다. 아직 승인자에게 전달되지 않았습니다.' },
  REVIEW: { label: '검토 중', tone: 'info', step: 1, turn: '요청자 최종 확인 중', description: '요청자가 받는 주소와 수량을 최종 대조하는 단계입니다. 확인을 마치면 승인 요청을 보냅니다.' },
  PENDING_APPROVAL: { label: '승인 대기', tone: 'warning', step: 2, turn: '승인자 결정 대기', description: '요청자가 아닌 승인자의 승인을 기다립니다. 출금 수량은 예약되어 다른 요청에 쓸 수 없습니다.' },
  PROCESSING: { label: '처리 중', tone: 'info', step: 3, turn: '수탁사 처리 중', description: '승인이 끝나 수탁사(KODA)가 처리하는 단계입니다. 이 환경에서는 모의 커스터디가 처리합니다. 이 단계부터는 취소할 수 없습니다.' },
  COMPLETED: { label: '처리 완료', tone: 'success', step: 3, turn: '', description: '모의 커스터디가 처리 완료를 알린 상태입니다. 블록체인 확정을 완료 기준으로 삼을지는 KODA와 정할 항목입니다. 블록체인 전송은 되돌릴 수 없습니다.' },
  REJECTED: { label: '반려', tone: 'danger', step: 3, turn: '', description: '승인자가 반려했습니다. 반려 사유를 확인하고 필요하면 새 요청을 작성하세요.' },
  CANCELLED: { label: '취소', tone: 'neutral', step: 3, turn: '', description: '요청자가 취소했습니다. 예약된 수량은 해제되었습니다.' },
  FAILED: { label: '처리 실패', tone: 'danger', step: 3, turn: '', description: '처리 중 문제가 생겨 완료되지 않았습니다. 예약 수량은 해제되었습니다. 실패 사유를 확인하세요.' },
};

export const REQUEST_STEPS = ['작성', '검토', '승인 대기', '처리 결과'] as const;

export type AddressStatus = 'PENDING_REVIEW' | 'COOLING_DOWN' | 'ACTIVE' | 'REJECTED' | 'DISABLED';
export const ADDRESS_STATUS: Record<AddressStatus, { label: string; tone: Tone; description: string }> = {
  PENDING_REVIEW: { label: '확인 대기', tone: 'warning', description: '등록자가 아닌 다른 담당자의 확인을 기다립니다. 확인 전에는 출금 요청에 쓸 수 없습니다.' },
  COOLING_DOWN: { label: '사용 대기', tone: 'info', description: '두 사람의 확인을 마쳤고, 정해진 대기 시간이 지나면 출금 요청에 쓸 수 있습니다. 요청하지 않은 등록이면 대기 중에 바로 정지하세요.' },
  ACTIVE: { label: '사용 가능', tone: 'success', description: '두 사람이 입력 내용을 확인했습니다. 주소의 소유자나 안전성을 보증하는 표시는 아닙니다.' },
  REJECTED: { label: '등록 거절', tone: 'danger', description: '확인 담당자가 등록을 거절했습니다. 사유를 확인하고 다시 등록하세요.' },
  DISABLED: { label: '사용 중지', tone: 'neutral', description: '더 이상 출금 요청에 쓸 수 없는 주소입니다. 이 주소로 가는 승인 대기 요청은 승인할 수 없고, 반려하거나 취소해야 예약 수량이 풀립니다.' },
};

/**
 * 주소를 받은 경로 / 다시 확인한 경로(다른 경로 확인 기록). 두 값이 같으면 다른 경로로 확인한 것으로 보지 않는다.
 * 선택지는 설계 가정이며 KODA가 정한 확인 절차가 아니다.
 */
export type ReceivedVia = 'email' | 'messenger' | 'document' | 'phone' | 'in_person' | 'other';
export type VerifiedVia = 'registered_phone' | 'in_person' | 'video_call' | 'signed_document' | 'other';
export const RECEIVED_VIA: Record<ReceivedVia, string> = {
  email: '이메일',
  messenger: '메신저',
  document: '문서(공문·인보이스)',
  phone: '전화',
  in_person: '직접 만나서',
  other: '기타',
};
export const VERIFIED_VIA: Record<VerifiedVia, string> = {
  registered_phone: '미리 등록된 연락처로 전화',
  in_person: '직접 만나서',
  video_call: '영상 통화',
  signed_document: '서명·날인된 문서',
  other: '기타',
};
export const RECEIVED_VIA_VALUES = Object.keys(RECEIVED_VIA) as [ReceivedVia, ...ReceivedVia[]];
export const VERIFIED_VIA_VALUES = Object.keys(VERIFIED_VIA) as [VerifiedVia, ...VerifiedVia[]];

export type Role = 'admin' | 'requester' | 'approver' | 'auditor' | 'operator';
export const ROLE_LABEL: Record<Role, { label: string; description: string }> = {
  requester: { label: '자산 담당자', description: '주소 등록과 출금 요청을 작성합니다.' },
  approver: { label: '승인자', description: '다른 사람이 만든 요청과 주소를 확인하고 승인하거나 반려합니다.' },
  auditor: { label: '감사 담당자', description: '모든 기록을 조회하고 감사 기록을 내보냅니다. 변경 권한은 없습니다.' },
  admin: { label: '조직 관리자', description: '구성원과 역할을 관리합니다.' },
  operator: { label: 'KODA 운영자', description: 'Market Insight 자료를 선별해 게시합니다.' },
};

/**
 * 출금 전 점검(검토 단계와 승인 화면에 함께 보이는 항목). 점검은 보내도 되는지 판정하지 않고, 무엇을 어떤 기준으로 보았는지만 알린다.
 * - pass(기준 이내): 정한 기준을 넘지 않았다는 뜻일 뿐 받는 곳이나 전송을 보증하지 않는다. 녹색을 쓰지 않는다.
 * - caution(주의): 기준을 넘었다. 사유가 필요한 항목은 요청자가 진행 사유를 남겨야 승인 요청을 보낼 수 있다.
 * - unknown(확인 불가): 자료가 없거나 오래되어 판단하지 못했다. 기준 이내로 보이지 않게 주의와 같은 색을 쓴다.
 */
export type CheckOutcome = 'pass' | 'caution' | 'unknown';
export type CheckId = 'first_use' | 'amount_history' | 'balance_share' | 'recent_burst' | 'price';
export interface RequestCheck {
  id: CheckId;
  /** 한 줄 판정 문장(예: '이 대시보드로 처음 보내는 주소입니다') */
  label: string;
  outcome: CheckOutcome;
  /** 이번 요청에서 본 값과 권하는 행동 */
  detail: string;
  /** 판정 기준과 자료 범위. 기준값은 설계 가정이다 */
  basis: string;
  /** 주의일 때 요청자의 진행 사유(글자·숫자 5자 이상)가 있어야 승인 요청을 보낼 수 있는지 */
  requiresReason: boolean;
  /** 제출 때 저장한 요청자 사유. 제출 전이거나 남기지 않았으면 null */
  reason?: string | null;
}
export const CHECK_OUTCOME: Record<CheckOutcome, { label: string; tone: Tone }> = {
  pass: { label: '기준 이내', tone: 'neutral' },
  caution: { label: '주의', tone: 'warning' },
  unknown: { label: '확인 불가', tone: 'warning' },
};
/** 진행 사유 최소 글자 수. 보이지 않는 서식 문자를 빼고 글자·숫자만 센다(shared/schemas.ts letterDigitCount). */
export const CHECK_REASON_MIN_LENGTH = 5;

/** 감사 기록의 행동 이름. 감사 기록 화면과 CSV 내보내기가 함께 쓴다. 없는 코드는 코드 그대로 보인다. */
export const ACTION_LABEL: Record<string, string> = {
  'auth.login': '로그인', 'auth.logout': '로그아웃',
  'address.created': '주소 등록 요청', 'address.findings_updated': '주소 점검 결과 갱신', 'address.activated': '주소 사용 시작', 'address.cooldown_stopped': '사용 대기 중 정지', 'address.approved': '주소 확인', 'address.rejected': '주소 거절', 'address.disabled': '주소 사용 중지',
  'request.created': '요청 작성', 'request.updated': '요청 수정', 'request.reviewing': '검토 이동', 'request.back_to_draft': '작성으로 되돌림',
  'request.submitted': '승인 요청', 'request.approved': '승인', 'request.rejected': '반려', 'request.cancelled': '취소',
  'request.processing': '처리 시작', 'request.completed': '처리 완료', 'request.failed': '처리 실패',
  // 승인 단계(approve)와 커스터디 전달 직전(handoff) 모두에 쓴다. 어느 단계였는지는 내용(summary)에 있다.
  'request.intent_tampered': '승인 대상 지문 불일치로 중단',
  // 승인·반려 본문의 지문이 제출 때 고정한 지문과 달라 결정을 받지 않았다(409 INTENT_CHANGED). 승인인지 반려인지는 내용(summary)에 있다.
  'request.intent_mismatch': '승인 대상 지문이 달라 결정 거부',
  'member.roles_changed': '역할 변경', 'audit.exported': '감사 기록 내보내기', 'insight.published': '리서치 게시', 'insight.hidden': '리서치 숨김',
};
export const actionLabel = (action: string) => ACTION_LABEL[action] ?? action;

export const TX_TYPE: Record<string, string> = {
  deposit: '입금',
  withdrawal: '출금',
  staking_reward: '스테이킹 보상',
};

export const TX_STATUS: Record<string, { label: string; tone: Tone }> = {
  completed: { label: '완료', tone: 'success' },
  processing: { label: '처리 중', tone: 'info' },
  failed: { label: '실패', tone: 'danger' },
};

/**
 * 용어 설명(화면 Term 버튼과 문서가 함께 쓰는 단일 출처).
 * 팀 용어집(수탁·화이트리스트·스테이킹·비가역적 이전 등)을 바탕으로 이 화면에 맞게 다시 쓴 설명이다.
 * 확인되지 않은 규제 시행일·기준 금액은 넣지 않는다. 안전을 보장하는 표현을 쓰지 않는다(tests/glossary.test.ts).
 */
export type GlossaryKey =
  | 'network' | 'memo' | 'reserved' | 'available' | 'valuation'
  | 'custody' | 'whitelist' | 'staking' | 'validator' | 'unbonding' | 'destinationTag' | 'irreversible' | 'approvalCount' | 'token';

/** 화면에 보이는 용어 이름 */
export const GLOSSARY_LABEL: Record<GlossaryKey, string> = {
  network: '네트워크',
  memo: '메모/태그',
  reserved: '예약 수량',
  available: '사용 가능',
  valuation: '평가액',
  custody: '커스터디 처리',
  whitelist: '화이트리스트',
  staking: '스테이킹',
  validator: '검증인',
  unbonding: '해제 대기',
  destinationTag: '데스티네이션 태그',
  irreversible: '되돌릴 수 없는 전송',
  approvalCount: '승인 x/y',
  token: '토큰과 자산',
};

export const GLOSSARY: Record<GlossaryKey, string> = {
  network: '자산이 오가는 블록체인입니다. 같은 자산이라도 네트워크가 다르면 받는 쪽에서 찾지 못해 회수가 어려울 수 있습니다.',
  memo: '거래소 등 하나의 주소를 여러 고객이 함께 쓰는 곳에서 받는 사람을 구분하는 값입니다. 요구하는 곳에 빠뜨리면 입금이 확인되지 않을 수 있습니다.',
  reserved: '승인 대기·처리 중인 출금 요청에 묶여 있는 수량입니다. 요청이 반려·취소되거나 처리에 실패하면 다시 사용할 수 있습니다.',
  available: '보유 수량에서 예약 수량을 뺀, 새 요청에 쓸 수 있는 수량입니다.',
  valuation: '모의 시세로 계산한 참고용 원화 평가액입니다. 실제 매도 가능 금액이 아닙니다.',
  custody: '커스터디(수탁)는 고객 대신 디지털 자산을 보관하고, 옮길 때 승인 절차와 기록까지 관리하는 일입니다. 커스터디 처리는 회사 안 승인이 끝난 출금을 수탁사가 넘겨받아 처리하는 단계입니다. 이 환경에서는 모의 커스터디가 처리하며 실제 전송은 일어나지 않습니다.',
  whitelist: '미리 검토해 등록한 대상만 허용하는 목록입니다. 출금에서는 확인을 마친 주소록 주소로만 보낼 수 있게 하는 규칙이고, Market Insight에서는 게시를 허용한 리서치 기관 목록입니다. 목록에 있다고 안전이 보장되지는 않습니다.',
  staking: '자산을 블록체인 네트워크에 맡겨 운영에 참여하고 보상을 받는 일입니다. 예금 이자와 비슷해 보이지만 원리와 위험이 다르며, 맡긴 동안에는 자산이 묶여 바로 출금할 수 없습니다.',
  validator: '스테이킹한 자산으로 네트워크 운영(거래 확인·기록)에 참여하는 운영 주체입니다. 규칙을 어긴 검증인에게 맡긴 자산 일부가 삭감되는 네트워크도 있어, 어느 검증인을 쓰는지가 보상과 위험에 영향을 줍니다.',
  unbonding: '스테이킹을 끝내기로 요청한 뒤 네트워크가 정한 기간이 지나기를 기다리는 상태입니다. 이 기간에는 출금할 수 없으며, 기간은 네트워크마다 다릅니다.',
  destinationTag: 'XRP Ledger에서 거래소처럼 여러 고객이 한 주소를 함께 쓰는 곳이 누구의 입금인지 구분하는 번호입니다. 0부터 4294967295 사이의 숫자이며, 요구하는 곳에 빠뜨리면 입금이 반영되지 않을 수 있습니다.',
  irreversible: '블록체인 전송은 한 번 실행되면 시스템이 되돌려 주지 않습니다. 잘못 보낸 자산은 받은 쪽이 따로 돌려줘야만 되찾을 수 있으므로, 보내기 전에 주소·네트워크·수량을 대조합니다.',
  approvalCount: 'x는 지금 승인 권한이 있는 사람이 남긴 승인 수, y는 이 요청에 필요한 승인 수입니다. 승인한 뒤 권한을 잃었거나 비활성화된 사람의 승인은 세지 않으며, 요청자 본인은 승인할 수 없습니다. 결정이 끝난 요청은 결정 당시의 승인 수를 그대로 보여 줍니다.',
  token: '이 화면의 토큰은 다른 화면의 자산과 같은 대상을 뜻합니다. 비트코인처럼 네트워크 고유의 자산(코인)과 USDC처럼 네트워크 위에서 발행된 토큰을 모두 포함합니다.',
};

// ---------------------------------------------------------------------------
// A2: 승인할 수 있는 사람·대기 시간, 결정 근거, 감사 기록 내보내기 표지
// ---------------------------------------------------------------------------

/** 승인할 수 있는 사람. 이름만 담는다(이메일·직함 없음). 구성원 이름은 조직 관리(org.read)에서도 보이는 정보다. */
export interface ApproverRef { id: string; name: string }

/**
 * 승인 대기 요청을 지금 누가 승인할 수 있는지(A2-1, 표시용). 정족수·승인 가능 여부는 서버의 승인 처리가 정한다.
 * - candidates: 같은 조직의 활성 사용자 가운데 지금 역할에 출금 승인 권한이 있는 사람. 작성자와 이미 결정(승인·반려)한 사람은 뺀다. 이름순.
 * - remaining: 필요한 승인 수 − 지금 정족수에 든 승인 수(0 이상)
 * - shortfall: candidates가 remaining보다 적음(이대로는 정족수를 채울 수 없음)
 * 승인 대기가 아니거나 승인할 수 없는 요청(blockedReason, 지문 기록 전 요청)은 null이다.
 */
export interface ApprovalWait { candidates: ApproverRef[]; remaining: number; shortfall: boolean }

export const APPROVAL_WAIT_TEXT = {
  /** 요청 상세 '다음 할 일'·홈(내가 후보일 때)의 이름 줄 머리 */
  candidates: '승인할 수 있는 사람',
  /** 홈 진행 중 요청(내가 후보가 아닐 때)의 둘째 줄 머리 */
  othersTurn: '다른 사람 차례',
  /** 후보가 0명일 때(홈 둘째 줄 머리) */
  nobody: '승인할 수 있는 사람 없음',
  /** 조회자 본인 */
  me: '나',
} as const;

/** 남은 승인을 채울 사람이 모자랄 때의 경고(요청 상세). 0명이면 따로 쓴다. */
export function approvalShortfallText(remaining: number, candidates: number): string {
  return candidates === 0
    ? '지금 승인할 수 있는 사람이 없습니다. 조직 관리자에게 승인자 추가를 요청하세요.'
    : `남은 승인 ${remaining}명을 채울 수 있는 사람이 ${candidates}명뿐입니다. 조직 관리자에게 승인자 추가를 요청하세요.`;
}

/**
 * 승인 후보 이름 목록. 조회자 본인은 '나'로 바꿔 맨 앞에 두고, 나머지는 서버 순서(이름순) 그대로다.
 * max명을 넘으면 '외 n명'으로 줄인다. 후보가 없으면 빈 문자열.
 */
export function approverNames(candidates: ApproverRef[], meId: string, sep: string, max = Number.POSITIVE_INFINITY): string {
  const mine = candidates.some((c) => c.id === meId);
  const names = [...(mine ? [APPROVAL_WAIT_TEXT.me] : []), ...candidates.filter((c) => c.id !== meId).map((c) => c.name)];
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return shown.join(sep) + (rest > 0 ? ` 외 ${rest}명` : '');
}

/**
 * 승인·반려 표 하나의 결정 근거(A2-3). 읽을 때 계산하는 값이며 저장하지 않는다(해시 대상 아님).
 * - intentHashDisplay: 그 사람이 결정할 때 본 승인 대상 지문(표시용 16자). 이 기능 도입 전 표는 null
 * - matchesRequestIntent: 표의 지문이 요청 지문과 같은지. 표 지문이 없으면 null
 * - counted: 정족수에 들어갔는지(승인 대기 중에는 지금 역할로 다시 판단, 결정이 끝난 요청은 결정 당시 목록). 반려 표는 false
 * - rolesAtDecision: 결정 시각 이전의 마지막 역할 변경 기록(member.roles_changed)의 바뀐 뒤 역할. 기록이 없거나 형식이 다르면 null.
 *   역할 변경 기록은 감사 기록 조회 권한(audit.read)으로만 보이므로, 그 권한이 없는 조회자에게는 늘 null이다.
 * - rolesSource: rolesAtDecision이 있으면 'role_history'(역할 변경 기록 기준), 없으면 null
 * - approveRoleAtDecision: rolesAtDecision에 지금 권한표 기준 출금 승인 권한이 있는지. rolesAtDecision이 null이면 null
 */
export interface DecisionEvidence {
  userId: string;
  name: string;
  decision: 'approved' | 'rejected';
  decidedAt: string;
  intentHashDisplay: string | null;
  matchesRequestIntent: boolean | null;
  counted: boolean;
  rolesAtDecision: Role[] | null;
  rolesSource: 'role_history' | null;
  approveRoleAtDecision: boolean | null;
}

/** 결정 근거 한 줄의 조각. tone은 화면 색(흐린 글자·위험·경고)이며 CSV에서는 글자만 쓴다. */
export type EvidencePart = { text: string; tone: 'muted' | 'danger' | 'warning' };

/**
 * 결정 근거 문구(화면 처리 기록·감사 기록 화면·감사 CSV가 함께 쓴다). '확인됨' 같은 보장 말 대신 출처('역할 변경 기록 기준')를 쓴다.
 * showRoles: 결정 당시 역할을 쓸지(감사 기록 조회 권한이 있는 화면·CSV). 없으면 역할 조각을 빼고 경고도 쓰지 않는다.
 */
export function decisionEvidenceParts(e: DecisionEvidence, opts: { showRoles: boolean }): EvidencePart[] {
  const parts: EvidencePart[] = [];
  if (opts.showRoles) {
    parts.push({
      tone: 'muted',
      text: e.rolesAtDecision
        ? `결정 당시 역할: ${e.rolesAtDecision.length ? e.rolesAtDecision.map((r) => ROLE_LABEL[r].label).join(', ') : '없음'}(역할 변경 기록 기준)`
        : '결정 당시 역할: 역할 변경 기록 없음',
    });
  }
  if (e.decision === 'approved') parts.push({ tone: 'muted', text: e.counted ? '정족수 포함' : '정족수에 들지 않음' });
  if (!e.intentHashDisplay) parts.push({ tone: 'muted', text: '지문 기록 없음(이 기능 도입 전 결정)' });
  else if (e.matchesRequestIntent === false) parts.push({ tone: 'danger', text: `결정한 지문 ${e.intentHashDisplay}(요청 지문과 다름)` });
  else parts.push({ tone: 'muted', text: `결정한 지문 ${e.intentHashDisplay}(요청 지문과 같음)` });
  if (opts.showRoles && e.approveRoleAtDecision === false) parts.push({ tone: 'warning', text: '역할 변경 기록상 이때 승인 권한이 없습니다 — 기록을 확인하세요' });
  return parts;
}

export function decisionEvidenceText(e: DecisionEvidence, opts: { showRoles: boolean }): string {
  return decisionEvidenceParts(e, opts).map((p) => p.text).join(' · ');
}

/**
 * 감사 기록 해시 연결 확인 문장(A1 문장 그대로). 감사 기록 화면과 CSV 표지가 함께 쓴다.
 * '빠짐없이'·'변조 없음'처럼 완전함을 말하는 표현은 쓰지 않는다.
 */
export const AUDIT_INTEGRITY_TEXT = {
  ok: (count: number) => `기록 ${count}건이 각각 바로 앞 기록과 끊김 없이 이어져 있습니다(해시 연결 확인).`,
  broken: (no: number | null) => `${no ?? '?'}번 기록에서 해시가 맞지 않습니다. 보안 담당자에게 알리세요.`,
  /** 확인 범위(한계). where: 보관용 값이 이 문장의 위('위')에 있는지 아래('아래')에 있는지 */
  scope: (where: '위' | '아래') => `단, 가장 최근 기록을 지웠거나 기록을 고친 뒤 뒤쪽 해시를 모두 다시 계산했다면 이 확인으로는 찾지 못합니다. ${where} 보관용 값(기록 건수·마지막 기록 해시)을 앱 밖에 적어 두었다가 다음 확인 때 대조하세요.`,
  anchor: (count: number, headHash: string) => `기록 ${count}건 · 마지막 기록 해시 ${headHash}`,
} as const;

/** 감사 기록 CSV 표지(A2-4). 표지는 내보낼 때 만든 설명이며 저장하지 않는다(해시 대상 아님). */
export const AUDIT_EXPORT_TEXT = {
  coverTitle: 'KODA 감사 기록 내보내기 표지 — 내보낼 때 만든 설명이며 감사 기록이 아닙니다(해시 대상 아님)',
  coverNote: '표지와 결정 근거 열은 내보낼 때 계산한 값입니다. 아래 표의 각 행과 해시 열은 저장된 기록 그대로입니다.',
  evidenceColumn: '결정 근거(내보낼 때 계산)',
  /** 감사 기록 화면의 내보내기 버튼 아래 안내(내보내기 권한이 있을 때만) */
  screenHint: '내보낸 파일 맨 위에 기간·조건·내보낸 사람·시각·해시 연결 확인 결과를 담은 표지가 붙습니다.',
} as const;
