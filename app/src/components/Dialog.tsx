import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { ApiErrorNotice } from './ui.tsx';

/**
 * 앱 공통 확인 대화상자(AlertDialog). 브라우저 confirm()을 쓰지 않는다.
 * - 네이티브 <dialog>.showModal(): 배경은 실제로 inert, Escape는 cancel 이벤트로 처리
 * - 열릴 때 안전한 선택(기본: 취소)에 초기 포커스. Escape는 안전한 선택이 취소일 때만 닫음, Tab/Shift+Tab은 대화상자 안에서 순환
 * - 처리 중(busy)에는 확정 버튼 비활성·Escape 무시·중복 확정 차단, 실패하면 열린 채 오류 표시
 * - 닫히면 열기 전 포커스(트리거)로 복귀, 트리거가 사라졌으면 화면 제목으로
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** destructive: 되돌릴 수 없는 작업(빨간 확정 버튼). caution: 작성 내용 버림 등 */
  intent?: 'destructive' | 'caution' | 'default';
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onCancel: () => void;
  /** 확정 쪽이 안전한 선택일 때(예: 세션 재로그인) 'confirm'. 기본은 취소에 초기 포커스 */
  safeAction?: 'cancel' | 'confirm';
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = '취소', intent = 'default', busy = false, error, onConfirm, onCancel, safeAction = 'cancel' }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const firing = useRef(false);
  const titleId = useId();
  const descId = useId();

  useEffect(() => { if (!busy) firing.current = false; }, [busy]);

  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      d.showModal();
      (safeAction === 'confirm' ? confirmRef : cancelRef).current?.focus();
    } else if (!open && d.open) {
      d.close();
      const back = returnTo.current;
      returnTo.current = null;
      if (back && back.isConnected && !back.closest('[inert]')) back.focus();
      else document.getElementById('page-title')?.focus();
    }
  }, [open]);

  // 언마운트 시 열린 모달이 남지 않게 한다.
  useEffect(() => () => { if (ref.current?.open) ref.current.close(); }, []);

  const confirm = () => {
    if (busy || firing.current) return;
    firing.current = true;
    onConfirm();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== 'Tab') return;
    const items = Array.from(ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${intent}`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      aria-busy={busy || undefined}
      onCancel={(e) => { e.preventDefault(); if (!busy && safeAction === 'cancel') onCancel(); }}
      onKeyDown={onKeyDown}
    >
      {open && (
        <div className="dialog-inner">
          <h2 id={titleId} className="dialog-title">
            {intent !== 'default' && <IconAlertTriangle size={20} aria-hidden="true" />}
            {title}
          </h2>
          <div id={descId} className="dialog-body">{children}</div>
          <ApiErrorNotice error={error} />
          <div className="dialog-actions">
            <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
            <button ref={confirmRef} type="button" className={`btn ${intent === 'destructive' ? 'btn-danger' : intent === 'caution' ? 'btn-danger-outline' : 'btn-primary'}`} onClick={confirm} aria-disabled={busy || undefined}>
              {busy ? '처리 중…' : confirmLabel}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
