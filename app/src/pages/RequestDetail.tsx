import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newIdemKey } from '../api.ts';
import { useMe, type Me } from '../auth.tsx';
import { AddressStrip, ApiErrorNotice, Badge, DataStamp, ErrorState, Field, Loading, Notice, PageHeader, StatusRail, TextareaAuto, WaitedTime } from '../components/ui.tsx';
import { DecisionEvidenceLine } from '../components/DecisionEvidence.tsx';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { useFocusFirstError } from '../lib/forms.ts';
import { useUnsavedGuard } from '../lib/unsaved.tsx';
import { CheckList, IntentFingerprint, krwThreshold, RequestForm, type RequestFormValue } from '../components/RequestForm.tsx';
import { PaymentEvidenceEditor, PaymentEvidenceView } from '../components/PaymentEvidence.tsx';
import { amount, date, dateTime, krw, krwShort } from '../format.ts';
import { krwValue } from '../../shared/decimal.ts';
import {
  ADDRESS_STATUS, APPROVAL_WAIT_TEXT, approvalShortfallText, approverNames, PAYMENT_EVIDENCE_TEXT, REQUEST_STATUS,
  type AddressStatus, type ApprovalWait, type DecisionEvidenceView, type RequestCheck, type RequestStatus,
} from '../../shared/terms.ts';
import type { PaymentEvidence } from '../../shared/attachments.ts';

/** 요청 응답의 출금 전 점검: 작성·검토 중이면 지금 기준(stored=false), 승인 요청 뒤에는 제출 때 저장한 결과(stored=true). 기록이 없는 이전 요청은 null. */
type ChecksView = { evaluatedAt: string; stored: boolean; items: RequestCheck[] } | null;

/** 지문·점검 관련 409 오류는 화면을 새로 고치는 것만으로 풀리지 않으므로 서버가 준 행동 안내를 그대로 보인다. */
const INTENT_CODES = new Set(['INTENT_CHANGED', 'INTENT_TAMPERED', 'INTENT_MISSING']);

/** 저장된 출금 전 점검이 없는 요청(점검 기록 도입 전 요청, 시드의 처리 완료·반려 요청)에 보이는 문장 */
const NO_STORED_CHECKS = '이 요청에는 저장된 출금 전 점검 결과가 없습니다.';

/** 승인 전 확인 세 항목의 처음 상태(모두 확인 안 함). 409를 받으면 이 상태로 되돌린다. */
const NO_CHECKS = { counterparty: false, amount: false, address: false };

/** 몇 번째 승인인지(0부터 센 승인 수를 받아): '첫 번째', '두 번째' … 다섯을 넘으면 숫자로 쓴다. */
const ORD = ['첫', '두', '세', '네', '다섯'];
const ordinal = (i: number) => (ORD[i] ? `${ORD[i]} 번째` : `${i + 1}번째`);

type RoleKey = 'requester' | 'approver' | 'other';

const NEXT_FOR_ROLE: Record<string, Record<RoleKey, string>> = {
  // 이 대시보드는 알림을 보내지 않는다(A1): 알려 준다고 약속하지 않고, 어디에 나타나는지만 쓴다.
  DRAFT: { requester: '내용을 확인하고 「검토로 이동」을 누르세요.', approver: "요청자가 작성 중입니다. 승인 요청이 오면 '지금 처리할 일'과 「내가 승인할 요청」에 표시됩니다. 알림은 보내지 않습니다.", other: '요청자가 작성 중입니다.' },
  // REVIEW 요청자 문구는 끝자리 길이에 따라 nextAction()에서 만든다.
  REVIEW: { requester: '', approver: '요청자가 최종 검토 중입니다.', other: '요청자가 최종 검토 중입니다.' },
  PENDING_APPROVAL: { requester: '승인자의 결정을 기다리는 중입니다. 알림이 가지 않으니 승인자에게 직접 알려 주세요. 요청을 취소할 수도 있습니다.', approver: '받는 곳·주소·수량·목적을 확인하고 승인하거나 사유와 함께 반려하세요.', other: '승인자의 결정을 기다리는 중입니다.' },
  PROCESSING: { requester: '수탁사 처리 중입니다(이 환경은 모의 커스터디). 더 할 일은 없습니다.', approver: '수탁사 처리 중입니다(이 환경은 모의 커스터디).', other: '수탁사 처리 중입니다(이 환경은 모의 커스터디).' },
  COMPLETED: { requester: '처리가 끝났습니다. 받는 곳에 입금 확인을 요청하세요.', approver: '처리가 끝났습니다.', other: '처리가 끝났습니다.' },
  REJECTED: { requester: '반려 사유를 확인하고 필요하면 새 요청을 작성하세요.', approver: '반려된 요청입니다.', other: '반려된 요청입니다.' },
  CANCELLED: { requester: '취소된 요청입니다.', approver: '취소된 요청입니다.', other: '취소된 요청입니다.' },
  FAILED: { requester: '실패 사유를 확인하세요. 예약 수량은 해제되었습니다.', approver: '처리에 실패한 요청입니다.', other: '처리에 실패한 요청입니다.' },
};

/**
 * 작성·검토 중 요청의 받는 주소를 지금 쓸 수 없는지(받는 주소 상태 기준). 승인 요청 뒤의 승인 불가 사유(blockedReason)와 따로 본다.
 * - stopped: 사용 중지·등록 거절. 기다려도 쓸 수 없으므로 다른 주소로 바꾸거나 요청을 취소해야 한다.
 * - waiting: 사용 대기·확인 대기. 사용 가능해지면 진행할 수 있다.
 */
export function addressHold(r: { status: string; address: { status: string } }): 'stopped' | 'waiting' | null {
  if (!['DRAFT', 'REVIEW'].includes(r.status) || r.address.status === 'ACTIVE') return null;
  return r.address.status === 'COOLING_DOWN' || r.address.status === 'PENDING_REVIEW' ? 'waiting' : 'stopped';
}

/**
 * 작성·검토 중 요청의 저장된 수량을 읽을 수 없는지(서버가 amount를 null로 준다. 앱을 거치지 않은 저장 계층 변경 등, A-30).
 * 이때 서버는 검토 이동·승인 요청을 허용 행동에서 빼고 직접 보내도 422 AMOUNT_UNREADABLE로 거부한다. 내용 수정에서 수량을 다시 입력하거나 취소해야 한다.
 */
export function amountUnreadable(r: { status: string; amount: string | null }): boolean {
  return ['DRAFT', 'REVIEW'].includes(r.status) && r.amount === null;
}

/**
 * 받는 주소를 쓸 수 없을 때 요청자에게 보이는 안내(제목: 이유, 본문: 무엇이 막히는지). 할 일은 「다음 할 일」(nextAction)에 쓴다.
 * 아직 승인 요청 전이라 예약된 수량은 없다(예약은 승인 요청 때 잡는다).
 */
function holdNotice(r: any, hold: 'stopped' | 'waiting'): { title: string; body: string } {
  const unreserved = '아직 승인 요청 전이라 예약된 수량은 없습니다.';
  if (hold === 'stopped') {
    const rejected = r.address.status === 'REJECTED';
    return {
      title: rejected ? '받는 주소의 등록이 거절되어 이 요청을 진행할 수 없습니다' : '받는 주소가 사용 중지되어 이 요청을 진행할 수 없습니다',
      body: `${rejected ? '등록이 거절된' : '사용 중지된'} 주소로는 검토로 이동하거나 승인 요청을 보낼 수 없습니다. ${unreserved}`,
    };
  }
  return {
    title: r.address.status === 'COOLING_DOWN' ? '받는 주소가 사용 대기 중이라 아직 진행할 수 없습니다' : '받는 주소가 확인 대기 중이라 아직 진행할 수 없습니다',
    body: `받는 주소가 사용 가능해지기 전에는 검토로 이동하거나 승인 요청을 보낼 수 없습니다. ${unreserved}`,
  };
}

function nextAction(r: any, role: RoleKey, tailLength: number, canReject: boolean, reasonPrefilled: boolean, decided = false): string {
  // 승인할 수 없는 이유는 아래 안내에 쓰고, 여기에는 할 일만 쓴다(안내 제목과 같은 문장을 되풀이하지 않는다).
  if (r.blockedReason === 'INTENT_TAMPERED') {
    if (role === 'requester') return '이 요청을 취소하고 보안 담당자에게 알리세요. 같은 출금이 필요하면 내용을 확인해 새 요청을 작성하세요.';
    if (role === 'approver' && canReject) return reasonPrefilled ? '미리 채운 반려 사유를 확인하고 반려한 뒤 보안 담당자에게 알리세요.' : '사유와 함께 반려한 뒤 보안 담당자에게 알리세요.';
    return '요청자의 취소나 승인자의 반려를 기다리는 중입니다.';
  }
  if (r.blockedReason === 'ADDRESS_NOT_ACTIVE') {
    if (role === 'requester') return '이 요청을 취소하세요. 같은 출금이 필요하면 사용 가능한 주소로 새 요청을 작성하세요.';
    if (role === 'approver' && canReject) return reasonPrefilled ? '미리 채운 반려 사유를 확인하고 반려하세요.' : '반려 사유를 확인하고 반려하세요.';
    // 감사 담당자나 이미 결정한 승인자: 할 일이 없다. 무엇을 기다리는지만 쓴다.
    return '요청자의 취소나 승인자의 반려를 기다리는 중입니다.';
  }
  // 작성·검토 중인데 저장된 수량을 읽을 수 없다: 「검토로 이동」·승인 요청이 거부되므로 수량을 다시 입력하거나 취소하라고 안내한다.
  if (amountUnreadable(r) && role === 'requester') {
    return r.status === 'DRAFT' ? '「내용 수정」에서 수량을 다시 입력하거나 요청을 취소하세요.' : '「작성 단계로 되돌리기」를 누른 뒤 「내용 수정」에서 수량을 다시 입력하거나 요청을 취소하세요.';
  }
  // 작성·검토 중인데 받는 주소를 쓸 수 없다: 「검토로 이동」·승인 요청이 거부되므로 주소를 바꾸거나 취소하라고 안내한다.
  const hold = addressHold(r);
  if (hold && role === 'requester') {
    if (hold === 'stopped') return r.status === 'DRAFT' ? '「내용 수정」에서 사용 가능한 다른 받는 주소를 고르거나 요청을 취소하세요.' : '「작성 단계로 되돌리기」를 누른 뒤 사용 가능한 다른 받는 주소를 고르거나 요청을 취소하세요.';
    return '받는 주소가 사용 가능해질 때까지 기다리세요. 기다리지 않으려면 다른 받는 주소로 바꾸거나 요청을 취소하세요.';
  }
  // 이미 결정한 승인자: 승인·반려를 다시 하라고 하지 않는다.
  if (decided && role === 'approver' && r.status === 'PENDING_APPROVAL') return '내 결정을 마쳤습니다. 다른 승인자의 결정을 기다리는 중입니다.';
  // 출금 요청 제출 때는 끝자리를 다시 입력한다(가운데 8자리 재입력은 주소 등록·확인 단계의 규칙). 눈으로는 가운데까지 대조하게 한다.
  if (r.status === 'REVIEW' && role === 'requester') return `받는 주소를 가운데 묶음까지 원본과 대조하고, 끝 ${tailLength}자리를 입력해 승인 요청을 보내세요.`;
  return NEXT_FOR_ROLE[r.status]![role];
}

/** 필요 승인 수의 근거(설계 가정). 제출 전에는 지금 시세로 예상한 값을 보여 준다. */
function basisText(r: any, policy: Me['policy']['approval'], projected: { krw: bigint | null; state: string } | null): string {
  const threshold = krwThreshold(policy.highValueThresholdKrw);
  const highN = Math.max(policy.highValueRequiredApprovals, policy.defaultRequiredApprovals);
  const n = r.requiredApprovals;
  switch (r.approvalBasis) {
    case 'value_at_or_above_threshold': return `원화 평가액이 ${threshold} 이상이라 서로 다른 승인자 ${n}명이 필요합니다.`;
    case 'value_below_threshold': return `원화 평가액이 ${threshold} 미만이라 승인 ${n}명이 필요합니다.`;
    case 'price_missing': return `시세를 확인할 수 없어(없음) 승인 ${n}명이 필요합니다.`;
    case 'price_stale': return `시세를 확인할 수 없어(지연) 승인 ${n}명이 필요합니다.`;
  }
  const rule = `원화 평가액 ${threshold} 이상이면 ${highN}명, 미만이면 ${policy.defaultRequiredApprovals}명이며 시세가 없거나 지연되면 ${highN}명입니다.`;
  if (!projected) return rule;
  const usable = projected.krw !== null && projected.state === 'mock';
  const expected = !usable || projected.krw! >= BigInt(policy.highValueThresholdKrw) ? highN : policy.defaultRequiredApprovals;
  return `승인 요청을 보낼 때의 시세로 정합니다. 지금 모의 시세로는 승인 ${expected}명이 필요합니다. ${rule}`;
}

/**
 * 작성 중(또는 다른 사람이 보는 검토 중) 요청의 읽기 전용 점검 목록 안내. 받는 주소를 쓸 수 없으면(hold) 그 상황에 맞춘다.
 * - 사용 중지·등록 거절(stopped): 이 주소로는 진행할 수 없으므로 검토·승인 요청 단계를 말하지 않고, 주소를 바꾸면 다시 점검한다고 알린다.
 * - 사용 대기·확인 대기(waiting): 주소가 사용 가능해진 뒤 승인 요청 때 사유를 적는다고 알린다.
 */
function checksIntro(mine: boolean, hold: 'stopped' | 'waiting' | null, items: RequestCheck[]): string {
  const needsReason = items.some((c) => c.requiresReason);
  if (mine && hold === 'stopped') return '지금 받는 주소로 점검한 결과입니다. 이 주소로는 진행할 수 없으며, 다른 받는 주소로 바꾸면 그 주소로 다시 점검합니다.';
  if (mine && needsReason) {
    return hold === 'waiting'
      ? '「사유 필요」 표시가 있는 주의 항목은 받는 주소가 사용 가능해진 뒤 승인 요청을 보낼 때 진행 사유를 적어야 합니다.'
      : '「사유 필요」 표시가 있는 주의 항목은 검토로 이동한 뒤 진행 사유를 적어야 승인 요청을 보낼 수 있습니다.';
  }
  return '지금 기준으로 점검한 결과입니다. 승인 요청 때 다시 점검해 그 결과를 승인자에게 보입니다.';
}

export function RequestDetailPage() {
  const { id } = useParams();
  const me = useMe();
  const loc = useLocation() as { state?: { back?: string; created?: boolean } };
  const back = loc.state?.back ?? '/requests';
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['request', id],
    queryFn: () => api(`/api/requests/${id}`),
    refetchInterval: (query) => (query.state.data?.status === 'PROCESSING' ? 2000 : 15_000),
  });
  // 제출 전(작성·검토 중) 요청의 평가액은 지금 모의 시세로 계산한다. 제출된 요청은 제출 시 저장한 값을 쓴다.
  const preSubmit = !!q.data && ['DRAFT', 'REVIEW'].includes(q.data.status);
  const bal = useQuery({ queryKey: ['balances'], queryFn: () => api('/api/balances'), enabled: preSubmit });
  // 결정 카드의 '주소록 기록' 한 줄(A1): 이미 있는 주소 조회로 등록·확인한 사람과 날짜를 보인다. 못 불러오면 주소 기록 링크만 둔다.
  const decideNow = !!q.data && ['approve', 'reject'].some((a) => q.data.allowedActions.includes(a));
  const addrRecord = useQuery({ queryKey: ['address', q.data?.address.id], queryFn: () => api(`/api/addresses/${q.data.address.id}`), enabled: decideNow, staleTime: 60_000, retry: false });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<RequestFormValue | null>(null);
  const [original, setOriginal] = useState<RequestFormValue | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const editRef = useRef<HTMLFormElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const [tail, setTail] = useState('');
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState('');
  // 승인할 수 없는 요청(승인 요청 뒤 내용이 바뀜, 받는 주소 사용 중지)에는 반려 사유를 미리 채워 둔다. 제안 그대로면 작성 중으로 보지 않는다.
  const suggestion = !q.data?.allowedActions.includes('reject') ? null
    : q.data.blockedReason === 'INTENT_TAMPERED'
      ? { text: `승인 요청 뒤 요청 내용이 승인 대상 지문(${q.data.intentHashDisplay ?? '기록'})과 맞지 않아 승인할 수 없으므로 반려합니다. 요청 내용을 확인하고 필요하면 새 요청을 작성해 주세요.`, button: '지문 불일치 사유로 바꾸기' }
      : q.data.blockedReason === 'ADDRESS_NOT_ACTIVE'
        ? { text: `받는 곳 '${q.data.address.label}'의 주소가 사용 중지되어 승인할 수 없으므로 반려합니다. 사용 가능한 주소로 새 요청을 작성해 주세요.`, button: '주소 사용 중지 사유로 바꾸기' }
        : null;
  const suggestedReason = suggestion?.text ?? '';
  // reasonSeed: 입력란에 넣은 제안(사용자가 고치지 않았으면 reason과 같다). reasonOffered: 마지막으로 처리한 제안.
  const [reasonSeed, setReasonSeed] = useState('');
  const [reasonOffered, setReasonOffered] = useState('');
  useEffect(() => {
    if (!suggestedReason || suggestedReason === reasonOffered) return;
    setReasonOffered(suggestedReason);
    // 승인자가 직접 쓴 사유는 덮어쓰지 않는다(주기적 새로 고침 중에 요청이 승인 불가로 바뀌어도). 비었거나 앞서 넣은 제안 그대로일 때만 채운다.
    if (reason.trim() === '' || reason === reasonSeed) { setReason(suggestedReason); setReasonSeed(suggestedReason); }
  }, [suggestedReason, reasonOffered, reason, reasonSeed]);
  const reasonPrefilled = !!suggestedReason && reason === suggestedReason;
  const [checked, setChecked] = useState(NO_CHECKS);
  // 출금 전 점검의 진행 사유(점검 항목 id → 사유). 승인 요청을 보내면 비운다.
  const [checkReasons, setCheckReasons] = useState<Record<string, string>>({});
  // 방금 승인 요청을 보냈는지: 요청자에게 승인 대상 지문을 알려 주는 안내를 한 번 보인다.
  const [justSubmitted, setJustSubmitted] = useState(false);
  // 방금 승인·반려했는지와 그 결과(응답 기준): 결정 카드가 사라진 자리 대신 화면 위쪽에 결과 안내를 보이고 포커스를 옮긴다.
  const [justDecided, setJustDecided] = useState<null | { action: 'approve' | 'reject'; status: string; approved: number; required: number }>(null);
  // 방금 단계를 옮겼거나(검토로 이동·작성 단계로 되돌리기) 작성 내용을 저장했는지(횟수). 누른 버튼이 사라지므로 「다음 할 일」로 포커스를 옮긴다.
  const [stepMoved, setStepMoved] = useState(0);
  // 지급 근거(A2b): 메모 입력값과 파일을 올리는 중인지. 편집 카드가 아니라 이 화면이 갖고 작성 중 보호 하나에 합친다(「내용 수정」 중에도 입력값을 지킨다).
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  // 같은 화면에서 다른 요청으로 이동하면 앞 요청의 사유·안내를 남기지 않는다.
  useEffect(() => { setCheckReasons({}); setJustSubmitted(false); setJustDecided(null); setStepMoved(0); setNoteDraft(null); }, [id]);
  // 승인 요청 등으로 지급 근거를 더 고칠 수 없게 되면 저장하지 않은 메모 입력값을 버린다(남겨 두면 떠날 때마다 경고가 뜬다).
  const evidenceEditable = !!q.data?.paymentEvidence?.canEdit;
  useEffect(() => { if (!evidenceEditable) setNoteDraft(null); }, [evidenceEditable]);
  const idem = useRef<Record<string, string>>({});
  const keyFor = (action: string) => (idem.current[action] ??= newIdemKey());

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['request', id] });
    qc.invalidateQueries({ queryKey: ['requests'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['balances'] });
  };
  // 409(먼저 바뀜·지문 불일치)나 받는 주소 상태 변경(ADDRESS_NOT_ACTIVE), 제출 때 새로 생긴 주의 항목(CHECK_REASON_REQUIRED), 읽을 수 없는 저장 수량(AMOUNT_UNREADABLE)이면
  // 최신 상태를 다시 불러와 화면을 맞춘다. 오류 안내와 입력은 그대로 두되, 409이면 승인 전 확인 표시는 지운다
  // (다시 불러온 내용을 보고 다시 확인해야 승인할 수 있게. 확인 표시가 남아 있으면 바뀐 내용을 보지 않고 한 번에 승인될 수 있다).
  const reloadOnStale = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) setChecked(NO_CHECKS);
    if (e instanceof ApiError && (e.status === 409 || e.code === 'ADDRESS_NOT_ACTIVE' || e.code === 'CHECK_REASON_REQUIRED' || e.code === 'AMOUNT_UNREADABLE')) qc.invalidateQueries({ queryKey: ['request', id] });
  };
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body: Record<string, unknown> }) =>
      api(`/api/requests/${id}/${action}`, { method: 'POST', body: { version: q.data.version, ...body }, idempotencyKey: keyFor(`${action}:${q.data.version}`) }),
    onSuccess: (data, vars) => {
      qc.setQueryData(['request', id], data); refresh(); setEditing(false); setReason(''); setTail('');
      if (vars.action === 'submit') { setCheckReasons({}); setJustSubmitted(true); }
      if (vars.action === 'review' || vars.action === 'back-to-draft') setStepMoved((x) => x + 1);
      if (vars.action === 'approve' || vars.action === 'reject') {
        setJustDecided({ action: vars.action, status: data.status, approved: data.approvedCount, required: data.requiredApprovals });
      }
    },
    onError: reloadOnStale,
  });
  const cancelM = useMutation({
    mutationFn: () => api(`/api/requests/${id}/cancel`, { method: 'POST', body: { version: q.data.version }, idempotencyKey: keyFor(`cancel:${q.data.version}`) }),
    onSuccess: (data) => { qc.setQueryData(['request', id], data); refresh(); setConfirmCancel(false); },
    onError: (e) => { if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: ['request', id] }); },
  });
  const save = useMutation({
    mutationFn: () => api(`/api/requests/${id}`, { method: 'PUT', body: { ...form, version: q.data.version } }),
    onSuccess: (data) => { qc.setQueryData(['request', id], data); refresh(); setEditing(false); setForm(null); setOriginal(null); setStepMoved((x) => x + 1); },
  });
  useFocusFirstError(editRef, save.error);
  useFocusFirstError(actionRef, act.error);
  // 409(지문 불일치·먼저 바뀜)는 입력 필드 오류가 없어 위 포커스 이동이 일어나지 않는다. 안내 자체로 포커스를 옮기고 화면 안으로 가져온다.
  // 안내는 확인 카드가 있으면 카드 안 결정 버튼 바로 위에, 카드가 사라지면(다른 사람이 먼저 처리) 화면 위쪽에 보이므로 위치가 바뀔 때도 다시 옮긴다.
  const conflictRef = useRef<HTMLDivElement>(null);
  const conflictErr = act.error instanceof ApiError && act.error.status === 409 ? act.error : null;
  const actionCardNow = !!q.data && ['submit', 'approve', 'reject'].some((a) => q.data.allowedActions.includes(a));
  useEffect(() => {
    if (!conflictErr) return;
    const raf = requestAnimationFrame(() => {
      const el = conflictRef.current;
      if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'center' }); }
    });
    return () => cancelAnimationFrame(raf);
  }, [conflictErr, actionCardNow]);
  // 승인 요청을 보낸 직후: 확인 카드가 사라진 자리에서 화면 위쪽의 지문 안내로 포커스를 옮긴다(요청자가 지문을 보고 승인자와 대조할 수 있게).
  const submittedRef = useRef<HTMLDivElement>(null);
  const showSubmitted = justSubmitted && !!q.data && q.data.createdBy.id === me.user.id && q.data.status === 'PENDING_APPROVAL' && !!q.data.intentHashDisplay;
  useEffect(() => {
    if (!showSubmitted) return;
    const raf = requestAnimationFrame(() => {
      const el = submittedRef.current;
      if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'center' }); }
    });
    return () => cancelAnimationFrame(raf);
  }, [showSubmitted]);
  // 승인·반려 직후: 결정 카드(누른 버튼)가 사라지므로 화면 위쪽의 결과 안내로 포커스를 옮기고 화면 안으로 가져온다.
  const decidedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!justDecided) return;
    const raf = requestAnimationFrame(() => {
      const el = decidedRef.current;
      if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'center' }); }
    });
    return () => cancelAnimationFrame(raf);
  }, [justDecided]);
  // 검토로 이동·작성 단계로 되돌리기·작성 내용 저장 직후: 누른 버튼(또는 수정 양식)이 사라지므로 바뀐 「다음 할 일」로 포커스를 옮긴다.
  // 키보드·화면 낭독기 사용자가 바뀐 단계와 할 일을 바로 듣고, 다음 버튼(예: 「내용 수정」)을 찾으러 문서 처음부터 다시 오지 않게 한다.
  const nextRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!stepMoved) return;
    const raf = requestAnimationFrame(() => {
      const el = nextRef.current;
      if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
    });
    return () => cancelAnimationFrame(raf);
  }, [stepMoved]);
  // 확인 카드가 없는 화면(작성 중 「검토로 이동」, 되돌리기 등)의 처리 오류: 버튼 줄 바로 위에 보이고 그 안내로 포커스를 옮긴다.
  // 카드가 있으면 카드 안 결정 버튼 위에 보인다(아래 actNotice). 409는 conflictNotice가 따로 맡는다.
  const actErrorNow = act.error && !(act.error instanceof ApiError && act.error.status === 409) ? act.error : null;
  const actTopRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!actErrorNow || actionCardNow) return;
    const raf = requestAnimationFrame(() => {
      const el = actTopRef.current;
      if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'center' }); }
    });
    return () => cancelAnimationFrame(raf);
  }, [actErrorNow, actionCardNow]);
  const editDirty = editing && !!form && !!original && JSON.stringify(form) !== JSON.stringify(original);
  const reasonDirty = reason.trim() !== '' && reason !== reasonSeed;
  const checkReasonDirty = Object.values(checkReasons).some((v) => v.trim() !== '');
  const noteDirty = noteDraft !== null && noteDraft !== (q.data?.paymentEvidence?.note?.text ?? '');
  const guard = useUnsavedGuard(editDirty || reasonDirty || checkReasonDirty || noteDirty || evidenceBusy);

  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  const st = REQUEST_STATUS[r.status as RequestStatus];
  const can = (a: string) => r.allowedActions.includes(a);
  const mine = r.createdBy.id === me.user.id;
  const roleKey: RoleKey = mine ? 'requester' : me.permissions.includes('request.approve') ? 'approver' : 'other';
  const decided = r.approvals.find((a: any) => a.userId === me.user.id);
  const n = me.policy.confirmTailLength;
  const actErr = act.error instanceof ApiError ? act.error : null;
  const blocked = r.blockedReason === 'ADDRESS_NOT_ACTIVE';
  // 지금 저장된 내용이 승인 요청 때 고정한 지문과 맞지 않는다(서버가 조회 때마다 다시 계산). 승인은 내보이지 않고 반려·취소만 남는다.
  const tampered = r.blockedReason === 'INTENT_TAMPERED';
  const decideCard = can('approve') || can('reject');
  const allChecked = checked.counterparty && checked.amount && checked.address;
  const actNotice = actErrorNow;
  const conflict = conflictErr;
  const checks = (r.checks ?? null) as ChecksView;
  // 지급 근거(A2b, 설계 가정 A-38). 상세·행동 응답에만 있다.
  const pe = (r.paymentEvidence ?? null) as PaymentEvidence | null;
  const submitted = !!r.submittedAt;
  // 받는 주소 상태(작성·검토 중 요청). 승인 요청 뒤의 승인 불가(blocked)와 따로 안내한다.
  const hold = addressHold(r);
  // 저장된 수량을 읽을 수 없는 작성·검토 중 요청(검토 이동·승인 요청 불가)
  const unreadable = amountUnreadable(r);
  const addrSt = ADDRESS_STATUS[r.address.status as AddressStatus];
  // 방금 승인·반려한 결과 안내. 처리 중·처리 완료·실패로 넘어갔으면 필요한 승인이 모두 모인 마지막 승인이다.
  // 1/2 승인 안내는 아직 승인 대기일 때만 보인다(그 사이 다른 승인자가 결정해 상태가 바뀌면 낡은 안내를 남기지 않는다).
  const decidedNotice = !justDecided || (justDecided.action === 'approve' && justDecided.status === 'PENDING_APPROVAL' && r.status !== 'PENDING_APPROVAL') ? null
    : justDecided.action === 'reject'
      ? { title: '반려했습니다', body: '요청자에게 반려 사유가 보이고, 승인 요청 때 예약한 수량이 풀렸습니다.' }
      : justDecided.status === 'PENDING_APPROVAL'
        ? { title: `승인했습니다 (${justDecided.approved}/${justDecided.required})`, body: '다른 승인자의 결정을 기다립니다. 필요한 승인 수가 채워지면 바로 수탁사 처리가 시작됩니다. 알림은 가지 않으니 필요하면 다른 승인자에게 직접 알려 주세요.' }
        : { title: '승인했습니다', body: '필요한 승인 수가 채워져 수탁사 처리(이 환경은 모의 커스터디)를 시작했습니다. 블록체인 전송은 처리 후 되돌릴 수 없습니다. 완료되면 이 화면과 자산 활동 내역에 표시됩니다.' };
  // 이번 승인으로 필요한 승인 수가 채워지는지(표시용, A1). 정족수와 처리 시작은 서버가 정한다(A-15, A-18). 화면의 승인 수가 낡았으면 대개 서버의 버전 검사(409)가 막지만,
  // 이미 승인한 사람에게 승인자 역할을 다시 주면 요청 버전이 그대로인 채 유효 승인 수가 늘 수 있다(다음 새로 고침, 최대 15초 전까지).
  // 그래서 마지막이 아닐 때의 문장은 '지금 기준으로'라고 쓰고, 바로 아래 되돌릴 수 없음 문장('채워지면 바로 처리가 시작')은 그대로 둔다.
  const finalApproval = can('approve') && r.approvedCount + 1 >= r.requiredApprovals;
  const addr = addrRecord.data as undefined | {
    createdBy: { name: string }; createdAt: string; reviewedBy: { name: string } | null; reviewedAt: string | null; activeFrom: string | null; lookalikeReason: string | null;
    outOfBand: { receivedViaLabel: string; verifiedViaLabel: string } | null;
  };
  // 지금 누가 승인할 수 있는지(A2-1, 서버 계산). 승인 대기이고 승인할 수 있는 요청만 값이 있다(blockedReason이 있으면 null).
  const wait = (r.approvalWait ?? null) as ApprovalWait | null;
  // 결정 당시 역할은 감사 기록 조회 권한이 있는 사람에게만 보인다(서버도 그 권한이 없으면 보내지 않는다).
  const canAudit = me.permissions.includes('audit.read');
  // 승인 요청 때 보낼 진행 사유: 지금 보이는 점검 항목 id만 보낸다.
  const reasonsToSend = Object.fromEntries((checks?.items ?? []).filter((c) => (checkReasons[c.id] ?? '').trim() !== '').map((c) => [c.id, checkReasons[c.id]!]));

  // 제출 전 평가액: 공용 krwValue(BigInt)로 계산한다.
  const price = bal.data?.price as { asOf: string | null; state: string; source: string | null } | undefined;
  const assetPrice: string | null = bal.data?.assets.find((a: any) => a.assetCode === r.assetCode)?.krwPrice ?? null;
  // 저장된 수량을 읽을 수 없는 요청(r.amount === null)은 평가액을 계산하지 않는다(BigInt 변환이 실패해 화면이 깨지지 않도록).
  const currentKrw = preSubmit && r.amount !== null && assetPrice && price && price.state !== 'unavailable' ? krwValue(BigInt(r.amountUnits), r.precision, assetPrice) : null;
  // 수량을 읽을 수 없으면 예상 승인 수도 계산하지 않는다(규칙만 보인다).
  const projected = preSubmit && price && r.amount !== null ? { krw: currentKrw, state: assetPrice ? price.state : 'unavailable' } : null;

  // 확인 카드(승인 요청·승인/반려)가 있으면 되돌리기·요청 취소는 카드 아래로 내려 주 행동과 섞이지 않게 한다.
  const hasActionCard = can('submit') || decideCard;
  const secondary = can('back_to_draft') || can('cancel');
  const rowAbove = !editing && (can('edit') || can('review') || (!hasActionCard && secondary));
  const rowBelow = !editing && hasActionCard && secondary;
  // 지금 받는 주소를 쓸 수 없으면(사용 중지·사용 대기 등) 선택 상자에 없는 주소이므로 비워 둔 채 연다. 선택 상자·점검 미리 보기·필수 입력 검사가 같은 값을 보게 한다.
  const editButton = can('edit') && <button className="btn" onClick={() => { const v = { assetCode: r.assetCode, networkCode: r.networkCode, addressId: r.address.status === 'ACTIVE' ? r.address.id : '', amount: r.amount ?? '', purpose: r.purpose }; setForm(v); setOriginal(v); save.reset(); act.reset(); setEditing(true); }}>내용 수정</button>;
  const backButton = can('back_to_draft') && <button className="btn" onClick={() => act.mutate({ action: 'back-to-draft', body: {} })} disabled={act.isPending}>작성 단계로 되돌리기</button>;
  const cancelButton = can('cancel') && <button type="button" className="btn btn-danger-outline" onClick={() => { cancelM.reset(); setConfirmCancel(true); }} disabled={act.isPending}>요청 취소</button>;
  const reviewButton = can('review') && <button className="btn btn-primary" onClick={() => act.mutate({ action: 'review', body: {} })} disabled={act.isPending}>검토로 이동</button>;

  // 409 안내(지문 불일치·먼저 바뀜): 확인 카드가 있으면 카드 안 결정 버튼 바로 위에, 없으면 화면 위쪽에 한 번만 보인다.
  // 안내로 포커스를 옮기므로(conflictRef) 버튼을 누른 자리에서 원인과 행동을 바로 읽을 수 있다.
  const conflictNotice = conflict && (
    <div ref={conflictRef} tabIndex={-1} className="rc-focus-target">
      <Notice tone={conflict.code === 'INTENT_TAMPERED' ? 'danger' : 'warning'} role="alert" title={conflict.body.message}>
        {INTENT_CODES.has(conflict.code) ? conflict.body.action : '최신 상태를 다시 불러왔습니다. 내용을 확인한 뒤 다시 진행하세요.'}
        {can('approve') && ' 승인 전 확인 세 항목은 다시 확인해 선택해야 합니다.'}
      </Notice>
    </div>
  );

  return (
    <div className="page page-narrow">
      <PageHeader title={`출금 요청 ${r.refNo}`} eyebrow={<Link to={back}>← 결재 및 요청</Link>} description={<><Badge tone={st.tone}>{st.label}</Badge> <span className="muted">{st.description}</span></>} />
      <StatusRail step={st.step} status={r.status} />
      {/* 레일 마지막 칸이 무엇인지(A1). 단계 이름(DASH-004)은 그대로 두고 설명만 붙인다. */}
      {(r.status === 'PENDING_APPROVAL' || r.status === 'PROCESSING') && (
        <p className="muted small rail-caption">마지막 칸 '처리 결과'는 필요한 승인이 모두 모인 뒤 수탁사가 처리한 결과(처리 완료·처리 실패)입니다.</p>
      )}

      <section ref={nextRef} tabIndex={-1} className="next-action" aria-labelledby="next-h">
        <h2 id="next-h">다음 할 일</h2>
        <p>{nextAction(r, roleKey, n, can('reject'), reasonPrefilled, !!decided)}</p>
        {/* A2-1: 지금 승인할 수 있는 사람(이름순, 작성자·이미 결정한 사람 제외, 조회자 본인은 '나')과 남은 승인 수, 승인 요청 뒤 기다린 시간.
            승인할 수 없는 요청(blockedReason)에는 두지 않는다. 알림을 약속하지 않는 위 문장(A1-08)은 그대로다. 지연 기준·색은 없다. */}
        {wait && (
          <p className="next-wait">
            {APPROVAL_WAIT_TEXT.candidates}: <b>{wait.candidates.length ? approverNames(wait.candidates, me.user.id, ' · ') : '없음'}</b> (남은 승인 {wait.remaining}명) · <span className="nowrap">승인 요청 <WaitedTime iso={r.submittedAt} /></span>
          </p>
        )}
        {mine && r.status === 'PENDING_APPROVAL' && (
          <p className="muted small">
            본인이 작성한 요청은 승인할 수 없습니다. 승인 {r.approvedCount}/{r.requiredApprovals}명. 승인자 역할은 {me.permissions.includes('org.read') ? <Link to="/org">「조직 관리」</Link> : '「조직 관리」'}의 역할 표에서 볼 수 있습니다.
          </p>
        )}
        {decided && <p className="muted small">내 결정: {decided.decision === 'approved' ? '승인' : '반려'} ({dateTime(decided.createdAt)})</p>}
      </section>
      {/* 남은 승인을 채울 사람이 모자라면(역할 해제·비활성화 등) 이대로는 처리될 수 없다는 경고. 정족수·자기 승인 금지는 그대로다(위임·대리 없음). */}
      {wait?.shortfall && <Notice tone="warning" title={approvalShortfallText(wait.remaining, wait.candidates.length)} />}

      {loc.state?.created && r.status === 'DRAFT' && <Notice tone="success" role="status" title="초안을 저장했습니다">아직 승인자에게 전달되지 않았습니다. 아래 내용을 확인하고 검토로 이동하세요.</Notice>}
      {tampered && roleKey === 'requester' && (
        <Notice tone="danger" title="승인 요청 뒤 요청 내용이 바뀌어 이 요청은 승인될 수 없습니다">
          지금 내용이 승인 요청 때 고정한 승인 대상 지문과 맞지 않습니다. 요청을 취소하면 승인 요청 때 예약한 수량이 풀립니다. 보안 담당자에게 알리세요.
        </Notice>
      )}
      {tampered && !decideCard && roleKey !== 'requester' && (
        <Notice tone="warning" title="요청 내용이 승인 대상 지문과 맞지 않아 승인할 수 없는 요청입니다">
          요청이 취소되거나 반려되면 승인 요청 때 예약한 수량이 풀립니다.
        </Notice>
      )}
      {blocked && roleKey === 'requester' && (
        <Notice tone="danger" title="받는 주소가 사용 중지되어 이 요청은 승인될 수 없습니다">
          요청을 취소하면 예약 수량이 풀립니다. 승인자가 반려해도 예약 수량이 풀립니다.
        </Notice>
      )}
      {blocked && !decideCard && roleKey !== 'requester' && (
        <Notice tone="warning" title="받는 주소가 사용 중지되어 승인할 수 없는 요청입니다">
          요청이 취소되거나 반려되면 예약 수량이 풀립니다.
        </Notice>
      )}
      {hold && roleKey === 'requester' && (() => {
        const h = holdNotice(r, hold);
        return <Notice tone={hold === 'stopped' ? 'danger' : 'warning'} title={h.title}>{h.body}</Notice>;
      })()}
      {unreadable && roleKey === 'requester' && (
        <Notice tone="danger" title="저장된 수량을 읽을 수 없어 이 요청을 진행할 수 없습니다">
          검토로 이동하거나 승인 요청을 보낼 수 없습니다. 아직 승인 요청 전이라 예약된 수량은 없습니다.
        </Notice>
      )}
      {decidedNotice && (
        <div ref={decidedRef} tabIndex={-1} className="rc-focus-target">
          <Notice tone="success" role="status" title={decidedNotice.title}>{decidedNotice.body}</Notice>
        </div>
      )}
      {showSubmitted && (
        <div ref={submittedRef} tabIndex={-1} className="rc-focus-target">
          <Notice tone="success" role="status" title="승인 요청을 보냈습니다">
            승인자에게 알림이 가지 않으니 직접 알려 주세요. 권장: 알릴 때 쓴 메신저가 아니라 전화 등 다른 연락 수단으로 승인 대상 지문(<b className="rc-intent-inline">{r.intentHashDisplay}</b>)을 불러 주면, 승인자가 자기 화면의 지문과 같은지 대조할 수 있습니다.
          </Notice>
        </div>
      )}
      {r.status === 'REJECTED' && <Notice tone="danger" title="반려 사유">{r.rejectReason}</Notice>}
      {r.status === 'FAILED' && <Notice tone="danger" title="실패 사유">{r.failureReason}</Notice>}
      {!hasActionCard && conflictNotice}

      {editing && form ? (
        <form ref={editRef} className="form card" noValidate onSubmit={(e) => { e.preventDefault(); if (!save.isPending) save.mutate(); }}>
          <h2>작성 내용 수정</h2>
          {/* 지금 받는 주소는 선택 상자에 없으므로(사용 가능한 주소만 보임) 비워 두고 연다. 왜 비어 있는지 알린다. */}
          {hold && (
            <Notice tone="warning" title={`지금 받는 주소(${r.address.label})는 고를 수 없습니다`}>
              '{addrSt?.label ?? r.address.status}' 상태인 주소라 출금 요청에 쓸 수 없습니다. {hold === 'waiting' ? '사용 가능해질 때까지 기다리거나, 사용 가능한 다른 받는 주소를 고르세요.' : '사용 가능한 다른 받는 주소를 고르세요.'}
            </Notice>
          )}
          <RequestForm value={form} onChange={setForm} error={save.error} requestId={r.id} />
          <ApiErrorNotice error={save.error} />
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => guard.confirmDiscard(() => { setEditing(false); setForm(null); setOriginal(null); save.reset(); })}>수정 취소</button>
            <button type="submit" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? '저장 중…' : '저장'}</button>
          </div>
        </form>
      ) : (
        <section className="card">
          <dl className="dl dl-wide">
            <dt>보내는 수량</dt>
            <dd>
              <div className="big-amount">{amount(r.amount, r.assetCode)}</div>
              <Valuation r={r} preSubmit={preSubmit} currentKrw={currentKrw} price={price} assetPrice={assetPrice} balancesError={!!bal.error} />
            </dd>
            <dt>네트워크</dt><dd>{r.networkName} <span className="muted small">· 출금 지갑: {r.walletName}</span></dd>
            <dt>받는 곳</dt><dd>{r.address.label} <span className="muted">· {r.address.counterparty}</span>{r.address.status !== 'ACTIVE' && <> <Badge tone={r.address.status === 'COOLING_DOWN' || r.address.status === 'PENDING_REVIEW' ? 'warning' : 'danger'} title={addrSt?.description}>{addrSt?.label ?? r.address.status}</Badge></>}</dd>
            <dt>받는 주소</dt><dd><AddressStrip address={r.address.address} memo={r.address.memo} memoLabel={r.networkCode === 'XRPL' ? '데스티네이션 태그' : '메모'} /></dd>
            <dt>목적</dt><dd className="cell-wrap">{r.purpose}</dd>
            <dt>요청자</dt><dd>{r.createdBy.name} · {dateTime(r.createdAt)}</dd>
            <dt>필요 승인</dt>
            <dd>
              {r.submittedAt
                ? <>{r.requiredApprovals}명 <span className="muted">(현재 {r.approvedCount}명)</span></>
                : preSubmit ? <>승인 요청을 보낼 때 정해집니다</> : <>승인 요청 전에 끝난 요청이라 정하지 않았습니다</>}
              {/* 승인 요청 없이 끝난 요청(작성·검토 중 취소)에는 정해질 일이 없으므로 근거·예상 문구를 쓰지 않는다. */}
              {(r.submittedAt || preSubmit) && <div className="small" style={{ color: 'var(--ink-2)' }}>{basisText(r, me.policy.approval, projected)} <span className="muted">(설계 가정)</span></div>}
            </dd>
            {preSubmit && <><dt>사용 가능 수량</dt><dd>{amount(r.available, r.assetCode)}</dd></>}
            {/* 결정 카드가 있으면 지문은 카드 안에 크게 보인다(같은 화면에 두 번 쓰지 않는다). */}
            {submitted && !decideCard && (
              <>
                <dt>승인 대상 지문</dt>
                <dd>
                  {r.intentHashDisplay ? <span className="rc-intent-inline">{r.intentHashDisplay}</span> : <span className="muted">기록 없음(지문 기록 전 승인 요청)</span>}
                  <div className="small" style={{ color: 'var(--ink-2)' }}>승인 요청 때 고정한 내용의 지문입니다. 승인자 화면의 지문과 같아야 합니다.</div>
                  {tampered && <div className="small rc-intent-mismatch">지금 요청 내용으로 다시 계산한 지문과 다릅니다. 승인 요청 뒤 내용이 바뀌었습니다.</div>}
                </dd>
              </>
            )}
            {r.custodyRef && <><dt>처리 참조</dt><dd className="mono small">{r.custodyRef} (모의)</dd></>}
          </dl>
        </section>
      )}

      {/* 지급 근거(A2b): 요청자는 작성·검토 중에 편집 카드(「내용 수정」 중에는 읽기 카드), 그 밖의 사람은 읽기 카드.
          결정 카드가 있으면 근거는 카드 안(출금 전 점검 결과 다음)에 보이므로 여기에는 두지 않는다. */}
      {pe && (pe.canEdit
        ? (editing
          ? <section className="card"><PaymentEvidenceView pe={pe} level={2} variant="card" stateText={PAYMENT_EVIDENCE_TEXT.editingNote} /></section>
          : <PaymentEvidenceEditor requestId={r.id} pe={pe} noteDraft={noteDraft} onNoteDraft={setNoteDraft} onBusy={setEvidenceBusy} onStale={() => qc.invalidateQueries({ queryKey: ['request', id] })} />)
        : !decideCard && <section className="card"><PaymentEvidenceView pe={pe} level={2} variant="card" requesterWaiting={mine && r.status === 'PENDING_APPROVAL'} /></section>)}

      {/* 작성 중이거나 다른 사람이 보는 검토 중 요청: 지금 기준 점검(읽기 전용). 요청자의 검토 단계는 아래 확인 카드 안에서 사유와 함께 보인다. */}
      {preSubmit && !editing && !can('submit') && checks && (
        <section className="card">
          {/* 기준 이내 항목을 접어도 '설계 가정·보증 아님' 각주는 접지 않는다(검토 카드·결정 카드와 같은 문장). */}
          <CheckList level={2} title="출금 전 점검" items={checks.items} requesterView={mine}
            intro={checksIntro(mine, hold, checks.items)}
            footnote="점검 기준은 설계 가정이며, 기준 이내라는 결과도 받는 곳이나 전송을 보증하지 않습니다." />
        </section>
      )}

      {/* 승인 요청 뒤(결정 카드가 없는 화면): 제출 때 저장한 점검 결과와 요청자 사유 */}
      {submitted && !decideCard && (
        <section className="card">
          {checks
            ? <CheckList level={2} title="출금 전 점검 결과" items={checks.items} showReasons footnote={`승인 요청 때(${dateTime(checks.evaluatedAt)} KST) 점검한 결과입니다. 기준은 설계 가정이며, 기준 이내라는 결과도 받는 곳이나 전송을 보증하지 않습니다.`} />
            : <><h2>출금 전 점검 결과</h2><p className="muted small" style={{ margin: 0 }}>{NO_STORED_CHECKS}</p></>}
        </section>
      )}

      {!hasActionCard && actNotice && (
        <div ref={actTopRef} tabIndex={-1} className="rc-focus-target">
          {/* 받는 주소가 사용 중지·등록 거절된 경우의 거부: 기다리면 풀리는 일이 아니므로 「다음 할 일」과 같은 행동(주소 바꾸기·취소)을 함께 보인다. */}
          {actErr?.code === 'ADDRESS_NOT_ACTIVE' && hold === 'stopped' && roleKey === 'requester'
            ? <Notice tone="danger" role="alert" title={actErr.body.message}>{nextAction(r, roleKey, n, false, false)}</Notice>
            : <ApiErrorNotice error={actNotice} />}
        </div>
      )}
      {rowAbove && (
        <div className="form-actions form-actions-left">
          {editButton}
          {!hasActionCard && backButton}
          {!hasActionCard && cancelButton}
          {reviewButton}
        </div>
      )}

      <div ref={actionRef}>
      {can('submit') && (
        <section className="card card-action" aria-labelledby="submit-h">
          <h2 id="submit-h">최종 검토 후 승인 요청</h2>
          <p>보내고 나면 승인자에게 전달되고 수량이 예약됩니다. 블록체인 전송은 처리 후 되돌릴 수 없습니다.</p>
          {checks && (
            <CheckList title="출금 전 점검" items={checks.items} reasons={checkReasons} requesterView
              onReason={(cid, v) => setCheckReasons((prev) => ({ ...prev, [cid]: v }))}
              reasonError={(cid) => actErr?.fieldError(`checkReasons.${cid}`)}
              intro={checks.items.some((c) => c.requiresReason) ? '진행 사유 입력란이 있는 주의 항목마다 그대로 진행하는 이유를 적어 주세요. 사유와 점검 결과는 승인 요청과 함께 승인자에게 전달됩니다.' : '승인 요청을 보낼 때 다시 점검해 그 결과를 승인자에게 함께 보입니다.'}
              footnote="점검 기준은 설계 가정이며, 기준 이내라는 결과도 받는 곳이나 전송을 보증하지 않습니다." />
          )}
          <Field label={`받는 곳이 보낸 원본 주소의 끝 ${n}자리`} htmlFor="tail" required error={actErr?.fieldError('confirmTail')} hint="화면을 복사하지 말고 원본 문서를 보고 입력하세요. 끝자리만 같은 비슷한 주소가 있을 수 있으니 가운데 묶음까지 대조하세요.">
            <input id="tail" className="mono" value={tail} onChange={(e) => setTail(e.target.value)} maxLength={20} autoComplete="off" onPaste={(e) => e.preventDefault()} />
          </Field>
          <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} aria-invalid={actErr?.fieldError('ackIrreversible') ? true : undefined} aria-describedby={actErr?.fieldError('ackIrreversible') ? 'ack-error' : undefined} />자산·네트워크·주소·수량을 확인했으며, 전송 후에는 되돌릴 수 없다는 점을 이해했습니다.</label>
          {actErr?.fieldError('ackIrreversible') && <p className="field-error" id="ack-error">{actErr.fieldError('ackIrreversible')}</p>}
          {conflictNotice}
          <ApiErrorNotice error={actNotice} />
          {/* 지급 근거가 승인자에게 어떻게 보이는지 한 줄(A2b). 저장하지 않은 메모가 있으면 함께 알린다. */}
          {pe && <p className="pe-submit-line">{PAYMENT_EVIDENCE_TEXT.submitLine(pe.attachments.length, !!pe.note)}</p>}
          {noteDirty && <p className="pe-submit-warn">{PAYMENT_EVIDENCE_TEXT.unsavedNote}</p>}
          <div className="form-actions">
            <button className="btn btn-primary" onClick={() => act.mutate({ action: 'submit', body: { confirmTail: tail, ackIrreversible: ack, checkReasons: reasonsToSend } })} disabled={act.isPending || !tail || !ack || evidenceBusy}>승인 요청 보내기</button>
          </div>
        </section>
      )}

      {decideCard && (
        <section className="card card-action" aria-labelledby="approve-h">
          <h2 id="approve-h">{can('approve') ? '승인 또는 반려' : '반려'}</h2>
          {/* 무엇을 결정하는지 한 줄 요약(A1): 누가·어디로·얼마·왜·몇 명 중 몇 명. 평가액은 제출 때 저장한 값이다.
              받는 곳 이름이 이미 괄호로 끝나면(예: '정산 파트너 B (Kaia USDC)') 괄호를 겹치지 않고 가운뎃점으로 상대를 잇는다. */}
          <p className="rc-decide-summary">
            {r.createdBy.name}님의 출금 요청: {r.address.label}{r.address.label.endsWith(')') ? ` · ${r.address.counterparty}` : `(${r.address.counterparty})`}에 {amount(r.amount, r.assetCode)}{r.krwValueAtSubmit ? ` (${krwShort(r.krwValueAtSubmit)})` : ''} · 목적: {r.purpose} · 승인 {r.approvedCount}/{r.requiredApprovals}명
          </p>
          {/* 받는 주소의 주소록 기록 두 줄(A2-2, 사람이 남긴 기록이지 증명이 아니다, A-32): 등록자·받은 경로 → 등록자가 다시 확인한 경로 / 확인자·지금 상태.
              다시 확인한 경로는 등록자가 남긴 값이라 '등록자가'를 붙인다(다음 줄의 확인자가 그 경로로 확인했다고 읽히지 않게). 확인자의 연락 경로는 저장하지 않으므로 쓰지 않는다.
              지금 상태는 15초마다 새로 읽는 요청 응답의 값(주소 조회는 60초 캐시). 괄호는 시각 하나에만 쓰고, 증명이 아니라는 말은 가운뎃점으로 잇는다.
              등록자가 남긴 '확인한 상대·연락처'(자유 서술)는 독립 경로로 착각하지 않게 카드에 옮기지 않고 주소 기록 링크로만 남긴다. 못 불러오면 링크만 보인다.
              등록 때 비슷한 주소 경고가 있었으면 링크를 그 경고 줄 끝으로 옮긴다('주소 기록 보기에서 확인하세요'가 링크와 같은 줄에 오게). */}
          <div className="rc-addr-record small" role="group" aria-label="받는 주소의 주소록 기록">
            {addr ? (
              <>
                <p className="rc-addr-line">
                  등록 {addr.createdBy.name} {date(addr.createdAt)} · {addr.outOfBand
                    ? <>받은 경로 {addr.outOfBand.receivedViaLabel} → 등록자가 다시 확인한 경로 {addr.outOfBand.verifiedViaLabel}</>
                    : '받은 경로·등록자가 다시 확인한 경로: 기록 없음(이 기록을 남기기 전에 등록된 주소입니다)'}
                </p>
                <p className="rc-addr-line">
                  {addr.reviewedBy ? `확인 ${addr.reviewedBy.name} ${date(addr.reviewedAt)}` : '확인 기록 없음'} · 지금 상태 {addrSt?.label ?? r.address.status}
                  {addr.activeFrom && r.address.status === 'ACTIVE' && `(${dateTime(addr.activeFrom)}부터)`}
                  {addr.activeFrom && r.address.status === 'COOLING_DOWN' && `(${dateTime(addr.activeFrom)}부터 사용 가능)`}
                  {' · 사람이 남긴 기록이며 증명이 아닙니다'}
                  {!addr.lookalikeReason && <> · <Link className="nowrap" to={`/addresses/${r.address.id}`}>주소 기록 보기</Link></>}
                </p>
                {addr.lookalikeReason && (
                  <p className="rc-addr-line rc-addr-warn">등록 때 비슷한 주소 경고가 있었습니다 — 등록 사유는 <Link className="nowrap" to={`/addresses/${r.address.id}`}>주소 기록 보기</Link>에서 확인하세요</p>
                )}
              </>
            ) : <p className="rc-addr-line"><Link className="nowrap" to={`/addresses/${r.address.id}`}>주소 기록 보기</Link></p>}
          </div>
          {/* 같은 내용의 409 안내(지문 불일치)가 바로 아래에 있으면 되풀이하지 않는다. */}
          {tampered && conflict?.code !== 'INTENT_TAMPERED' && (
            <Notice tone="danger" title="요청 내용이 승인 대상 지문과 맞지 않아 승인할 수 없습니다. 사유와 함께 반려하세요">
              승인 요청 뒤 수량·받는 주소 등 지문에 묶인 내용이 바뀌었습니다. 반려하면 승인 요청 때 예약한 수량이 풀리고 요청자에게 사유가 전달됩니다. 보안 담당자에게 알리세요.
              {reasonPrefilled && ' 아래에 미리 채운 사유는 필요하면 고쳐 쓸 수 있습니다.'}
            </Notice>
          )}
          {blocked && (
            <Notice tone="danger" title="받는 주소가 사용 중지되어 승인할 수 없습니다. 사유와 함께 반려하세요">
              반려하면 예약된 수량이 풀리고 요청자에게 사유가 전달됩니다.
              {reasonPrefilled && ' 아래에 미리 채운 사유는 필요하면 고쳐 쓸 수 있습니다.'}
            </Notice>
          )}
          {/* 무엇을 승인하는지(지문)와 승인 요청 때의 점검 결과·요청자 사유를 결정 버튼보다 먼저 읽게 한다. */}
          <IntentFingerprint display={r.intentHashDisplay} mismatch={tampered} />
          {/* 요청자 화면의 권장 단계(다른 연락 수단으로 지문 불러 주기)와 짝을 이루는 승인자 쪽 할 일. 선택 단계이며 승인 조건은 그대로다(A-29). */}
          {can('approve') && <p className="small rc-intent-todo">요청자에게서 이 지문을 메신저가 아닌 다른 연락 수단으로 받았다면 같은지 대조하세요. 다르면 승인하지 말고 반려하세요.</p>}
          {checks
            ? <CheckList title="출금 전 점검 결과" items={checks.items} showReasons footnote={`승인 요청 때(${dateTime(checks.evaluatedAt)} KST) 점검한 결과입니다. 기준은 설계 가정이며, 기준 이내라는 결과도 받는 곳이나 전송을 보증하지 않습니다.`} />
            : <p className="muted small" style={{ margin: 0 }}>{NO_STORED_CHECKS}</p>}
          {/* 지급 근거(A2b): 승인 요청 때 고정된 파일·메모, 없으면 '근거 기록 없음'. 출처 안내(문서가 진짜인지·받는 주소가 맞는지 확인하지 않음)를 함께 둔다.
              A1 순서(요약 → 주소 기록 → 지문 → 점검 → 승인 효과 → 되돌릴 수 없음 → 승인 전 확인 → 버튼)에 점검 다음 자리로만 끼운다. */}
          {pe && <PaymentEvidenceView pe={pe} variant="decide" />}
          {/* 409 안내는 결정 버튼 바로 위(승인 전 확인보다 앞)에 둔다. 다시 불러와 승인이 사라져도 반려 바로 위에 남는다. */}
          {conflictNotice}
          {can('approve') && (
            <>
              {/* 이번 승인이 마지막인지(A1). 마지막이면 버튼 이름도 '승인하고 처리 시작'으로 바꾼다. 아래 되돌릴 수 없음 문장은 그대로 둔다. */}
              <p id="approve-effect" className="rc-approve-effect">
                {finalApproval
                  ? <><b>이번 승인이 마지막 승인입니다.</b> 승인하면 바로 수탁사 처리가 시작되고, 그 뒤에는 요청자도 취소할 수 없습니다.</>
                  : <>지금 기준으로 이번 승인은 필요한 승인 {r.requiredApprovals}명 중 {ordinal(r.approvedCount)}입니다. {r.requiredApprovals - r.approvedCount - 1}명이 더 승인해야 처리가 시작됩니다.</>}
              </p>
              <p className="rc-irreversible">필요한 승인 수가 채워지면 바로 처리가 시작되며, 블록체인 전송은 처리 후 되돌릴 수 없습니다. 은행 착오송금처럼 되돌려 받는 절차도 없습니다.</p>
              <fieldset className="checks">
                <legend className="field-label">승인 전 확인</legend>
                <label className="check"><input type="checkbox" checked={checked.counterparty} onChange={(e) => setChecked({ ...checked, counterparty: e.target.checked })} />받는 곳과 목적이 실제 업무와 맞습니다.</label>
                <label className="check"><input type="checkbox" checked={checked.amount} onChange={(e) => setChecked({ ...checked, amount: e.target.checked })} aria-describedby="check-amount-hint" />수량({amount(r.amount, r.assetCode)})이 근거 문서와 같습니다.</label>
                <p id="check-amount-hint" className="rc-check-hint">{pe?.hasAny ? PAYMENT_EVIDENCE_TEXT.amountHintWith : PAYMENT_EVIDENCE_TEXT.amountHintNone}</p>
                {/* 주소 대조 체크 바로 위에 전체 주소(모든 묶음 같은 굵기, 메모·태그 포함)를 다시 보인다. 앞·뒤만 줄인 표시는 쓰지 않는다. */}
                <div className="verify-box rc-check-address">
                  <div className="verify-label">대조할 받는 주소 ({r.networkName})</div>
                  <AddressStrip address={r.address.address} memo={r.address.memo} memoLabel={r.networkCode === 'XRPL' ? '데스티네이션 태그' : '메모'} />
                </div>
                <label className="check"><input type="checkbox" checked={checked.address} onChange={(e) => setChecked({ ...checked, address: e.target.checked })} />받는 주소 전체(가운데 묶음 포함)를 원본과 대조했고, 앞·뒤 묶음과 네트워크({r.networkName})도 확인했습니다.</label>
              </fieldset>
              <div className="form-actions" style={{ alignItems: 'center' }}>
                {!allChecked && <p id="approve-hint" className="small" style={{ margin: 0, color: 'var(--ink-2)' }}>세 항목을 모두 확인하면 승인할 수 있습니다.</p>}
                <button className="btn btn-primary" onClick={() => act.mutate({ action: 'approve', body: { intentHash: r.intentHash } })} disabled={act.isPending || !allChecked} aria-describedby={allChecked ? 'approve-effect' : 'approve-effect approve-hint'}>{finalApproval ? '승인하고 처리 시작' : '승인'}</button>
              </div>
              {/* 승인 뒤 흐름은 마지막 승인일 때만 쓴다(아니면 위 효과 문장이 몇 명 더 필요한지 말한다). 결과는 완료와 실패 둘 다 있을 수 있다. */}
              {finalApproval && <p className="muted small rc-after-approve">처리 결과(처리 완료 또는 처리 실패)는 이 화면의 상태로 표시되고, 완료되면 자산 활동 내역에 출금으로 기록됩니다.</p>}
              <hr />
            </>
          )}
          <Field label="반려 사유" htmlFor="reason" error={actErr?.fieldError('reason')} hint="요청자가 무엇을 고쳐야 하는지 알 수 있게 글자·숫자 5자 이상 적어 주세요.">
            <TextareaAuto id="reason" rows={2} maxRows={8} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
          {/* 직접 적은 사유를 지키되, 승인할 수 없는 이유(지문 불일치·주소 사용 중지)에 맞춘 사유를 원하면 한 번에 넣을 수 있게 한다. */}
          {suggestion && reason !== suggestedReason && (
            <div className="form-actions form-actions-left" style={{ marginTop: -4 }}>
              <button type="button" className="btn btn-sm" onClick={() => { setReason(suggestedReason); setReasonSeed(suggestedReason); }}>{suggestion.button}</button>
            </div>
          )}
          <ApiErrorNotice error={actNotice} />
          <div className="form-actions">
            <button className="btn btn-danger-outline" onClick={() => act.mutate({ action: 'reject', body: { reason, intentHash: r.intentHash } })} disabled={act.isPending}>반려</button>
          </div>
        </section>
      )}
      </div>

      {rowBelow && (
        <div className="form-actions form-actions-left">
          {backButton}
          {cancelButton}
        </div>
      )}

      <ConfirmDialog
        open={confirmCancel}
        intent="destructive"
        title="이 출금 요청을 취소할까요?"
        confirmLabel="요청 취소"
        cancelLabel="돌아가기"
        busy={cancelM.isPending}
        error={cancelM.error}
        onConfirm={() => cancelM.mutate()}
        onCancel={() => setConfirmCancel(false)}
      >
        <p><b>{r.refNo}</b> · {amount(r.amount, r.assetCode)} → {r.address.label}</p>
        <p>취소한 요청은 <b>다시 열 수 없습니다</b>. 같은 출금이 필요하면 새 요청을 작성해야 합니다.{r.status === 'PENDING_APPROVAL' && ' 예약된 수량은 해제되고 승인자의 처리 목록에서 사라집니다.'} 취소 기록은 감사 기록에 남습니다.</p>
      </ConfirmDialog>
      {guard.guardDialog}

      <section className="card">
        <h2>처리 기록</h2>
        <ul className="timeline">
          {/* 승인·반려 줄 아래에는 결정 근거(A2-3, 읽을 때 계산): 결정 당시 역할(감사 기록 조회 권한자만)·필요 승인 수에 셌는지·결정 때 본 승인 대상 지문 */}
          {r.timeline.map((t: { createdAt: string; actorName: string; summary: string; evidence?: DecisionEvidenceView | null }, i: number) => (
            <li key={i}>
              <span className="muted small">{dateTime(t.createdAt)}</span> <b>{t.actorName}</b> — {t.summary}
              {t.evidence && <DecisionEvidenceLine evidence={t.evidence} showRoles={canAudit} />}
            </li>
          ))}
        </ul>
        {me.permissions.includes('audit.read') && <Link to={`/audit?q=${encodeURIComponent(r.refNo)}`} className="link-more">감사 기록에서 보기</Link>}
      </section>
    </div>
  );
}

/**
 * 보내는 수량 아래 원화 평가액과 그 근거(출처·기준 시각·데이터 상태).
 * 제출된 요청은 제출 시 저장한 값, 제출 전 요청은 지금 모의 시세로 계산한 값이다.
 */
function Valuation({ r, preSubmit, currentKrw, price, assetPrice, balancesError }: {
  r: any; preSubmit: boolean; currentKrw: bigint | null; price?: { asOf: string | null; state: string; source: string | null }; assetPrice: string | null; balancesError: boolean;
}) {
  if (r.submittedAt) {
    if (!r.krwValueAtSubmit) {
      return (
        <div className="small" style={{ marginTop: 4 }}>
          <span className="warn-text" style={{ fontWeight: 600 }}>평가액 없음 · 제출 시 시세를 확인할 수 없었습니다</span>
          <div><DataStamp label="제출 시각" asOf={r.submittedAt} state="unavailable" /></div>
        </div>
      );
    }
    return (
      <div style={{ marginTop: 4 }}>
        <div>평가액 <b>{krwShort(r.krwValueAtSubmit)}</b> <span className="muted small">({krw(r.krwValueAtSubmit)})</span></div>
        <DataStamp label="제출 시 시세 기준" asOf={r.priceAsOfAtSubmit ?? r.submittedAt} source="모의 시세" state={r.approvalBasis === 'price_stale' ? 'stale' : 'mock'} />
      </div>
    );
  }
  if (!preSubmit) return <div className="muted small" style={{ marginTop: 4 }}>승인 요청 전에 끝난 요청이라 평가액을 기록하지 않았습니다.</div>;
  // 저장된 수량을 읽을 수 없으면 시세가 있어도 평가액을 계산할 수 없다(시세가 없다고 말하지 않는다).
  if (r.amount === null) return <div className="small" style={{ marginTop: 4 }}><span className="warn-text" style={{ fontWeight: 600 }}>수량을 읽을 수 없어 평가액을 계산하지 않습니다</span></div>;
  if (balancesError) return <div className="muted small" style={{ marginTop: 4 }}>지금 시세를 불러오지 못해 평가액을 표시하지 않습니다.</div>;
  if (!price) return <div className="muted small" style={{ marginTop: 4 }}>시세를 불러오는 중…</div>;
  if (currentKrw === null) {
    return (
      <div className="small" style={{ marginTop: 4 }}>
        <span className="warn-text" style={{ fontWeight: 600 }}>{assetPrice ? '시세가 없어' : '이 자산의 시세가 없어'} 지금 평가액을 계산할 수 없습니다</span>
        <div><DataStamp label="시세 기준" asOf={price.asOf} state="unavailable" source={price.source} /></div>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 4 }}>
      <div>현재 평가액 <b>{krwShort(currentKrw.toString())}</b> <span className="muted small">({krw(currentKrw.toString())})</span></div>
      <DataStamp label="시세 기준" asOf={price.asOf} state={price.state} source={price.source} />
    </div>
  );
}
