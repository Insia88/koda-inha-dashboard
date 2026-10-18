import { useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api.ts';
import { useMe } from '../auth.tsx';
import { AddressStrip, ApiErrorNotice, Badge, ErrorState, Field, Loading, Notice, PageHeader, TextareaAuto } from '../components/ui.tsx';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { useFocusFirstError } from '../lib/forms.ts';
import { dateTime } from '../format.ts';
import { ADDRESS_STATUS, type AddressStatus } from '../../shared/terms.ts';

export function AddressDetailPage() {
  const { id } = useParams();
  const loc = useLocation() as { state?: { back?: string; created?: boolean } };
  const back = loc.state?.back ?? '/addresses';
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['address', id], queryFn: () => api(`/api/addresses/${id}`) });
  const [note, setNote] = useState('');
  const [tail, setTail] = useState('');
  const [confirmDisable, setConfirmDisable] = useState(false);
  const reviewRef = useRef<HTMLElement>(null);
  const review = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => api(`/api/addresses/${id}/review`, { method: 'POST', body: { decision, note, version: q.data.version, confirmTail: tail } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['address', id] }); qc.invalidateQueries({ queryKey: ['addresses'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); },
  });
  const disable = useMutation({
    mutationFn: () => api(`/api/addresses/${id}/disable`, { method: 'POST', body: { version: q.data.version } }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['address', id] }); setConfirmDisable(false); qc.invalidateQueries({ queryKey: ['addresses'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); },
    onError: (e) => { if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: ['address', id] }); },
  });
  useFocusFirstError(reviewRef, review.error);
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data;
  const st = ADDRESS_STATUS[a.status as AddressStatus];
  const err = review.error instanceof ApiError ? review.error : null;
  const canReview = a.allowedActions.includes('review');
  const isMineAndPending = a.status === 'PENDING_REVIEW' && a.createdBy.id === me.user.id;

  return (
    <div className="page page-narrow">
      <PageHeader title={a.label} eyebrow={<Link to={back}>← 주소록</Link>} description={<><Badge tone={st.tone}>{st.label}</Badge> <span className="muted">{st.description}</span></>} />
      {disable.isSuccess && a.status === 'DISABLED' && <Notice tone="success" role="status" title="주소를 사용 중지했습니다">이 주소는 더 이상 출금 요청에 쓸 수 없습니다.</Notice>}
      {loc.state?.created && a.status === 'PENDING_REVIEW' && <Notice tone="success" title="확인 요청을 보냈습니다" role="status">승인자가 원본과 대조해 확인하면 출금 요청에 쓸 수 있습니다.</Notice>}
      {isMineAndPending && <Notice tone="info">본인이 등록한 주소는 직접 확인할 수 없습니다. 다른 승인자에게 확인을 요청하세요.</Notice>}

      <section className="card">
        <dl className="dl">
          <dt>받는 곳</dt><dd>{a.counterparty}</dd>
          <dt>자산 / 네트워크</dt><dd><span className="asset-code">{a.assetCode}</span> / {a.networkName}</dd>
          <dt>주소</dt><dd><AddressStrip address={a.address} memo={a.memo} memoLabel={a.networkCode === 'XRPL' ? '데스티네이션 태그' : '메모'} /></dd>
          <dt>등록</dt><dd>{a.createdBy.name} · {dateTime(a.createdAt)}</dd>
          <dt>확인</dt><dd>{a.reviewedBy ? `${a.reviewedBy.name} · ${dateTime(a.reviewedAt)}` : '아직 확인되지 않음'}</dd>
          {a.reviewNote && <><dt>확인 메모</dt><dd className="cell-wrap">{a.reviewNote}</dd></>}
        </dl>
      </section>

      {canReview && (
        <section ref={reviewRef} className="card card-action" aria-labelledby="review-h">
          <h2 id="review-h">주소 확인</h2>
          <ol className="steps-text">
            <li>받는 곳에 별도로 연락해 자산·네트워크·주소를 확인합니다. 등록자가 전달한 자료만으로 확인하지 마세요.</li>
            <li>위 주소의 앞·뒤 묶음을 원본과 한 글자씩 대조합니다.</li>
            <li>원본을 보고 끝 {me.policy.confirmTailLength}자리를 입력한 뒤 확인합니다.</li>
          </ol>
          <Field label={`원본 주소의 끝 ${me.policy.confirmTailLength}자리`} htmlFor="tail" error={err?.fieldError('confirmTail')}>
            <input id="tail" className="mono" value={tail} onChange={(e) => setTail(e.target.value)} maxLength={20} autoComplete="off" onPaste={(e) => e.preventDefault()} />
          </Field>
          <Field label="메모 (거절 시 필수)" htmlFor="note" error={err?.fieldError('note')} hint="거절하면 등록자에게 사유가 보입니다.">
            <TextareaAuto id="note" rows={2} maxRows={6} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          <ApiErrorNotice error={review.error} />
          <div className="form-actions">
            <button className="btn btn-danger-outline" onClick={() => review.mutate('reject')} disabled={review.isPending}>등록 거절</button>
            <button className="btn btn-primary" onClick={() => review.mutate('approve')} disabled={review.isPending || !tail}>대조 완료 · 사용 가능으로 확인</button>
          </div>
        </section>
      )}
      {a.allowedActions.includes('disable') && (
        <section className="card">
          <h2>사용 중지</h2>
          <p className="muted">더 이상 쓰지 않는 주소는 사용 중지하세요. 진행 중인 요청이 이 주소를 쓰면 승인이 거부됩니다.</p>
          <button type="button" className="btn btn-danger-outline" onClick={() => { disable.reset(); setConfirmDisable(true); }}>사용 중지</button>
        </section>
      )}
      <ConfirmDialog
        open={confirmDisable}
        intent="destructive"
        title="이 주소를 사용 중지할까요?"
        confirmLabel="사용 중지"
        busy={disable.isPending}
        error={disable.error}
        onConfirm={() => disable.mutate()}
        onCancel={() => setConfirmDisable(false)}
      >
        <p><b>{a.label}</b> ({a.assetCode} / {a.networkName}) 주소를 더 이상 출금 요청에 쓸 수 없게 됩니다.</p>
        <p>이 작업은 <b>되돌릴 수 없습니다</b>. 다시 쓰려면 새로 등록하고 다른 담당자의 확인을 받아야 합니다. 이 주소를 쓰는 진행 중 요청은 승인이 거부됩니다. 변경은 감사 기록에 남습니다.</p>
      </ConfirmDialog>
      <section className="card">
        <h2>변경 이력</h2>
        <ul className="timeline">
          {a.history.map((h: any, i: number) => <li key={i}><span className="muted small">{dateTime(h.createdAt)}</span> <b>{h.actorName}</b> — {h.summary}</li>)}
        </ul>
      </section>
    </div>
  );
}