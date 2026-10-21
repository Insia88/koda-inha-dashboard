import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IconDownload, IconFileText, IconPaperclip, IconTrash } from '@tabler/icons-react';
import { api, ApiError, downloadFile, uploadAttachment } from '../api.ts';
import { dateTime, fileSizeLabel } from '../format.ts';
import { Field, Notice, TextareaAuto } from './ui.tsx';
import { ConfirmDialog } from './Dialog.tsx';
import { PAYMENT_EVIDENCE_TEXT as T } from '../../shared/terms.ts';
import { ATTACHMENT_ACCEPT, ATTACHMENT_SNIFF_BYTES, shortSha, sniffAttachmentType, type AttachmentView, type PaymentEvidence } from '../../shared/attachments.ts';
import './payment-evidence.css';

// 지급 근거(A2b, DEC-005, 설계 가정 A-38): 요청자가 작성 중·검토 중에 붙이는 근거 파일(PDF·PNG·JPEG)과 메모.
// 결정 카드 안에서는 .rc-*·.card-action·.btn-primary 클래스를 쓰지 않는다(기존 A1 순서 검사가 그 클래스로 위치를 잰다). 클래스는 pe- 접두를 쓴다.
// 이 화면은 파일을 이 출처의 문서로 열지 않는다: 서버가 형식을 확인한 PNG·JPEG만 작은 <img>로 보이고, PDF는 내려받기만 한다.

type Heading = 2 | 3;

function Title({ level, id, children }: { level: Heading; id: string; children: string }) {
  return level === 2 ? <h2 id={id} className="pe-title">{children}</h2> : <h3 id={id} className="pe-title">{children}</h3>;
}

/** 작은 미리 보기(PNG·JPEG만). 못 불러오면(다른 인스턴스가 응답 등) 글로 알린다. */
function Preview({ a }: { a: AttachmentView }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <p className="pe-preview-failed">미리 보기를 불러오지 못했습니다(공개 데모는 서버마다 데이터가 따로입니다).</p>;
  return <img className="pe-thumb" src={a.contentUrl} alt={`${a.fileName} 미리 보기`} width={72} height={72} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function AttachmentItem({ a, onRemove }: { a: AttachmentView; onRemove?: (a: AttachmentView, trigger: HTMLButtonElement) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try { await downloadFile(a.contentUrl, a.fileName); } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, { code: 'DOWNLOAD', message: '파일을 내려받지 못했습니다.', action: '잠시 후 다시 시도하세요.' })); } finally { setBusy(false); }
  };
  return (
    <li className="pe-item">
      {a.previewable ? <Preview a={a} /> : <span className="pe-icon" aria-hidden="true"><IconFileText size={28} /></span>}
      <div className="pe-item-body">
        <p className="pe-name">{a.fileName}</p>
        <p className="pe-meta">{a.typeLabel} · {fileSizeLabel(a.sizeBytes)} · SHA-256 앞 12자리 <span className="pe-sha">{shortSha(a.sha256)}</span></p>
        <p className="pe-meta">첨부 {a.addedBy.name} · {dateTime(a.addedAt)}</p>
        {error && <p className="pe-item-error" role="alert">{error.body.message} {error.body.action}</p>}
      </div>
      <div className="pe-actions">
        <button type="button" className="btn btn-sm" onClick={download} disabled={busy}>
          <IconDownload size={16} aria-hidden="true" />{busy ? '내려받는 중…' : '내려받기'}<span className="sr-only"> {a.fileName}</span>
        </button>
        {onRemove && (
          <button type="button" className="btn btn-sm btn-danger-outline" onClick={(e) => onRemove(a, e.currentTarget)}>
            <IconTrash size={16} aria-hidden="true" />삭제<span className="sr-only"> {a.fileName}</span>
          </button>
        )}
      </div>
    </li>
  );
}

function AttachmentList({ items, onRemove }: { items: AttachmentView[]; onRemove?: (a: AttachmentView, trigger: HTMLButtonElement) => void }) {
  return (
    <ul className="pe-list" aria-label="지급 근거 파일">
      {items.map((a) => <AttachmentItem key={a.id} a={a} onRemove={onRemove} />)}
    </ul>
  );
}

function NoteBlock({ note }: { note: NonNullable<PaymentEvidence['note']> }) {
  return (
    <div className="pe-note">
      <p className="pe-note-label">{T.noteLabel} <span className="muted">(설계 가정)</span></p>
      <p className="pe-note-text">{note.text}</p>
      <p className="pe-meta">{note.updatedBy.name} · {dateTime(note.updatedAt)}</p>
    </div>
  );
}

/**
 * 읽기 전용 지급 근거(결정 카드 'decide', 요청 상세의 읽기 카드 'card').
 * 근거가 없으면 '근거 기록 없음'을 성공 색이 아닌 중립 글로 보인다. 근거가 있으면 출처 안내(이 화면은 문서가 진짜인지·받는 주소가 맞는지 확인하지 않음)를 먼저 둔다.
 * '근거 기록 없음'의 설명: 결정 카드는 승인자에게 대조를 권하는 문장, 읽기 카드는 누가 보든 맞는 사실 한 문장이다(요청자·감사 담당자에게 대조하라고 하지 않는다).
 * requesterWaiting: 요청자가 승인 대기 중인 자기 요청을 볼 때 '승인자 화면에도 …'를 붙인다.
 */
export function PaymentEvidenceView({ pe, level = 3, variant, stateText, requesterWaiting = false }: {
  pe: PaymentEvidence; level?: Heading; variant: 'decide' | 'card'; stateText?: string; requesterWaiting?: boolean;
}) {
  const headId = useId();
  return (
    <div className={`pe-block pe-${variant}`} role="group" aria-labelledby={headId}>
      <Title level={level} id={headId}>{T.title}</Title>
      {pe.hasAny ? (
        <>
          <p className="pe-source">{variant === 'decide' ? T.source : T.sourceCard}</p>
          {pe.note && <NoteBlock note={pe.note} />}
          {pe.attachments.length > 0 && <AttachmentList items={pe.attachments} />}
        </>
      ) : (
        <div className="pe-none">
          <strong className="pe-none-title">{T.none}</strong>
          <p>{variant === 'decide' ? T.noneBody : requesterWaiting ? `${T.noneBodyCard} ${T.noneRequesterNote}` : T.noneBodyCard}</p>
        </div>
      )}
      {stateText ? <p className="pe-state">{stateText}</p> : pe.locked ? pe.hasAny && <p className="pe-state">{T.locked}</p> : <p className="pe-state">{T.draftOthers}</p>}
    </div>
  );
}

type FileProblem = { name: string; message: string };
/** 올리지 못한 이유와 다음에 할 일을 한 줄로(서버 오류 응답의 message·action과 같은 짝) */
const UP = T.upload;
const problemText = (p: { message: string; action: string }) => `${p.message} ${p.action}`;

/**
 * 요청자의 지급 근거 편집(작성 중·검토 중, canEdit). 메모 입력값(noteDraft)과 올리는 중 여부는 요청 상세가 갖고,
 * 그 화면의 작성 중 보호(useUnsavedGuard) 하나에 합친다(한 화면에 이동 확인은 하나만 둘 수 있다).
 * 파일은 고른 순서대로 하나씩 올린다. 보내기 전에 크기와 앞부분 형식을 먼저 보고, 맞지 않으면 보내지 않는다(서버가 같은 규칙으로 다시 본다).
 */
export function PaymentEvidenceEditor({ requestId, pe, noteDraft, onNoteDraft, onBusy, onStale }: {
  requestId: string; pe: PaymentEvidence; noteDraft: string | null; onNoteDraft: (v: string | null) => void; onBusy: (busy: boolean) => void; onStale: () => void;
}) {
  const qc = useQueryClient();
  const headId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const [progress, setProgress] = useState<{ at: number; total: number } | null>(null);
  const [summary, setSummary] = useState('');
  const [problems, setProblems] = useState<FileProblem[]>([]);
  const [duplicates, setDuplicates] = useState<FileProblem[]>([]);
  const [removing, setRemoving] = useState<AttachmentView | null>(null);
  const [focusAdd, setFocusAdd] = useState(0);
  const saved = pe.note?.text ?? '';
  const note = noteDraft ?? saved;
  const noteDirty = noteDraft !== null && noteDraft !== saved;
  const full = pe.attachments.length >= pe.limits.maxFiles;
  const uploading = progress !== null;

  const afterChange = (dto: any) => {
    qc.setQueryData(['request', requestId], dto);
    qc.invalidateQueries({ queryKey: ['requests'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const stale = (e: unknown) => e instanceof ApiError && (e.code === 'EVIDENCE_LOCKED' || e.code === 'VERSION_CONFLICT' || e.status === 404);

  const noteM = useMutation({
    mutationFn: () => api(`/api/requests/${encodeURIComponent(requestId)}/evidence-note`, { method: 'PUT', body: { note } }),
    onSuccess: (dto) => { afterChange(dto); onNoteDraft(null); },
    onError: (e) => { if (stale(e)) onStale(); },
  });
  const removeM = useMutation({
    mutationFn: (a: AttachmentView) => api(`/api/requests/${encodeURIComponent(requestId)}/attachments/${encodeURIComponent(a.id)}`, { method: 'DELETE' }),
    onSuccess: (dto) => { afterChange(dto); setRemoving(null); setFocusAdd((x) => x + 1); },
    onError: (e) => { if (stale(e)) onStale(); },
  });

  // 삭제한 항목(누른 버튼)은 사라지므로 「파일 추가」로 포커스를 옮긴다(대화상자가 닫히며 화면 제목으로 보낸 뒤). 버튼을 누를 수 없으면 이 카드 제목으로.
  useEffect(() => {
    if (!focusAdd) return;
    const raf = requestAnimationFrame(() => {
      const btn = addRef.current;
      if (btn && !btn.disabled) btn.focus(); else headRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusAdd]);

  const addFiles = async (files: File[]) => {
    setSummary('');
    const bad: FileProblem[] = [];
    const dup: FileProblem[] = [];
    const queue: File[] = [];
    for (const f of files) {
      if (f.size === 0) { bad.push({ name: f.name, message: problemText(UP.empty) }); continue; }
      if (f.size > pe.limits.maxFileBytes) { bad.push({ name: f.name, message: problemText(UP.tooLarge) }); continue; }
      let head: Uint8Array;
      try { head = new Uint8Array(await f.slice(0, ATTACHMENT_SNIFF_BYTES).arrayBuffer()); } catch { bad.push({ name: f.name, message: problemText(UP.unreadable) }); continue; }
      if (!sniffAttachmentType(head)) { bad.push({ name: f.name, message: problemText(UP.type) }); continue; }
      queue.push(f);
    }
    const room = Math.max(0, pe.limits.maxFiles - pe.attachments.length);
    for (const f of queue.splice(room)) bad.push({ name: f.name, message: problemText(UP.limit) });
    let added = 0;
    if (queue.length) {
      onBusy(true);
      try {
        for (const [i, f] of queue.entries()) {
          setProgress({ at: i + 1, total: queue.length });
          try {
            afterChange(await uploadAttachment(requestId, f));
            added += 1;
          } catch (e) {
            const err = e instanceof ApiError ? e : null;
            const item = { name: f.name, message: err ? [err.body.message, err.body.action].filter(Boolean).join(' ') : problemText(UP.failed) };
            if (err?.code === 'ATTACHMENT_DUPLICATE') dup.push(item); else bad.push(item);
            // 승인 요청이 먼저 되었거나(잠김) 다른 화면에서 바뀌었으면 남은 파일은 보내지 않고 최신 상태를 다시 불러온다.
            if (stale(e)) {
              for (const rest of queue.slice(i + 1)) bad.push({ name: rest.name, message: problemText(UP.stopped) });
              onStale();
              break;
            }
          }
        }
      } finally {
        setProgress(null);
        onBusy(false);
      }
    }
    setSummary(added ? `파일 ${added}개를 붙였습니다` : '');
    setProblems(bad);
    setDuplicates(dup);
  };

  const noteErr = noteM.error instanceof ApiError ? noteM.error : null;
  const addDisabled = uploading || full || !pe.uploadsEnabled;

  return (
    <section className="card pe-editor" aria-labelledby={headId}>
      <h2 id={headId} ref={headRef} tabIndex={-1} className="pe-title">{T.title}</h2>
      <Notice tone="warning" title={T.mockWarning} />
      <p className="pe-intro">{T.editorIntro}</p>

      <Field label={<>{T.noteLabel} <span className="muted">(설계 가정)</span></>} htmlFor="pe-note" hint={T.noteHint} error={noteErr?.fieldError('note')}>
        <TextareaAuto id="pe-note" rows={2} maxRows={6} maxLength={pe.limits.noteMaxLength} value={note} onChange={(e) => onNoteDraft(e.target.value)} />
      </Field>
      <div className="pe-note-actions">
        <span className="pe-counter" aria-hidden="true">{[...note].length}/{pe.limits.noteMaxLength}</span>
        <button type="button" className="btn btn-sm" onClick={() => noteM.mutate()} disabled={!noteDirty || noteM.isPending}>{noteM.isPending ? '저장 중…' : '메모 저장'}</button>
      </div>
      {noteM.error && !noteErr?.fieldError('note') && (
        <Notice tone="danger" role="alert" title={noteErr?.body.message ?? '메모를 저장하지 못했습니다.'}>{noteErr?.body.action}</Notice>
      )}

      <div className="pe-files-head">
        <h3 className="pe-subtitle">지급 근거 파일</h3>
        <span className="pe-limits">{T.limits}</span>
      </div>
      {pe.attachments.length > 0
        ? <AttachmentList items={pe.attachments} onRemove={(a) => { removeM.reset(); setRemoving(a); }} />
        : <p className="pe-empty">{T.editorEmpty}</p>}
      <input ref={fileRef} id="pe-file" type="file" multiple accept={ATTACHMENT_ACCEPT} hidden aria-label="지급 근거 파일 선택"
        onChange={(e) => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ''; if (files.length) void addFiles(files); }} />
      <div className="pe-add">
        <button ref={addRef} type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={addDisabled} aria-describedby={`${headId}-add-why`}>
          <IconPaperclip size={16} aria-hidden="true" />파일 추가
        </button>
        <span id={`${headId}-add-why`} className="pe-add-why">
          {!pe.uploadsEnabled ? T.uploadsOff : full ? `파일은 ${pe.limits.maxFiles}개까지 붙일 수 있습니다. 더 붙이려면 먼저 하나를 지우세요.` : ''}
        </span>
      </div>
      <p className="pe-progress" role="status">{progress ? `올리는 중… (${progress.at}/${progress.total})` : summary}</p>
      {problems.length > 0 && (
        <Notice tone="danger" role="alert" title="올리지 못한 파일이 있습니다">
          <ul className="pe-problems">{problems.map((p, i) => <li key={i}><b>{p.name}</b>: {p.message}</li>)}</ul>
        </Notice>
      )}
      {duplicates.length > 0 && (
        <Notice tone="info" title="이미 붙은 파일입니다">
          <ul className="pe-problems">{duplicates.map((p, i) => <li key={i}><b>{p.name}</b>: {p.message}</li>)}</ul>
        </Notice>
      )}

      <ConfirmDialog
        open={removing !== null}
        intent="destructive"
        title={`'${removing?.fileName ?? ''}'을(를) 지급 근거에서 삭제할까요?`}
        confirmLabel="삭제"
        cancelLabel="돌아가기"
        busy={removeM.isPending}
        error={removeM.error}
        onConfirm={() => { if (removing) removeM.mutate(removing); }}
        onCancel={() => setRemoving(null)}
      >
        <p>이 요청에서 파일이 지워집니다. 삭제 기록(파일 이름·크기·SHA-256)은 감사 기록에 남습니다.</p>
      </ConfirmDialog>
    </section>
  );
}
