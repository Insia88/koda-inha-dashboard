import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { IconAlertTriangle, IconInfoCircle, IconLock, IconRefresh, IconCircleCheck, IconAlertOctagon, IconChevronLeft, IconChevronRight, IconChevronsLeft, IconChevronsRight } from '@tabler/icons-react';
import { ApiError } from '../api.ts';
import type { Tone } from '../../shared/terms.ts';
import { chunkAddress } from '../../shared/address-rules.ts';
import { dateTime, relative } from '../format.ts';

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 tabIndex={-1} id="page-title">{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge badge-${tone}`} title={title}><span className="badge-dot" aria-hidden="true" />{children}</span>;
}

export function Notice({ tone = 'info', title, children, role }: { tone?: Tone; title?: ReactNode; children?: ReactNode; role?: 'alert' | 'status' }) {
  const Icon = tone === 'danger' ? IconAlertOctagon : tone === 'warning' ? IconAlertTriangle : tone === 'success' ? IconCircleCheck : IconInfoCircle;
  return (
    <div className={`notice notice-${tone}`} role={role}>
      <Icon size={20} aria-hidden="true" className="notice-icon" />
      <div>
        {title && <strong className="notice-title">{title}</strong>}
        {children && <div className="notice-body">{children}</div>}
      </div>
    </div>
  );
}

export function Loading({ label = '불러오는 중' }: { label?: string }) {
  return <div className="state state-loading" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" />{label}…</div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error instanceof ApiError ? error : null;
  if (e?.status === 403) return <Forbidden message={e.body.message} action={e.body.action} />;
  return (
    <div className="state state-error" role="alert">
      <IconAlertOctagon size={28} aria-hidden="true" />
      <strong>{e?.body.message ?? '화면을 불러오지 못했습니다.'}</strong>
      <span>{e?.body.action ?? '잠시 후 다시 시도하세요.'}</span>
      {onRetry && <button className="btn" onClick={onRetry}><IconRefresh size={16} aria-hidden="true" />다시 시도</button>}
    </div>
  );
}

export function Forbidden({ message = '이 화면을 볼 권한이 없습니다.', action = '권한이 필요하면 조직 관리자에게 역할 변경을 요청하세요.' }: { message?: string; action?: string }) {
  return (
    <div className="state state-forbidden" role="alert">
      <IconLock size={28} aria-hidden="true" />
      <strong>{message}</strong>
      <span>{action}</span>
      <Link className="btn" to="/">홈으로</Link>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state state-empty">
      <strong>{title}</strong>
      {children && <span>{children}</span>}
      {action}
    </div>
  );
}

/** 주소 대조 띠: 4자 묶음, 앞·뒤 묶음 강조. 육안 대조를 돕지만 안전성을 보증하지 않는다. */
export function AddressStrip({ address, memo, memoLabel, compact }: { address: string; memo?: string | null; memoLabel?: string | null; compact?: boolean }) {
  const chunks = chunkAddress(address);
  const [prefix, ...body] = chunks[0]?.startsWith('MOCK') ? chunks : ['', ...chunks];
  const [copied, setCopied] = useState(false);
  return (
    <span className={`addr ${compact ? 'addr-compact' : ''}`}>
      <span className="addr-code" aria-label={`주소 ${address}`}>
        {prefix && <span className="addr-prefix">{prefix}</span>}
        {body.map((c, i) => (
          <span key={i} className={i < 1 || i >= body.length - 1 ? 'addr-key' : 'addr-mid'}>{c}</span>
        ))}
      </span>
      {!compact && (
        <button type="button" className="btn btn-ghost btn-xs" onClick={async () => { try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* 클립보드 권한 없음 */ } }}>
          {copied ? '복사됨' : '복사'}
        </button>
      )}
      {memo ? <span className="addr-memo">{memoLabel ?? '메모'} <b>{memo}</b></span> : null}
      <span className="sr-only" aria-live="polite">{copied ? '주소를 복사했습니다' : ''}</span>
    </span>
  );
}

export function DataStamp({ asOf, state, source, label = '기준' }: { asOf: string | null; state?: string; source?: string | null; label?: string }) {
  const tone: Tone = state === 'stale' ? 'warning' : state === 'unavailable' ? 'danger' : 'neutral';
  const stateLabel = state === 'stale' ? '시세 지연' : state === 'unavailable' ? '시세 없음' : state === 'mock' ? '모의 데이터' : null;
  return (
    <span className="stamp">
      <span>{label} {dateTime(asOf)} KST</span>
      {asOf && <span className="muted">({relative(asOf)})</span>}
      {source && <span className="muted">· {source}</span>}
      {stateLabel && <Badge tone={tone}>{stateLabel}</Badge>}
    </span>
  );
}

const STEPS = ['작성', '검토', '승인 대기', '처리 결과'];
export function StatusRail({ step, status, compact }: { step: number; status: string; compact?: boolean }) {
  const terminalBad = ['REJECTED', 'CANCELLED', 'FAILED'].includes(status);
  return (
    <ol className={`rail ${compact ? 'rail-compact' : ''}`} aria-label="진행 단계">
      {STEPS.map((s, i) => {
        const state = i < step ? 'done' : i === step ? (terminalBad ? 'bad' : status === 'COMPLETED' ? 'done' : 'current') : 'todo';
        return (
          <li key={s} className={`rail-step rail-${state}`} aria-current={i === step ? 'step' : undefined}>
            <span className="rail-dot" aria-hidden="true" />
            <span className="rail-label">{s}{i === step && <span className="sr-only"> (현재 단계)</span>}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function Term({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="term">
      {label}
      <button type="button" className="term-btn" aria-expanded={open} aria-controls={id} aria-label={`${label} 설명`} onClick={() => setOpen((o) => !o)}>
        <IconInfoCircle size={14} aria-hidden="true" />
      </button>
      {open && <span id={id} role="note" className="term-pop">{children}</span>}
    </span>
  );
}

export function Pagination({ page, pageSize, total, onPage, onPageSize, sizes = [10, 25, 50, 100], label = '건' }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (s: number) => void; sizes?: number[]; label?: string }) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="페이지 이동">
      <span className="pager-info" aria-live="polite">전체 {total.toLocaleString('ko-KR')}{label} 중 {from.toLocaleString('ko-KR')}–{to.toLocaleString('ko-KR')}</span>
      {onPageSize && (
        <label className="pager-size">
          <span>한 번에</span>
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {sizes.map((s) => <option key={s} value={s}>{s}{label}</option>)}
          </select>
        </label>
      )}
      <div className="pager-btns">
        <button type="button" className="btn btn-icon" onClick={() => onPage(1)} disabled={page <= 1} aria-label="첫 페이지"><IconChevronsLeft size={16} aria-hidden="true" /></button>
        <button type="button" className="btn btn-icon" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="이전 페이지"><IconChevronLeft size={16} aria-hidden="true" /></button>
        <span className="pager-page">{page} / {last}</span>
        <button type="button" className="btn btn-icon" onClick={() => onPage(page + 1)} disabled={page >= last} aria-label="다음 페이지"><IconChevronRight size={16} aria-hidden="true" /></button>
        <button type="button" className="btn btn-icon" onClick={() => onPage(last)} disabled={page >= last} aria-label="마지막 페이지"><IconChevronsRight size={16} aria-hidden="true" /></button>
      </div>
    </nav>
  );
}

export function Field({ label, hint, error, children, htmlFor, required }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; htmlFor: string; required?: boolean }) {
  return (
    <div className={`field ${error ? 'field-invalid' : ''}`}>
      <label htmlFor={htmlFor} className="field-label">{label}{required && <span className="req" aria-hidden="true"> *</span>}</label>
      {hint && <div className="field-hint" id={`${htmlFor}-hint`}>{hint}</div>}
      {children}
      {error && <div className="field-error" id={`${htmlFor}-error`} role="alert">{error}</div>}
    </div>
  );
}

export function ApiErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  return (
    <Notice tone="danger" title={e?.body.message ?? '처리하지 못했습니다.'} role="alert">
      {e?.body.action}
      {e?.requestId && e.status >= 500 && <div className="muted small">요청 번호 {e.requestId.slice(0, 8)}</div>}
    </Notice>
  );
}