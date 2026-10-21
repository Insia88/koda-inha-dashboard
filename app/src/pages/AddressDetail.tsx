import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
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
import { cleanText, reasonError } from '../../shared/text.ts';
import '../components/address-lifecycle.css';

/** 원본을 보고 직접 입력해야 하는 값: 붙여넣기·끌어 놓기를 막는다. */
const blockPaste = (e: ClipboardEvent | DragEvent) => e.preventDefault();

/**
 * 정지 사유를 보내기 전 화면 점검. 서버의 정지 사유 검증(shared/schemas.ts addressStopSchema)과 같은 함수(shared/text.ts)를 쓴다:
 * 보이지 않는 문자(서식 문자·한글 채움 문자·점자 빈칸)를 지운 뒤 5자 이상이고, 그중 글자·숫자가 5자 이상이어야 한다. 맞으면 undefined.
 */
export function stopReasonError(raw: string): string | undefined {
  return reasonError(cleanText(raw), { label: '정지 사유', short: '정지 사유를 5자 이상 입력하세요.' }) ?? undefined;
}

/** 조직 정책(설계 가정): 주소 확인 뒤 사용 대기 시간. 주소 등록·상세 화면이 같이 쓴다. */
export function useAddressPolicy() {
  return useQuery({ queryKey: ['org-policy'], queryFn: () => api('/api/org/policy'), staleTime: 5 * 60_000 });
}

/** 사용 대기 시간 표기: 정책을 아직 모르거나 기본값(24시간)이면 '기본 24시간'. */
export function cooldownText(hours: number | undefined): string {
  return hours === undefined || hours === 24 ? '기본 24시간' : `${hours}시간`;
}

/** 지금 시각(ms). intervalMs마다 다시 그려 남은 시간을 갱신한다. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** 남은 시간: "21시간 58분", "58분", "1분 미만". 지났으면 "0분". */
export function timeLeft(untilIso: string, now: number): string {
  const ms = Date.parse(untilIso) - now;
  if (ms <= 0) return '0분';
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '1분 미만';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

/** 등록 뒤 진행 순서: 확인 대기 → 사용 대기 → 사용 가능. 대기 시간이 0이면 사용 대기 단계를 보이지 않는다. */
export function LifecycleSteps({ hours, current }: { hours: number | undefined; current?: 'PENDING_REVIEW' | 'COOLING_DOWN' | 'ACTIVE' }) {
  const steps: { key: 'PENDING_REVIEW' | 'COOLING_DOWN' | 'ACTIVE'; label: string }[] = [
    { key: 'PENDING_REVIEW', label: '확인 대기' },
    ...(hours === 0 ? [] : [{ key: 'COOLING_DOWN' as const, label: `사용 대기 (${cooldownText(hours)})` }]),
    { key: 'ACTIVE', label: '사용 가능' },
  ];
  const at = steps.findIndex((s) => s.key === current);
  return (
    <ol className="lc-steps" aria-label="주소 등록 뒤 진행 순서">
      {steps.map((s, i) => (
        <li key={s.key} className={at > i ? 'lc-done' : undefined} aria-current={i === at ? 'step' : undefined}>
          <span className="lc-step">{s.label}{i === at && <span className="sr-only"> (현재 단계)</span>}</span>
        </li>
      ))}
    </ol>
  );
}

export function AddressDetailPage() {
  const { id } = useParams();
  const loc = useLocation() as { state?: { back?: string; created?: boolean } };
  const back = loc.state?.back ?? '/addresses';
  const me = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['address', id], queryFn: () => api(`/api/addresses/${id}`) });
  const policy = useAddressPolicy();
  const now = useNow();
  const [note, setNote] = useState('');
  const [tail, setTail] = useState('');
  const [middle, setMiddle] = useState('');
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [stopReason, setStopReason] = useState('');
  const [stopLocalError, setStopLocalError] = useState<string | undefined>();
  const [confirmStop, setConfirmStop] = useState(false);
  const reviewRef = useRef<HTMLElement>(null);
  const stopRef = useRef<HTMLElement>(null);
  const reviewDoneRef = useRef<HTMLDivElement>(null);
  const refreshAll = () => { qc.invalidateQueries({ queryKey: ['addresses'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); };
  const review = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => api(`/api/addresses/${id}/review`, { method: 'POST', body: { decision, note, version: q.data.version, confirmTail: tail, confirmMiddle: middle } }),
    // 응답의 새 상태를 바로 반영해(확인 카드가 사라지고 결과 안내가 보이게) 결과 안내로 포커스를 옮긴다. 변경 이력은 다시 불러온다.
    onSuccess: (data) => { qc.setQueryData(['address', id], (old: any) => (old ? { ...old, ...data } : old)); qc.invalidateQueries({ queryKey: ['address', id] }); refreshAll(); },
    // 409: 다른 사람이 바꿨거나 확인 중 유사 주소가 새로 발견됨 → 최신 점검 결과를 다시 불러온다(입력값은 유지).
    // 422 ADDRESS_POISON_SUSPECTED: 서버가 주소 오염 의심 결과를 점검 결과에 저장하고 버전을 올렸다 → 다시 불러와 경고와 새 버전을 보인다.
    onError: (e) => { if (e instanceof ApiError && (e.status === 409 || e.code === 'ADDRESS_POISON_SUSPECTED')) qc.invalidateQueries({ queryKey: ['address', id] }); },
  });
  const disable = useMutation({
    mutationFn: () => api(`/api/addresses/${id}/disable`, { method: 'POST', body: { version: q.data.version } }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['address', id] }); setConfirmDisable(false); refreshAll(); },
    onError: (e) => { if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: ['address', id] }); },
  });
  const stop = useMutation({
    mutationFn: () => api(`/api/addresses/${id}/stop`, { method: 'POST', body: { version: q.data.version, reason: stopReason } }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['address', id] }); setConfirmStop(false); setStopReason(''); refreshAll(); },
    // 409: 대기 시간이 끝났거나 다른 사람이 먼저 바꿈 → 최신 상태를 다시 불러온다.
    onError: (e) => { if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: ['address', id] }); },
  });
  useFocusFirstError(reviewRef, review.error);

  // 사용 대기가 끝날 시각이 지나면 상세를 다시 불러와 '사용 가능'으로 바뀐 상태를 보인다(조회할 때 상태가 맞춰진다).
  const expired = q.data?.status === 'COOLING_DOWN' && !!q.data.activeFrom && Date.parse(q.data.activeFrom) <= now;
  useEffect(() => { if (expired) void q.refetch(); }, [expired]); // eslint-disable-line

  // 확인·거절을 마친 결과 안내: 누른 버튼이 있던 확인 카드가 사라지므로, 안내로 포커스를 옮기고 화면 안으로 가져온다.
  // 응답의 상태와 지금 상태가 같을 때만 보인다(나중에 사용 대기가 끝나 상태가 바뀌면 안내를 내린다).
  const reviewDone: string | null = review.isSuccess && q.data && review.data?.status === q.data.status ? q.data.status : null;
  useEffect(() => {
    if (!reviewDone) return;
    const raf = requestAnimationFrame(() => {
      const el = reviewDoneRef.current;
      if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'center' }); }
    });
    return () => cancelAnimationFrame(raf);
  }, [review.data]); // eslint-disable-line

  // 확인(승인)이 주소 오염 의심(422 ADDRESS_POISON_SUSPECTED)으로 막히면 다시 불러온 화면에서 확인 버튼이 사라진다.
  // 누른 버튼이 없어져 포커스를 잃지 않게, 거부 안내로 포커스를 옮기고 화면 안으로 가져온다.
  const reviewErrRef = useRef<HTMLDivElement>(null);
  const poisonRefused = review.error instanceof ApiError && review.error.code === 'ADDRESS_POISON_SUSPECTED';
  useEffect(() => {
    if (!poisonRefused) return;
    const raf = requestAnimationFrame(() => {
      const el = reviewErrRef.current;
      if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'center' }); }
    });
    return () => cancelAnimationFrame(raf);
  }, [review.error]); // eslint-disable-line

  // 로딩 중에도 화면 높이를 잡아 둔다(A7 데모 품질: 콘텐츠 교체 때 CLS 감소).
  if (q.isPending) return <div className="detail-loading"><Loading /></div>;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data;
  const st = ADDRESS_STATUS[a.status as AddressStatus];
  const err = review.error instanceof ApiError ? review.error : null;
  const canReview = a.allowedActions.includes('review');
  const canStop = a.allowedActions.includes('stop');
  const isMineAndPending = a.status === 'PENDING_REVIEW' && a.createdBy.id === me.user.id;
  // 방금 등록한 주소(등록 화면에서 넘어옴): 다음 단계 안내를 하나로 모은다.
  const justCreated = !!loc.state?.created && a.status === 'PENDING_REVIEW';
  const findings: Finding[] = a.findings ?? [];
  const hasLookalike = findings.some((f) => f.code === 'ADDRESS_LOOKALIKE');
  // 저장된 점검 결과에 등록을 막는 결과(오류 수준, 예: 확인 때 찾은 '최근 0원·소액 입금을 보낸 주소와 같음')가 있으면
  // 서버가 확인할 때마다 다시 점검해 거부한다. 확인 버튼과 확인용 입력을 내놓지 않고 거절만 남긴다.
  const blocking = findings.find((f) => f.level === 'error');
  const approveBlockedText = blocking
    ? `${blocking.code === 'ADDRESS_POISON_SUSPECTED' ? '최근 0원·소액 입금을 보낸 주소와 같아' : '등록할 수 없는 점검 결과가 있어'} 이 주소는 확인할 수 없습니다. 거절 사유를 적고 「등록 거절」을 누르세요. 받는 곳에는 받은 경로와 다른 연락 수단으로 주소를 다시 확인하세요.`
    : null;
  const n = me.policy.confirmTailLength;
  const bodyPrefix: string = String(a.address).match(/^MOCK-[A-Z]+-/)?.[0] ?? "'MOCK-계열-'";
  // 위치는 접두(MOCK-EVM- 등) 뒤에서 1부터 센다(A1: '고유부'라는 말은 서버 오류 문구와 맞추려 도움말 괄호 안에만 남긴다).
  const midPos = `${bodyPrefix} 뒤 ${a.middle.start}~${a.middle.end}번째 글자`;
  const midLabel = `원본 주소의 가운데 ${CONFIRM_MIDDLE_LENGTH}자리 (${midPos})`;
  const openCount: number = a.openRequestCount ?? 0;
  const hours: number | undefined = policy.data?.addressBook?.cooldownHours;
  // 확인하는 사이 비슷한 주소가 새로 확인되면(409 LOOKALIKE_UPDATED) review의 onError가 주소를 다시 불러오고,
  // 카드 위쪽 점검 결과·글자 비교가 새 내용으로 바뀐다. 새로 고치라고 안내하지 않는다(입력값 유지).
  const lookalikeUpdated = err?.status === 409 && err.code === 'LOOKALIKE_UPDATED';
  // 대기 시간이 있으면 확인 즉시 '사용 가능'이 되지 않으므로 버튼 이름에 대기를 함께 적는다(정책을 불러오기 전에는 중립 문구).
  const approveLabel = hours === 0 ? '대조 완료 · 사용 가능으로 확인' : hours === undefined ? '대조 완료 · 확인' : `대조 완료 · 확인 (${cooldownText(hours)} 뒤 사용 가능)`;
  const stopErr = stop.error instanceof ApiError ? stop.error : null;
  const stopFieldError = stopLocalError ?? stopErr?.fieldError('reason');
  const oob = a.outOfBand as null | { receivedViaLabel: string; verifiedViaLabel: string; verifiedWith: string };

  const openStop = () => {
    stop.reset();
    const local = stopReasonError(stopReason);
    if (local) {
      setStopLocalError(local);
      requestAnimationFrame(() => stopRef.current?.querySelector<HTMLElement>('#stop-reason')?.focus());
      return;
    }
    setStopLocalError(undefined);
    setConfirmStop(true);
    void q.refetch();
  };

  return (
    <div className="page page-narrow">
      <PageHeader title={a.label} eyebrow={<Link to={back}>← 주소록</Link>} description={<><Badge tone={st.tone}>{st.label}</Badge> <span className="muted">{st.description}</span></>} />
      {disable.isSuccess && a.status === 'DISABLED' && <Notice tone="success" role="status" title="주소를 사용 중지했습니다">이 주소는 더 이상 출금 요청에 쓸 수 없습니다.</Notice>}
      {stop.isSuccess && a.status === 'DISABLED' && <Notice tone="success" role="status" title="사용 대기 중인 주소를 정지했습니다">이 주소는 출금 요청에 쓸 수 없습니다. 정지 사유는 변경 이력과 감사 기록에 남았습니다.</Notice>}
      {justCreated && (
        <Notice tone="success" title="주소를 등록했습니다 — 다른 승인자의 확인이 필요합니다" role="status">
          <div className="lc-flow">
            <p>
              이 대시보드는 알림을 보내지 않습니다. 확인할 승인자에게 직접 알려 주세요.{' '}
              {hours === 0
                ? '등록자가 아닌 승인자가 원본과 대조해 확인하면 바로 출금 요청에 쓸 수 있습니다.'
                : `등록자가 아닌 승인자가 원본과 대조해 확인하면 '사용 대기'가 되고, 대기 시간(${cooldownText(hours)})이 지나야 '사용 가능'이 되어 출금 요청에 쓸 수 있습니다. 대기 중에 요청하지 않은 등록이 보이면 바로 정지할 수 있습니다.`}
            </p>
            <LifecycleSteps hours={hours} current="PENDING_REVIEW" />
          </div>
        </Notice>
      )}
      {reviewDone && (
        <div ref={reviewDoneRef} tabIndex={-1} className="rc-focus-target">
          {reviewDone === 'COOLING_DOWN' && <Notice tone="success" role="status" title="확인을 마쳤습니다">대기 시간이 지나면 출금 요청에 쓸 수 있습니다. 그 전에는 요청 작성 화면의 받는 주소 목록에 나오지 않습니다.</Notice>}
          {reviewDone === 'ACTIVE' && <Notice tone="success" role="status" title="확인을 마쳤습니다">이제 출금 요청의 받는 주소로 고를 수 있습니다.</Notice>}
          {reviewDone === 'REJECTED' && <Notice tone="info" role="status" title="등록을 거절했습니다">이 주소는 출금 요청에 쓸 수 없습니다. 등록자에게 거절 사유가 보입니다.</Notice>}
        </div>
      )}
      {/* 등록 직후에는 위 안내 하나만 보인다(알림이 없다는 점과 다음 단계를 함께 쓴다). 나중에 다시 열면 이 안내가 보인다. */}
      {isMineAndPending && !justCreated && <Notice tone="info">본인이 등록한 주소는 직접 확인할 수 없습니다. 등록자가 아닌 승인자가 확인해야 합니다.</Notice>}

      {a.status === 'COOLING_DOWN' && a.activeFrom && (
        <section className="card lc-cooldown" aria-labelledby="cooldown-h">
          <h2 id="cooldown-h">사용 대기 중입니다</h2>
          <p className="lc-when"><time dateTime={a.activeFrom}>{dateTime(a.activeFrom)}</time> (KST)부터 출금 요청에 쓸 수 있습니다.</p>
          <p className="lc-left">남은 시간 <b>{expired ? '곧 사용 가능' : timeLeft(a.activeFrom, now)}</b></p>
          {/* 이 주소에 실제로 적용된 대기 시간(확인 시각 → 사용 가능 시각). 지금 정책 값과 다를 수 있다. */}
          <LifecycleSteps hours={a.reviewedAt ? Math.max(1, Math.round((Date.parse(a.activeFrom) - Date.parse(a.reviewedAt)) / 3600_000)) : undefined} current="COOLING_DOWN" />
          <p className="muted">두 사람이 확인한 주소도 바로 쓰지 않고 기다리는 시간입니다. 이 주소의 등록을 요청한 적이 없거나 받는 곳에서 확인되지 않았다면 대기 중에 정지하세요.</p>
          {!canStop && <p className="muted small">정지는 자산 담당자·승인자·조직 관리자가 할 수 있습니다.</p>}
        </section>
      )}

      <section className="card">
        <dl className="dl">
          <dt>받는 곳</dt><dd>{a.counterparty}</dd>
          <dt>자산 / 네트워크</dt><dd><span className="asset-code">{a.assetCode}</span> / {a.networkName}</dd>
          <dt>주소</dt><dd><AddressStrip address={a.address} memo={a.memo} memoLabel={a.networkCode === 'XRPL' ? '데스티네이션 태그' : '메모'} /></dd>
          <dt>등록</dt><dd>{a.createdBy.name} · {dateTime(a.createdAt)}</dd>
          {oob ? (
            <>
              <dt>받은 경로</dt><dd>{oob.receivedViaLabel}</dd>
              <dt>다시 확인한 경로</dt><dd>{oob.verifiedViaLabel}</dd>
              <dt>확인한 상대·연락처</dt><dd>{oob.verifiedWith}</dd>
            </>
          ) : <><dt>다른 경로 확인 기록</dt><dd className="muted">기록 없음 (이 기록을 남기기 전에 등록된 주소입니다)</dd></>}
          {a.lookalikeReason && <><dt>유사 주소 등록 사유</dt><dd className="cell-wrap">{a.lookalikeReason}</dd></>}
          <dt>확인</dt><dd>{a.reviewedBy ? `${a.reviewedBy.name} · ${dateTime(a.reviewedAt)}` : '아직 확인되지 않음'}</dd>
          {a.reviewNote && <><dt>확인 메모</dt><dd className="cell-wrap">{a.reviewNote}</dd></>}
          {a.activeFrom && a.status !== 'COOLING_DOWN' && <><dt>사용 대기 종료</dt><dd>{dateTime(a.activeFrom)}</dd></>}
          {a.disabled && <><dt>사용 중지</dt><dd>{a.disabled.by?.name ?? '—'} · {dateTime(a.disabled.at)}</dd></>}
          {a.disabled?.reason && <><dt>정지 사유</dt><dd className="cell-wrap">{a.disabled.reason}</dd></>}
        </dl>
      </section>

      {canStop && (
        <section ref={stopRef} className="card lc-stop" aria-labelledby="stop-h">
          <h2 id="stop-h">사용 대기 중 정지</h2>
          <p>이 주소의 등록을 요청한 적이 없거나, 받는 곳에서 확인되지 않은 주소라면 지금 정지하세요. 정지는 바로 적용되며 되돌릴 수 없습니다.</p>
          <Field label="정지 사유" htmlFor="stop-reason" required error={stopFieldError} hint="왜 정지하는지 글자·숫자 5자 이상 적어 주세요. 변경 이력과 감사 기록에 남습니다.">
            <TextareaAuto id="stop-reason" rows={2} maxRows={6} value={stopReason} onChange={(e) => { setStopReason(e.target.value); setStopLocalError(undefined); }} maxLength={300} />
          </Field>
          <div className="form-actions">
            <button type="button" className="btn btn-danger-outline" onClick={openStop}>사용 대기 중 정지</button>
          </div>
        </section>
      )}

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
          <div className="lc-oob" role="group" aria-labelledby="oob-h">
            <p className="verify-label" id="oob-h">등록자가 남긴 다른 경로 확인 기록</p>
            {oob ? (
              <dl className="dl">
                <dt>받은 경로</dt><dd>{oob.receivedViaLabel}</dd>
                <dt>다시 확인한 경로</dt><dd>{oob.verifiedViaLabel}</dd>
                <dt>확인한 상대·연락처</dt><dd>{oob.verifiedWith}</dd>
              </dl>
            ) : <p className="muted">기록이 없습니다. 이 기록을 남기기 전에 등록된 주소입니다.</p>}
            <p className="small">확인한 연락처가 주소를 보낸 메시지에 적혀 있던 것이면 같은 경로로 확인한 것입니다. 기록만 믿지 말고, 미리 알고 있던 연락처로 받는 곳에 직접 확인하세요.</p>
          </div>
          <div className="verify-box">
            <div className="verify-label">확인할 주소 — 가운데를 포함한 전체 글자를 받는 곳의 원본과 한 글자씩 대조하세요</div>
            <AddressStrip address={a.address} memo={a.memo} memoLabel={a.networkCode === 'XRPL' ? '데스티네이션 태그' : '메모'} verify={!approveBlockedText} />
          </div>
          {!approveBlockedText && <ol className="steps-text">
            <li>받는 곳에 미리 알고 있던 연락처(거래처 대표번호 등)로 연락해 자산·네트워크·주소를 불러 달라고 합니다. 등록자가 전달한 자료만으로 확인하지 마세요.</li>
            <li>위 주소의 가운데를 포함한 전체 글자를 원본과 한 글자씩 대조합니다.</li>
            <li>원본을 보고 끝 {n}자리와 가운데 {CONFIRM_MIDDLE_LENGTH}자리({midPos})를 입력한 뒤 확인합니다.</li>
            {hasLookalike && <li>비슷한 기존 주소가 있으므로 어떤 방법으로 확인했는지 메모에 남깁니다. 메모 없이는 확인할 수 없습니다.</li>}
            {hours !== 0 && <li>확인해도 바로 쓰이지 않습니다. 사용 대기({cooldownText(hours)})가 지나야 출금 요청에 쓸 수 있습니다.</li>}
          </ol>}
          {!approveBlockedText && <Field label={`원본 주소의 끝 ${n}자리`} htmlFor="tail" error={err?.fieldError('confirmTail')}>
            <input id="tail" className="mono" value={tail} onChange={(e) => setTail(e.target.value)} maxLength={20} autoComplete="off" spellCheck={false} onPaste={blockPaste} onDrop={blockPaste} />
          </Field>}
          {!approveBlockedText && <Field label={midLabel} htmlFor="middle" error={err?.fieldError('confirmMiddle')}
            hint={`${bodyPrefix} 뒤의 글자(고유부)를 1부터 셉니다. 위 테두리는 위치만 알려 줍니다. 글자는 화면이 아니라 받는 곳에서 받은 원본 주소의 같은 위치를 보고 입력하세요.`}>
            <input id="middle" className="mono" value={middle} onChange={(e) => setMiddle(e.target.value)} maxLength={20} autoComplete="off" spellCheck={false} onPaste={blockPaste} onDrop={blockPaste} />
          </Field>}
          <Field label={approveBlockedText ? '거절 사유' : hasLookalike ? '확인 메모 (확인한 방법)' : '메모 (거절 시 필수)'} htmlFor="note" required={hasLookalike || !!approveBlockedText} error={err?.fieldError('note')}
            hint={approveBlockedText ? '등록자가 무엇을 고쳐야 하는지 알 수 있게 글자·숫자 5자 이상 적어 주세요. 거절하면 등록자에게 사유가 보입니다.' : hasLookalike ? '비슷한 기존 주소가 있어 확인할 때도 메모가 필요합니다. 받는 곳에 어떤 연락 수단으로 전체 주소를 확인했는지 글자·숫자 5자 이상 적어 주세요. 거절하면 등록자에게 사유가 보입니다.' : '거절할 때는 사유를 글자·숫자 5자 이상 적어 주세요. 거절하면 등록자에게 사유가 보입니다.'}>
            <TextareaAuto id="note" rows={2} maxRows={6} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
          {lookalikeUpdated ? (
            <Notice tone="warning" role="alert" title={err.body.message}>
              {q.isFetching
                ? '갱신된 점검 결과를 불러오는 중입니다.'
                : '갱신된 점검 결과와 글자 비교를 위에 다시 표시했습니다. 비교 내용을 확인한 뒤 다시 대조하고, 어떻게 확인했는지 메모를 남겨 주세요. 입력한 내용은 그대로 남아 있습니다.'}
            </Notice>
          ) : review.error ? <div ref={reviewErrRef} tabIndex={-1} className="rc-focus-target"><ApiErrorNotice error={review.error} /></div> : null}
          {/* 확인할 수 없는 주소: 같은 내용의 거부 안내(422)가 바로 위에 있으면 되풀이하지 않는다. */}
          {approveBlockedText && !poisonRefused && <p className="small" style={{ margin: 0, color: 'var(--ink-2)' }}>{approveBlockedText}</p>}
          <div className="form-actions">
            <button className="btn btn-danger-outline" onClick={() => review.mutate('reject')} disabled={review.isPending}>등록 거절</button>
            {!approveBlockedText && <button className="btn btn-primary" onClick={() => review.mutate('approve')} disabled={review.isPending || !tail || !middle}>{approveLabel}</button>}
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
      <ConfirmDialog
        open={confirmStop}
        intent="destructive"
        title="이 주소의 사용 대기를 정지할까요?"
        confirmLabel="정지"
        busy={stop.isPending}
        error={stop.error}
        onConfirm={() => stop.mutate()}
        onCancel={() => setConfirmStop(false)}
      >
        <p><b>{a.label}</b> ({a.assetCode} / {a.networkName}) 주소가 바로 사용 중지되어, 대기 시간이 지나도 출금 요청에 쓸 수 없습니다.</p>
        <p>정지 사유</p>
        <p className="lc-quote">{cleanText(stopReason)}</p>
        <p>이 작업은 <b>되돌릴 수 없습니다</b>. 다시 쓰려면 새로 등록하고 두 사람의 확인을 다시 받아야 합니다. 정지와 사유는 감사 기록에 남습니다.</p>
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
