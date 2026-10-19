import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api.ts';
import { useMe } from '../auth.tsx';
import { AddressStrip, ApiErrorNotice, Badge, ErrorState, Field, Loading, Notice, PageHeader, TextareaAuto } from '../components/ui.tsx';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { Findings } from '../components/Findings.tsx';
import { LookalikeComparisons } from '../components/AddressCompare.tsx';
import { useFocusFirstError } from '../lib/forms.ts';
import { dateTime } from '../format.ts';
import { ADDRESS_STATUS, type AddressStatus } from '../../shared/terms.ts';
import { CONFIRM_MIDDLE_LENGTH, type Finding } from '../../shared/address-rules.ts';

/** 원본을 보고 직접 입력해야 하는 값: 붙여넣기·끌어 놓기를 막는다. */
const blockPaste = (e: ClipboardEvent | DragEvent) => e.preventDefault();

export function AddressDetailPage() {
  const { id } = useParams();
  const loc = useLocation() as { state?: { back?: string; created?: boolean } };
  const back = loc.state?.back ?? '/addresses';
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['address', id], queryFn: () => api(`/api/addresses/${id}`) });
  const [note, setNote] = useState('');
  const [tail, setTail] = useState('');
  const [middle, setMiddle] = useState('');
  const [confirmDisable, setConfirmDisable] = useState(false);
  const reviewRef = useRef<HTMLElement>(null);
  const review = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => api(`/api/addresses/${id}/review`, { method: 'POST', body: { decision, note, version: q.data.version, confirmTail: tail, confirmMiddle: middle } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['address', id] }); qc.invalidateQueries({ queryKey: ['addresses'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); },
    // 409: 다른 사람이 바꿨거나 확인 중 유사 주소가 새로 발견됨 → 최신 점검 결과를 다시 불러온다(입력값은 유지).
    onError: (e) => { if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: ['address', id] }); },
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
  const findings: Finding[] = a.findings ?? [];
  const hasLookalike = findings.some((f) => f.code === 'ADDRESS_LOOKALIKE');
  const n = me.policy.confirmTailLength;
  const midLabel = `원본 주소의 가운데 ${CONFIRM_MIDDLE_LENGTH}자리 (고유부 ${a.middle.start}~${a.middle.end}번째)`;
  const bodyPrefix: string = String(a.address).match(/^MOCK-[A-Z]+-/)?.[0] ?? "'MOCK-계열-'";
  const openCount: number = a.openRequestCount ?? 0;
  // 확인하는 사이 비슷한 주소가 새로 확인되면(409 LOOKALIKE_UPDATED) review의 onError가 주소를 다시 불러오고,
  // 카드 위쪽 점검 결과·글자 비교가 새 내용으로 바뀐다. 새로 고치라고 안내하지 않는다(입력값 유지).
  const lookalikeUpdated = err?.status === 409 && err.code === 'LOOKALIKE_UPDATED';

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
          {a.lookalikeReason && <><dt>유사 주소 등록 사유</dt><dd className="cell-wrap">{a.lookalikeReason}</dd></>}
          <dt>확인</dt><dd>{a.reviewedBy ? `${a.reviewedBy.name} · ${dateTime(a.reviewedAt)}` : '아직 확인되지 않음'}</dd>
          {a.reviewNote && <><dt>확인 메모</dt><dd className="cell-wrap">{a.reviewNote}</dd></>}
        </dl>
      </section>

      {!canReview && hasLookalike && (
        <section className="card" aria-labelledby="lookalike-h">
          <h2 id="lookalike-h">비슷한 기존 주소</h2>
          <Findings findings={findings.filter((f) => f.code === 'ADDRESS_LOOKALIKE')} />
          <LookalikeComparisons address={a.address} findings={findings} candidateLabel="이 주소" />
        </section>
      )}

      {canReview && (
        <section ref={reviewRef} className="card card-action" aria-labelledby="review-h">
          <h2 id="review-h">주소 확인</h2>
          {findings.length > 0 && (
            <>
              <p className="verify-label">이 주소의 점검 결과</p>
              <Findings findings={findings} />
              <LookalikeComparisons address={a.address} findings={findings} candidateLabel="이 주소" />
            </>
          )}
          <div className="verify-box">
            <div className="verify-label">확인할 주소 — 가운데를 포함한 전체 글자를 받는 곳의 원본과 한 글자씩 대조하세요</div>
            <AddressStrip address={a.address} memo={a.memo} memoLabel={a.networkCode === 'XRPL' ? '데스티네이션 태그' : '메모'} verify />
          </div>
          <ol className="steps-text">
            <li>받는 곳에 별도로 연락해 자산·네트워크·주소를 확인합니다. 등록자가 전달한 자료만으로 확인하지 마세요.</li>
            <li>위 주소의 가운데를 포함한 전체 글자를 원본과 한 글자씩 대조합니다.</li>
            <li>원본을 보고 끝 {n}자리와 가운데 {CONFIRM_MIDDLE_LENGTH}자리(고유부 {a.middle.start}~{a.middle.end}번째)를 입력한 뒤 확인합니다.</li>
            {hasLookalike && <li>비슷한 기존 주소가 있으므로 어떤 방법으로 확인했는지 메모에 남깁니다. 메모 없이는 확인할 수 없습니다.</li>}
          </ol>
          <Field label={`원본 주소의 끝 ${n}자리`} htmlFor="tail" error={err?.fieldError('confirmTail')}>
            <input id="tail" className="mono" value={tail} onChange={(e) => setTail(e.target.value)} maxLength={20} autoComplete="off" spellCheck={false} onPaste={blockPaste} onDrop={blockPaste} />
          </Field>
          <Field label={midLabel} htmlFor="middle" error={err?.fieldError('confirmMiddle')}
            hint={`고유부는 주소에서 ${bodyPrefix} 다음부터 센 글자입니다. 위 테두리는 위치만 알려 줍니다. 글자는 화면이 아니라 받는 곳에서 받은 원본 주소의 같은 위치를 보고 입력하세요.`}>
            <input id="middle" className="mono" value={middle} onChange={(e) => setMiddle(e.target.value)} maxLength={20} autoComplete="off" spellCheck={false} onPaste={blockPaste} onDrop={blockPaste} />
          </Field>
          <Field label={hasLookalike ? '확인 메모 (확인한 방법)' : '메모 (거절 시 필수)'} htmlFor="note" required={hasLookalike} error={err?.fieldError('note')}
            hint={hasLookalike ? '비슷한 기존 주소가 있어 확인할 때도 메모가 필요합니다. 받는 곳에 어떤 연락 수단으로 전체 주소를 확인했는지 5자 이상 적어 주세요. 거절하면 등록자에게 사유가 보입니다.' : '거절하면 등록자에게 사유가 보입니다.'}>
            <TextareaAuto id="note" rows={2} maxRows={6} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          {lookalikeUpdated ? (
            <Notice tone="warning" role="alert" title={err.body.message}>
              {q.isFetching
                ? '갱신된 점검 결과를 불러오는 중입니다.'
                : '갱신된 점검 결과와 글자 비교를 위에 다시 표시했습니다. 비교 내용을 확인한 뒤 다시 대조하고, 어떻게 확인했는지 메모를 남겨 주세요. 입력한 내용은 그대로 남아 있습니다.'}
            </Notice>
          ) : <ApiErrorNotice error={review.error} />}
          <div className="form-actions">
            <button className="btn btn-danger-outline" onClick={() => review.mutate('reject')} disabled={review.isPending}>등록 거절</button>
            <button className="btn btn-primary" onClick={() => review.mutate('approve')} disabled={review.isPending || !tail || !middle}>대조 완료 · 사용 가능으로 확인</button>
          </div>
        </section>
      )}
      {a.allowedActions.includes('disable') && (
        <section className="card">
          <h2>사용 중지</h2>
          <p className="muted">더 이상 쓰지 않는 주소는 사용 중지하세요. 진행 중인 요청이 이 주소를 쓰면 승인이 거부됩니다.</p>
          <button type="button" className="btn btn-danger-outline" onClick={() => { disable.reset(); setConfirmDisable(true); void q.refetch(); }}>사용 중지</button>
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
        <p>
          {openCount > 0
            ? <>이 주소를 쓰는 진행 중 요청 <b>{openCount}건</b>은 승인할 수 없게 됩니다. 요청자가 취소하거나 승인자가 반려해야 예약 수량이 풀립니다.</>
            : '지금 이 주소를 쓰는 진행 중 요청은 없습니다.'}
        </p>
        <p>이 작업은 <b>되돌릴 수 없습니다</b>. 다시 쓰려면 새로 등록하고 다른 담당자의 확인을 받아야 합니다. 변경은 감사 기록에 남습니다.</p>
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
