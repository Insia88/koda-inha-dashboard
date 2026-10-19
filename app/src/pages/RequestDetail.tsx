import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newIdemKey } from '../api.ts';
import { useMe, type Me } from '../auth.tsx';
import { AddressStrip, ApiErrorNotice, Badge, DataStamp, ErrorState, Field, Loading, Notice, PageHeader, StatusRail, TextareaAuto } from '../components/ui.tsx';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { useFocusFirstError } from '../lib/forms.ts';
import { useUnsavedGuard } from '../lib/unsaved.tsx';
import { krwThreshold, RequestForm, type RequestFormValue } from '../components/RequestForm.tsx';
import { amount, dateTime, krw, krwShort } from '../format.ts';
import { krwValue } from '../../shared/decimal.ts';
import { REQUEST_STATUS, type RequestStatus } from '../../shared/terms.ts';

type RoleKey = 'requester' | 'approver' | 'other';

const NEXT_FOR_ROLE: Record<string, Record<RoleKey, string>> = {
  DRAFT: { requester: '내용을 확인하고 「검토로 이동」을 누르세요.', approver: '요청자가 작성 중입니다. 승인 요청이 오면 알려 드립니다.', other: '요청자가 작성 중입니다.' },
  // REVIEW 요청자 문구는 끝자리 길이에 따라 nextAction()에서 만든다.
  REVIEW: { requester: '', approver: '요청자가 최종 검토 중입니다.', other: '요청자가 최종 검토 중입니다.' },
  PENDING_APPROVAL: { requester: '승인자의 결정을 기다리는 중입니다. 필요하면 취소할 수 있습니다.', approver: '받는 곳·주소·수량·목적을 확인하고 승인하거나 사유와 함께 반려하세요.', other: '승인자의 결정을 기다리는 중입니다.' },
  PROCESSING: { requester: '커스터디 처리 중입니다. 더 할 일은 없습니다.', approver: '커스터디 처리 중입니다.', other: '커스터디 처리 중입니다.' },
  COMPLETED: { requester: '처리가 끝났습니다. 받는 곳에 입금 확인을 요청하세요.', approver: '처리가 끝났습니다.', other: '처리가 끝났습니다.' },
  REJECTED: { requester: '반려 사유를 확인하고 필요하면 새 요청을 작성하세요.', approver: '반려된 요청입니다.', other: '반려된 요청입니다.' },
  CANCELLED: { requester: '취소된 요청입니다.', approver: '취소된 요청입니다.', other: '취소된 요청입니다.' },
  FAILED: { requester: '실패 사유를 확인하세요. 예약 수량은 해제되었습니다.', approver: '처리에 실패한 요청입니다.', other: '처리에 실패한 요청입니다.' },
};

function nextAction(r: any, role: RoleKey, tailLength: number, canReject: boolean, reasonPrefilled: boolean): string {
  // 승인할 수 없는 이유는 아래 안내에 쓰고, 여기에는 할 일만 쓴다(안내 제목과 같은 문장을 되풀이하지 않는다).
  if (r.blockedReason === 'ADDRESS_NOT_ACTIVE') {
    if (role === 'requester') return '이 요청을 취소하세요. 같은 출금이 필요하면 사용 가능한 주소로 새 요청을 작성하세요.';
    if (role === 'approver' && canReject) return reasonPrefilled ? '미리 채운 반려 사유를 확인하고 반려하세요.' : '반려 사유를 확인하고 반려하세요.';
    // 감사 담당자나 이미 결정한 승인자: 할 일이 없다. 무엇을 기다리는지만 쓴다.
    return '요청자의 취소나 승인자의 반려를 기다리는 중입니다.';
  }
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
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<RequestFormValue | null>(null);
  const [original, setOriginal] = useState<RequestFormValue | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const editRef = useRef<HTMLFormElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const [tail, setTail] = useState('');
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState('');
  // 승인할 수 없는 요청(받는 주소 사용 중지)에는 반려 사유를 미리 채워 둔다. 제안 그대로면 작성 중으로 보지 않는다.
  const suggestedReason = q.data?.blockedReason === 'ADDRESS_NOT_ACTIVE' && q.data.allowedActions.includes('reject')
    ? `받는 곳 '${q.data.address.label}'의 주소가 사용 중지되어 승인할 수 없으므로 반려합니다. 사용 가능한 주소로 새 요청을 작성해 주세요.`
    : '';
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
  const [checked, setChecked] = useState({ counterparty: false, amount: false, address: false });
  const idem = useRef<Record<string, string>>({});
  const keyFor = (action: string) => (idem.current[action] ??= newIdemKey());

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['request', id] });
    qc.invalidateQueries({ queryKey: ['requests'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['balances'] });
  };
  // 409(먼저 바뀜)이나 받는 주소 상태 변경(ADDRESS_NOT_ACTIVE)이면 최신 상태를 다시 불러와 화면을 맞춘다. 오류 안내는 그대로 보인다.
  const reloadOnStale = (e: unknown) => {
    if (e instanceof ApiError && (e.status === 409 || e.code === 'ADDRESS_NOT_ACTIVE')) qc.invalidateQueries({ queryKey: ['request', id] });
  };
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body: Record<string, unknown> }) =>
      api(`/api/requests/${id}/${action}`, { method: 'POST', body: { version: q.data.version, ...body }, idempotencyKey: keyFor(`${action}:${q.data.version}`) }),
    onSuccess: (data) => { qc.setQueryData(['request', id], data); refresh(); setEditing(false); setReason(''); setTail(''); },
    onError: reloadOnStale,
  });
  const cancelM = useMutation({
    mutationFn: () => api(`/api/requests/${id}/cancel`, { method: 'POST', body: { version: q.data.version }, idempotencyKey: keyFor(`cancel:${q.data.version}`) }),
    onSuccess: (data) => { qc.setQueryData(['request', id], data); refresh(); setConfirmCancel(false); },
    onError: (e) => { if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: ['request', id] }); },
  });
  const save = useMutation({
    mutationFn: () => api(`/api/requests/${id}`, { method: 'PUT', body: { ...form, version: q.data.version } }),
    onSuccess: (data) => { qc.setQueryData(['request', id], data); refresh(); setEditing(false); setForm(null); setOriginal(null); },
  });
  useFocusFirstError(editRef, save.error);
  useFocusFirstError(actionRef, act.error);
  const editDirty = editing && !!form && !!original && JSON.stringify(form) !== JSON.stringify(original);
  const reasonDirty = reason.trim() !== '' && reason !== reasonSeed;
  const guard = useUnsavedGuard(editDirty || reasonDirty);

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
  const decideCard = can('approve') || can('reject');
  const allChecked = checked.counterparty && checked.amount && checked.address;
  const actNotice = act.error && !(act.error instanceof ApiError && act.error.status === 409) ? act.error : null;

  // 제출 전 평가액: 공용 krwValue(BigInt)로 계산한다.
  const price = bal.data?.price as { asOf: string | null; state: string; source: string | null } | undefined;
  const assetPrice: string | null = bal.data?.assets.find((a: any) => a.assetCode === r.assetCode)?.krwPrice ?? null;
  const currentKrw = preSubmit && assetPrice && price && price.state !== 'unavailable' ? krwValue(BigInt(r.amountUnits), r.precision, assetPrice) : null;
  const projected = preSubmit && price ? { krw: currentKrw, state: assetPrice ? price.state : 'unavailable' } : null;

  // 확인 카드(승인 요청·승인/반려)가 있으면 되돌리기·요청 취소는 카드 아래로 내려 주 행동과 섞이지 않게 한다.
  const hasActionCard = can('submit') || decideCard;
  const secondary = can('back_to_draft') || can('cancel');
  const rowAbove = !editing && (can('edit') || can('review') || (!hasActionCard && secondary));
  const rowBelow = !editing && hasActionCard && secondary;
  const editButton = can('edit') && <button className="btn" onClick={() => { const v = { assetCode: r.assetCode, networkCode: r.networkCode, addressId: r.address.id, amount: r.amount, purpose: r.purpose }; setForm(v); setOriginal(v); save.reset(); setEditing(true); }}>내용 수정</button>;
  const backButton = can('back_to_draft') && <button className="btn" onClick={() => act.mutate({ action: 'back-to-draft', body: {} })} disabled={act.isPending}>작성 단계로 되돌리기</button>;
  const cancelButton = can('cancel') && <button type="button" className="btn btn-danger-outline" onClick={() => { cancelM.reset(); setConfirmCancel(true); }} disabled={act.isPending}>요청 취소</button>;
  const reviewButton = can('review') && <button className="btn btn-primary" onClick={() => act.mutate({ action: 'review', body: {} })} disabled={act.isPending}>검토로 이동</button>;

  return (
    <div className="page page-narrow">
      <PageHeader title={`출금 요청 ${r.refNo}`} eyebrow={<Link to={back}>← 결재 및 요청</Link>} description={<><Badge tone={st.tone}>{st.label}</Badge> <span className="muted">{st.description}</span></>} />
      <StatusRail step={st.step} status={r.status} />

      <section className="next-action" aria-labelledby="next-h">
        <h2 id="next-h">다음 할 일</h2>
        <p>{nextAction(r, roleKey, n, can('reject'), reasonPrefilled)}</p>
        {mine && r.status === 'PENDING_APPROVAL' && <p className="muted small">본인이 작성한 요청은 승인할 수 없습니다. 승인 {r.approvedCount}/{r.requiredApprovals}명.</p>}
        {decided && <p className="muted small">내 결정: {decided.decision === 'approved' ? '승인' : '반려'} ({dateTime(decided.createdAt)})</p>}
      </section>

      {loc.state?.created && r.status === 'DRAFT' && <Notice tone="success" role="status" title="초안을 저장했습니다">아직 승인자에게 전달되지 않았습니다. 아래 내용을 확인하고 검토로 이동하세요.</Notice>}
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
      {r.status === 'REJECTED' && <Notice tone="danger" title="반려 사유">{r.rejectReason}</Notice>}
      {r.status === 'FAILED' && <Notice tone="danger" title="실패 사유">{r.failureReason}</Notice>}
      {act.error instanceof ApiError && act.error.status === 409 && <Notice tone="warning" role="alert" title={act.error.body.message}>최신 상태를 다시 불러왔습니다. 내용을 확인한 뒤 다시 진행하세요.</Notice>}

      {editing && form ? (
        <form ref={editRef} className="form card" noValidate onSubmit={(e) => { e.preventDefault(); if (!save.isPending) save.mutate(); }}>
          <h2>작성 내용 수정</h2>
          <RequestForm value={form} onChange={setForm} error={save.error} />
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
            <dt>받는 곳</dt><dd>{r.address.label} <span className="muted">· {r.address.counterparty}</span>{r.address.status !== 'ACTIVE' && <> <Badge tone="danger">주소 사용 불가</Badge></>}</dd>
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
            {r.custodyRef && <><dt>처리 참조</dt><dd className="mono small">{r.custodyRef} (모의)</dd></>}
          </dl>
        </section>
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
          <Field label={`받는 곳이 보낸 원본 주소의 끝 ${n}자리`} htmlFor="tail" required error={actErr?.fieldError('confirmTail')} hint="화면을 복사하지 말고 원본 문서를 보고 입력하세요. 끝자리만 같은 비슷한 주소가 있을 수 있으니 가운데 묶음까지 대조하세요.">
            <input id="tail" className="mono" value={tail} onChange={(e) => setTail(e.target.value)} maxLength={20} autoComplete="off" onPaste={(e) => e.preventDefault()} />
          </Field>
          <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} aria-invalid={actErr?.fieldError('ackIrreversible') ? true : undefined} aria-describedby={actErr?.fieldError('ackIrreversible') ? 'ack-error' : undefined} />자산·네트워크·주소·수량을 확인했으며, 전송 후에는 되돌릴 수 없다는 점을 이해했습니다.</label>
          {actErr?.fieldError('ackIrreversible') && <p className="field-error" id="ack-error">{actErr.fieldError('ackIrreversible')}</p>}
          <ApiErrorNotice error={actNotice} />
          <div className="form-actions">
            <button className="btn btn-primary" onClick={() => act.mutate({ action: 'submit', body: { confirmTail: tail, ackIrreversible: ack } })} disabled={act.isPending || !tail || !ack}>승인 요청 보내기</button>
          </div>
        </section>
      )}

      {decideCard && (
        <section className="card card-action" aria-labelledby="approve-h">
          <h2 id="approve-h">{can('approve') ? '승인 또는 반려' : '반려'}</h2>
          {blocked && (
            <Notice tone="danger" title="받는 주소가 사용 중지되어 승인할 수 없습니다. 사유와 함께 반려하세요">
              반려하면 예약된 수량이 풀리고 요청자에게 사유가 전달됩니다.
              {reasonPrefilled && ' 아래에 미리 채운 사유는 필요하면 고쳐 쓸 수 있습니다.'}
            </Notice>
          )}
          {can('approve') && (
            <>
              <p>필요한 승인 수가 채워지면 바로 처리가 시작되며, 블록체인 전송은 처리 후 되돌릴 수 없습니다.</p>
              <fieldset className="checks">
                <legend className="field-label">승인 전 확인</legend>
                <label className="check"><input type="checkbox" checked={checked.counterparty} onChange={(e) => setChecked({ ...checked, counterparty: e.target.checked })} />받는 곳과 목적이 실제 업무와 맞습니다.</label>
                <label className="check"><input type="checkbox" checked={checked.amount} onChange={(e) => setChecked({ ...checked, amount: e.target.checked })} />수량({amount(r.amount, r.assetCode)})이 근거 문서와 같습니다.</label>
                <label className="check"><input type="checkbox" checked={checked.address} onChange={(e) => setChecked({ ...checked, address: e.target.checked })} />받는 주소 전체(가운데 묶음 포함)를 원본과 대조했고, 앞·뒤 묶음과 네트워크({r.networkName})도 확인했습니다.</label>
              </fieldset>
              <div className="form-actions" style={{ alignItems: 'center' }}>
                {!allChecked && <p id="approve-hint" className="small" style={{ margin: 0, color: 'var(--ink-2)' }}>세 항목을 모두 확인하면 승인할 수 있습니다.</p>}
                <button className="btn btn-primary" onClick={() => act.mutate({ action: 'approve', body: {} })} disabled={act.isPending || !allChecked} aria-describedby={allChecked ? undefined : 'approve-hint'}>승인</button>
              </div>
              <hr />
            </>
          )}
          <Field label="반려 사유" htmlFor="reason" error={actErr?.fieldError('reason')} hint="요청자가 무엇을 고쳐야 하는지 알 수 있게 5자 이상 적어 주세요.">
            <TextareaAuto id="reason" rows={2} maxRows={8} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
          {/* 직접 적은 사유를 지키되, 주소 사용 중지에 맞춘 사유를 원하면 한 번에 넣을 수 있게 한다. */}
          {suggestedReason && reason !== suggestedReason && (
            <div className="form-actions form-actions-left" style={{ marginTop: -4 }}>
              <button type="button" className="btn btn-sm" onClick={() => { setReason(suggestedReason); setReasonSeed(suggestedReason); }}>주소 사용 중지 사유로 바꾸기</button>
            </div>
          )}
          <ApiErrorNotice error={actNotice} />
          <div className="form-actions">
            <button className="btn btn-danger-outline" onClick={() => act.mutate({ action: 'reject', body: { reason } })} disabled={act.isPending}>반려</button>
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
          {r.timeline.map((t: any, i: number) => <li key={i}><span className="muted small">{dateTime(t.createdAt)}</span> <b>{t.actorName}</b> — {t.summary}</li>)}
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
