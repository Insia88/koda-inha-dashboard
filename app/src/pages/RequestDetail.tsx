import { useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newIdemKey } from '../api.ts';
import { useMe } from '../auth.tsx';
import { AddressStrip, ApiErrorNotice, Badge, ErrorState, Field, Loading, Notice, PageHeader, StatusRail, TextareaAuto } from '../components/ui.tsx';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { useFocusFirstError } from '../lib/forms.ts';
import { useUnsavedGuard } from '../lib/unsaved.tsx';
import { RequestForm, type RequestFormValue } from '../components/RequestForm.tsx';
import { amount, dateTime, krw, krwShort } from '../format.ts';
import { REQUEST_STATUS, type RequestStatus } from '../../shared/terms.ts';

const NEXT_FOR_ROLE: Record<string, { requester: string; approver: string; other: string }> = {
  DRAFT: { requester: '내용을 확인하고 「검토로 이동」을 누르세요.', approver: '요청자가 작성 중입니다. 승인 요청이 오면 알려 드립니다.', other: '요청자가 작성 중입니다.' },
  REVIEW: { requester: '받는 주소를 원본과 대조하고 끝자리를 입력해 승인 요청을 보내세요.', approver: '요청자가 최종 검토 중입니다.', other: '요청자가 최종 검토 중입니다.' },
  PENDING_APPROVAL: { requester: '승인자의 결정을 기다리는 중입니다. 필요하면 취소할 수 있습니다.', approver: '받는 곳·주소·수량·목적을 확인하고 승인하거나 사유와 함께 반려하세요.', other: '승인자의 결정을 기다리는 중입니다.' },
  PROCESSING: { requester: '커스터디 처리 중입니다. 더 할 일은 없습니다.', approver: '커스터디 처리 중입니다.', other: '커스터디 처리 중입니다.' },
  COMPLETED: { requester: '처리가 끝났습니다. 받는 곳에 입금 확인을 요청하세요.', approver: '처리가 끝났습니다.', other: '처리가 끝났습니다.' },
  REJECTED: { requester: '반려 사유를 확인하고 필요하면 새 요청을 작성하세요.', approver: '반려된 요청입니다.', other: '반려된 요청입니다.' },
  CANCELLED: { requester: '취소된 요청입니다.', approver: '취소된 요청입니다.', other: '취소된 요청입니다.' },
  FAILED: { requester: '실패 사유를 확인하세요. 예약 수량은 해제되었습니다.', approver: '처리에 실패한 요청입니다.', other: '처리에 실패한 요청입니다.' },
};

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
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<RequestFormValue | null>(null);
  const [original, setOriginal] = useState<RequestFormValue | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const editRef = useRef<HTMLFormElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const [tail, setTail] = useState('');
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState({ counterparty: false, amount: false, address: false });
  const idem = useRef<Record<string, string>>({});
  const keyFor = (action: string) => (idem.current[action] ??= newIdemKey());

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['request', id] });
    qc.invalidateQueries({ queryKey: ['requests'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['balances'] });
  };
  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body: Record<string, unknown> }) =>
      api(`/api/requests/${id}/${action}`, { method: 'POST', body: { version: q.data.version, ...body }, idempotencyKey: keyFor(`${action}:${q.data.version}`) }),
    onSuccess: (data) => { qc.setQueryData(['request', id], data); refresh(); setEditing(false); setReason(''); setTail(''); },
    onError: (e) => { if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: ['request', id] }); },
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
  const guard = useUnsavedGuard(editDirty || reason.trim() !== '');

  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  const st = REQUEST_STATUS[r.status as RequestStatus];
  const can = (a: string) => r.allowedActions.includes(a);
  const mine = r.createdBy.id === me.user.id;
  const roleKey = mine ? 'requester' : me.permissions.includes('request.approve') ? 'approver' : 'other';
  const decided = r.approvals.find((a: any) => a.userId === me.user.id);
  const n = me.policy.confirmTailLength;
  const actErr = act.error instanceof ApiError ? act.error : null;

  return (
    <div className="page page-narrow">
      <PageHeader title={`출금 요청 ${r.refNo}`} eyebrow={<Link to={back}>← 결재 및 요청</Link>} description={<><Badge tone={st.tone}>{st.label}</Badge> <span className="muted">{st.description}</span></>} />
      <StatusRail step={st.step} status={r.status} />

      <section className="next-action" aria-labelledby="next-h">
        <h2 id="next-h">다음 할 일</h2>
        <p>{NEXT_FOR_ROLE[r.status]![roleKey as 'requester']}</p>
        {mine && r.status === 'PENDING_APPROVAL' && <p className="muted small">본인이 작성한 요청은 승인할 수 없습니다. 승인 {r.approvedCount}/{r.requiredApprovals}명.</p>}
        {decided && <p className="muted small">내 결정: {decided.decision === 'approved' ? '승인' : '반려'} ({dateTime(decided.createdAt)})</p>}
      </section>

      {loc.state?.created && r.status === 'DRAFT' && <Notice tone="success" role="status" title="초안을 저장했습니다">아직 승인자에게 전달되지 않았습니다. 아래 내용을 확인하고 검토로 이동하세요.</Notice>}
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
            <dd className="big-amount">{amount(r.amount, r.assetCode)}{r.krwValueAtSubmit && <span className="muted small"> · 제출 시 {krwShort(r.krwValueAtSubmit)} ({krw(r.krwValueAtSubmit)}, 모의 시세)</span>}</dd>
            <dt>네트워크</dt><dd>{r.networkName} <span className="muted small">· 출금 지갑: {r.walletName}</span></dd>
            <dt>받는 곳</dt><dd>{r.address.label} <span className="muted">· {r.address.counterparty}</span>{r.address.status !== 'ACTIVE' && <Badge tone="danger">주소 사용 불가</Badge>}</dd>
            <dt>받는 주소</dt><dd><AddressStrip address={r.address.address} memo={r.address.memo} memoLabel={r.networkCode === 'XRPL' ? '데스티네이션 태그' : '메모'} /></dd>
            <dt>목적</dt><dd className="cell-wrap">{r.purpose}</dd>
            <dt>요청자</dt><dd>{r.createdBy.name} · {dateTime(r.createdAt)}</dd>
            <dt>필요 승인</dt><dd>{r.requiredApprovals}명 (현재 {r.approvedCount}명) <span className="muted small">— 원화 평가액 {krwShort(me.policy.approval.highValueThresholdKrw)} 이상은 {me.policy.approval.highValueRequiredApprovals}명 (설계 가정)</span></dd>
            {['DRAFT', 'REVIEW'].includes(r.status) && <><dt>사용 가능 수량</dt><dd>{amount(r.available, r.assetCode)}</dd></>}
            {r.custodyRef && <><dt>처리 참조</dt><dd className="mono small">{r.custodyRef} (모의)</dd></>}
          </dl>
        </section>
      )}

      {!editing && (can('edit') || can('review') || can('back_to_draft') || can('cancel')) && (
        <div className="form-actions form-actions-left">
          {can('edit') && <button className="btn" onClick={() => { const v = { assetCode: r.assetCode, networkCode: r.networkCode, addressId: r.address.id, amount: r.amount, purpose: r.purpose }; setForm(v); setOriginal(v); save.reset(); setEditing(true); }}>내용 수정</button>}
          {can('back_to_draft') && <button className="btn" onClick={() => act.mutate({ action: 'back-to-draft', body: {} })} disabled={act.isPending}>작성 단계로 되돌리기</button>}
          {can('cancel') && <button type="button" className="btn btn-danger-outline" onClick={() => { cancelM.reset(); setConfirmCancel(true); }} disabled={act.isPending}>요청 취소</button>}
          {can('review') && <button className="btn btn-primary" onClick={() => act.mutate({ action: 'review', body: {} })} disabled={act.isPending}>검토로 이동</button>}
        </div>
      )}

      <div ref={actionRef}>
      {can('submit') && (
        <section className="card card-action" aria-labelledby="submit-h">
          <h2 id="submit-h">최종 검토 후 승인 요청</h2>
          <p>보내고 나면 승인자에게 전달되고 수량이 예약됩니다. 블록체인 전송은 처리 후 되돌릴 수 없습니다.</p>
          <Field label={`받는 곳이 보낸 원본 주소의 끝 ${n}자리`} htmlFor="tail" required error={actErr?.fieldError('confirmTail')} hint="화면을 복사하지 말고 원본 문서를 보고 입력하세요.">
            <input id="tail" className="mono" value={tail} onChange={(e) => setTail(e.target.value)} maxLength={20} autoComplete="off" onPaste={(e) => e.preventDefault()} />
          </Field>
          <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} aria-invalid={actErr?.fieldError('ackIrreversible') ? true : undefined} aria-describedby={actErr?.fieldError('ackIrreversible') ? 'ack-error' : undefined} />자산·네트워크·주소·수량을 확인했으며, 전송 후에는 되돌릴 수 없다는 점을 이해했습니다.</label>
          {actErr?.fieldError('ackIrreversible') && <p className="field-error" id="ack-error">{actErr.fieldError('ackIrreversible')}</p>}
          <ApiErrorNotice error={act.error && !(act.error instanceof ApiError && act.error.status === 409) ? act.error : null} />
          <div className="form-actions">
            <button className="btn btn-primary" onClick={() => act.mutate({ action: 'submit', body: { confirmTail: tail, ackIrreversible: ack } })} disabled={act.isPending || !tail || !ack}>승인 요청 보내기</button>
          </div>
        </section>
      )}

      {can('approve') && (
        <section className="card card-action" aria-labelledby="approve-h">
          <h2 id="approve-h">승인 또는 반려</h2>
          <fieldset className="checks">
            <legend className="field-label">승인 전 확인</legend>
            <label className="check"><input type="checkbox" checked={checked.counterparty} onChange={(e) => setChecked({ ...checked, counterparty: e.target.checked })} />받는 곳과 목적이 실제 업무와 맞습니다.</label>
            <label className="check"><input type="checkbox" checked={checked.amount} onChange={(e) => setChecked({ ...checked, amount: e.target.checked })} />수량({amount(r.amount, r.assetCode)})이 근거 문서와 같습니다.</label>
            <label className="check"><input type="checkbox" checked={checked.address} onChange={(e) => setChecked({ ...checked, address: e.target.checked })} />받는 주소의 앞·뒤 묶음과 네트워크({r.networkName})를 확인했습니다.</label>
          </fieldset>
          <div className="form-actions">
            <button className="btn btn-primary" onClick={() => act.mutate({ action: 'approve', body: {} })} disabled={act.isPending || !(checked.counterparty && checked.amount && checked.address)}>승인</button>
          </div>
          <hr />
          <Field label="반려 사유" htmlFor="reason" error={actErr?.fieldError('reason')} hint="요청자가 무엇을 고쳐야 하는지 알 수 있게 5자 이상 적어 주세요.">
            <TextareaAuto id="reason" rows={2} maxRows={8} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
          <ApiErrorNotice error={act.error && !(act.error instanceof ApiError && act.error.status === 409) ? act.error : null} />
          <div className="form-actions">
            <button className="btn btn-danger-outline" onClick={() => act.mutate({ action: 'reject', body: { reason } })} disabled={act.isPending}>반려</button>
          </div>
        </section>
      )}

      </div>

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