import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconCircleCheck, IconHelpCircle } from '@tabler/icons-react';
import { api, ApiError } from '../api.ts';
import { useCatalog } from '../hooks.ts';
import { useMe } from '../auth.tsx';
import { AddressStrip, Field, fieldA11y, Notice, Term, TextareaAuto } from './ui.tsx';
import { amount as fmtAmount, dateTime, krw, krwShort } from '../format.ts';
import { AmountError, formatGrouped, formatUnits, krwValue, parseUnits } from '../../shared/decimal.ts';
import { CHECK_OUTCOME, CHECK_REASON_MIN_LENGTH, GLOSSARY, type CheckOutcome, type RequestCheck } from '../../shared/terms.ts';
import './request-checks.css';

export interface RequestFormValue { assetCode: string; networkCode: string; addressId: string; amount: string; purpose: string }

const OUTCOME_ICON: Record<CheckOutcome, typeof IconCircleCheck> = { pass: IconCircleCheck, caution: IconAlertTriangle, unknown: IconHelpCircle };
/** 네트워크 선택 칸의 도움말 끝에 붙이는 문장(A1). 주소 등록 화면도 같은 문장을 쓴다. 낱말 '네트워크'는 그대로 두고 거래처에 물을 질문을 알려 준다. */
export const NETWORK_ASK_HINT = '거래처 안내문의 네트워크 이름이 이 목록과 다르면, 거래처에 어느 블록체인 네트워크로 받는지 물어 확인하세요.';
/** 점검 목록의 보이는 순서: 주의 → 확인 불가 → 기준 이내 */
const OUTCOME_RANK: Record<CheckOutcome, number> = { caution: 0, unknown: 1, pass: 2 };

/** '주의 1건 · 확인 불가 1건 · 기준 이내 3건' (0건인 결과는 쓰지 않는다) */
export function checkSummary(items: RequestCheck[]): string {
  return (['caution', 'unknown', 'pass'] as CheckOutcome[])
    .map((o) => [o, items.filter((i) => i.outcome === o).length] as const)
    .filter(([, n]) => n > 0)
    .map(([o, n]) => `${CHECK_OUTCOME[o].label} ${n}건`)
    .join(' · ');
}

/**
 * 출금 전 점검 목록(F8·F13·F14). 항목마다 아이콘과 결과 글자를 함께 둔다(색만으로 구분하지 않음).
 * - onReason을 주면 사유가 필요한 주의 항목 아래에 진행 사유 입력을 둔다(검토 단계).
 * - showReasons면 제출 때 저장한 요청자 사유를 보인다(승인 화면).
 * - 둘 다 아니면(작성 화면 미리 보기·작성 중 상세) 사유가 필요한 주의 항목에 「사유 필요」 표시를 붙인다(어느 항목에 사유를 적어야 하는지 미리 알 수 있게).
 * - compact(작성 화면 미리 보기)는 항목 사이 간격을 줄인다.
 * - requesterView는 요청자가 보는 화면이다. '확인 불가' 뜻 문장 끝의 '진행 사유는 적지 않아도 됩니다'는 요청자에게만 붙인다(승인자·감사 담당자의 할 일로 읽히지 않게).
 * 보이는 순서(A1): 주의 → 확인 불가를 펼쳐 먼저 두고, 기준 이내 항목은 아래 접힌 묶음(네이티브 <details>)에 넣는다.
 * 항목은 하나도 빼지 않는다(묶음 안에도 같은 결과·세부 내용·기준이 있다). 사유가 필요하거나 저장된 사유가 있는 항목은 결과와 관계없이 접지 않는다(A-28).
 * 요약 줄('주의 n건 · 확인 불가 n건 · 기준 이내 n건')과 각주(기준은 설계 가정, 보증 아님)는 접히지 않는다.
 */
export function CheckList({ items, title, intro, reasons, onReason, reasonError, showReasons, compact, footnote, requesterView = false, level = 3 }: {
  items: RequestCheck[]; title: string; level?: 2 | 3; intro?: string; reasons?: Record<string, string>; onReason?: (id: string, value: string) => void;
  reasonError?: (id: string) => string | undefined; showReasons?: boolean; compact?: boolean; footnote?: string; requesterView?: boolean;
}) {
  const headId = useId();
  const folded = (c: RequestCheck) => c.outcome === 'pass' && !c.requiresReason && !(showReasons && c.reason);
  // 서버가 정한 항목 순서는 결과 안에서 그대로 둔다(안정 정렬).
  const shownFirst = items.filter((c) => !folded(c)).sort((a, b) => (OUTCOME_RANK[a.outcome] ?? 1) - (OUTCOME_RANK[b.outcome] ?? 1));
  const passItems = items.filter(folded);
  const renderItem = (c: RequestCheck) => {
    const Icon = OUTCOME_ICON[c.outcome] ?? IconHelpCircle;
    const fieldId = `check-reason-${c.id}`;
    const outcomeLabel = CHECK_OUTCOME[c.outcome]?.label ?? c.outcome;
    // '확인 불가(시세 없음)'처럼 결과 글자로 시작하는 문장은 결과 표시와 겹치지 않게 괄호 안만 보인다(결과 표시 + '시세 없음').
    const shown = c.label.startsWith(`${outcomeLabel}(`) && c.label.endsWith(')') ? c.label.slice(outcomeLabel.length + 1, -1) : c.label;
    return (
      <li key={c.id} className={`rc-item rc-${c.outcome}`}>
        <Icon size={18} aria-hidden="true" className="rc-icon" />
        <div className="rc-body">
          <p className="rc-line">
            <span className="rc-outcome">{outcomeLabel}</span><span className="rc-label">{shown}</span>
            {c.requiresReason && !onReason && !showReasons && <span className="rc-need">사유 필요</span>}
          </p>
          {/* '확인 불가'가 실패나 통과로 읽히지 않게 뜻을 한 줄로 붙인다(A1). */}
          {c.outcome === 'unknown' && (
            <p className="rc-unknown-note">{c.requiresReason || !requesterView ? '자료가 부족해 판단하지 못한 항목입니다. 문제가 없다는 뜻은 아닙니다.' : '자료가 부족해 판단하지 못한 항목입니다. 문제가 없다는 뜻은 아니며, 진행 사유는 적지 않아도 됩니다.'}</p>
          )}
          <p className="rc-detail">{c.detail}</p>
          <p className="rc-basis">기준: {c.basis}</p>
          {showReasons && c.reason && <div className="rc-reason"><b>요청자 진행 사유</b><p>{c.reason}</p></div>}
          {onReason && c.requiresReason && (
            <Field label={`진행 사유: ${c.label}`} htmlFor={fieldId} required error={reasonError?.(c.id)} hint={`그대로 진행하는 이유를 글자·숫자 ${CHECK_REASON_MIN_LENGTH}자 이상으로 적어 주세요. 승인자에게 함께 보입니다.`}>
              <TextareaAuto id={fieldId} rows={2} maxRows={6} maxLength={300} value={reasons?.[c.id] ?? ''} onChange={(e) => onReason(c.id, e.target.value)} />
            </Field>
          )}
        </div>
      </li>
    );
  };
  return (
    <div className={`rc-block${compact ? ' rc-compact' : ''}`}>
      <div className="rc-head">
        {level === 2 ? <h2 id={headId}>{title}</h2> : <h3 id={headId}>{title}</h3>}
        <span className="rc-summary">{checkSummary(items)}</span>
      </div>
      {intro && <p className="rc-intro">{intro}</p>}
      {shownFirst.length > 0
        ? <ul className="rc-list" aria-labelledby={headId}>{shownFirst.map(renderItem)}</ul>
        : <p className="rc-none">주의·확인 불가 항목이 없습니다.</p>}
      {passItems.length > 0 && (
        <details className="rc-pass-group">
          <summary>기준 이내 {passItems.length}건 · 기준과 세부 내용 보기</summary>
          <ul className="rc-list" aria-label={`기준 이내 ${passItems.length}건`}>{passItems.map(renderItem)}</ul>
        </details>
      )}
      {footnote && <p className="rc-footnote">{footnote}</p>}
    </div>
  );
}

/**
 * 승인 대상 지문(F10): 승인 요청 때 고정한 내용의 지문과 한 줄 설명. 요청자·승인자 화면에 같은 값이 보인다.
 * mismatch: 서버가 지금 저장된 내용으로 다시 계산한 지문이 이 값과 다르다(blockedReason INTENT_TAMPERED). 화면의 내용이 승인 요청 때와 다르다는 것을 지문 옆에 알린다.
 */
export function IntentFingerprint({ display, mismatch = false }: { display: string | null; mismatch?: boolean }) {
  const labelId = useId();
  return (
    <div className={`rc-intent${mismatch ? ' rc-intent-bad' : ''}`} role="group" aria-labelledby={labelId}>
      <span className="rc-intent-label" id={labelId}>승인 대상 지문</span>
      {display
        ? <span className="rc-intent-value">{display}</span>
        : <span className="rc-intent-missing">기록 없음 · 지문을 기록하기 전에 승인 요청된 요청이라 승인할 수 없습니다</span>}
      {mismatch && (
        <p className="rc-intent-mismatch">
          <IconAlertTriangle size={16} aria-hidden="true" /> 지금 요청 내용으로 다시 계산한 지문과 다릅니다. 승인 요청 뒤 내용이 바뀌었으므로 화면의 수량·받는 주소를 승인 근거로 쓰지 마세요.
        </p>
      )}
      <p className="rc-intent-note">자산·수량·받는 주소·네트워크·메모·필요 승인 수를 묶어 만든 값으로, 승인 요청 뒤 이 중 하나라도 바뀌면 지문이 달라져 승인되지 않습니다.</p>
    </div>
  );
}

/** 입력이 멈춘 뒤에만 값을 넘긴다(수량을 칠 때마다 점검을 다시 부르지 않게). */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** 승인 기준 금액 표기: 정확한 기준값이므로 '약'을 붙이지 않는다. 100000000 → "1억 원" */
export function krwThreshold(value: string): string {
  const v = BigInt(value);
  const eok = 100_000_000n;
  return v >= eok && v % eok === 0n ? `${formatGrouped((v / eok).toString())}억 원` : krw(value);
}

type Preview =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; quantity: string; krw: bigint | null; priceAsOf: string | null; priceState: string; positive: boolean };

/** 입력한 수량을 서버와 같은 규칙(shared/decimal)으로 읽어 본다. 쉼표 위치가 틀리면 여기서 바로 드러난다. */
function readAmount(raw: string, precision: number | undefined, price: { krw: string | null; asOf: string | null; state: string }): Preview {
  if (!raw.trim() || precision === undefined) return { kind: 'empty' };
  try {
    const units = parseUnits(raw, precision);
    const krw = price.krw && price.state !== 'unavailable' ? krwValue(units, precision, price.krw) : null;
    return { kind: 'ok', quantity: formatGrouped(formatUnits(units, precision)), krw, priceAsOf: price.asOf, priceState: price.state, positive: units > 0n };
  } catch (e) {
    if (e instanceof AmountError) return { kind: 'invalid', message: e.message };
    throw e;
  }
}

/**
 * 작성 화면의 출금 전 점검 미리 보기. 자산·네트워크·주소를 고르고 수량을 읽을 수 있으면 서버에 물어본다(저장하지 않음).
 * 검토 단계와 승인 요청 때 서버가 같은 규칙으로 다시 계산하므로, 여기서 못 불러와도 작성은 막지 않는다.
 */
function ChecksPreview({ value, requestId, amountReadable }: { value: RequestFormValue; requestId?: string; amountReadable: boolean }) {
  const amount = useSettled(value.amount.trim(), 400);
  const ready = amountReadable && !!value.assetCode && !!value.networkCode && !!value.addressId && amount === value.amount.trim();
  const q = useQuery({
    queryKey: ['request-checks-preview', value.assetCode, value.networkCode, value.addressId, amount, requestId ?? ''],
    queryFn: ({ signal }) => api<{ evaluatedAt: string; items: RequestCheck[] }>('/api/requests/checks-preview', {
      method: 'POST', signal, body: { assetCode: value.assetCode, networkCode: value.networkCode, addressId: value.addressId, amount, ...(requestId ? { requestId } : {}) },
    }),
    enabled: ready,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  if (!value.addressId || !amountReadable) return null;
  if (q.isError) {
    // 고른 받는 주소를 지금 쓸 수 없으면(그 사이 사용 중지 등) 검토 단계로 갈 수 없으므로 '검토 단계에서 다시 보여 드립니다'라고 하지 않는다.
    if (q.error instanceof ApiError && q.error.code === 'ADDRESS_NOT_ACTIVE') {
      return <p className="warn-text small" style={{ margin: 0 }}>고른 받는 주소를 지금 쓸 수 없어 출금 전 점검을 보여 드리지 않습니다. 사용 가능한 다른 받는 주소를 고르세요.</p>;
    }
    return <p className="muted small" style={{ margin: 0 }}>출금 전 점검 미리 보기를 불러오지 못했습니다. 검토 단계에서 다시 보여 드립니다.</p>;
  }
  if (!q.data) return null;
  const needsReason = q.data.items.some((c) => c.requiresReason);
  return (
    <CheckList compact requesterView title="출금 전 점검 미리 보기" items={q.data.items}
      intro={needsReason ? '「사유 필요」 표시가 있는 주의 항목은 검토 단계에서 진행 사유를 적어야 승인 요청을 보낼 수 있습니다. 이 대시보드로 처음 보내는 주소라면 소액 시험 전송을 먼저 요청하는 방법도 있습니다.' : undefined}
      footnote="점검 기준은 설계 가정이며, 검토 단계에서 기준과 함께 다시 보여 드립니다." />
  );
}

export function RequestForm({ value, onChange, error, requestId }: { value: RequestFormValue; onChange: (v: RequestFormValue) => void; error: unknown; requestId?: string }) {
  const me = useMe();
  const cat = useCatalog();
  const bal = useQuery({ queryKey: ['balances'], queryFn: () => api('/api/balances') });
  const addrs = useQuery({ queryKey: ['addresses', 'for-request', value.assetCode, value.networkCode], queryFn: () => api(`/api/addresses?status=ACTIVE&assetCode=${value.assetCode}&networkCode=${value.networkCode}&sort=label`), enabled: !!value.assetCode && !!value.networkCode });
  // 같은 자산·네트워크의 사용 대기 주소: 고를 수는 없지만, 언제부터 쓸 수 있는지와 할 일을 선택 상자 아래에 알린다.
  const waiting = useQuery({ queryKey: ['addresses', 'for-request-waiting', value.assetCode, value.networkCode], queryFn: () => api(`/api/addresses?status=COOLING_DOWN&assetCode=${value.assetCode}&networkCode=${value.networkCode}&sort=label`), enabled: !!value.assetCode && !!value.networkCode });
  const waitingItems: any[] = waiting.data?.items ?? [];
  const set = (p: Partial<RequestFormValue>) => onChange({ ...value, ...p });
  const err = error instanceof ApiError ? error : null;
  // 필드 오류는 지금 입력할 수 있는 단계에만 표시한다(잠긴 단계의 오류는 앞 단계를 마친 뒤 다시 확인된다).
  const step2Err = value.networkCode ? err : null;
  const step3Err = value.addressId ? err : null;
  const networks = useMemo(() => {
    if (!cat.data || !value.assetCode) return [];
    const codes = cat.data.pairs.filter((p) => p.assetCode === value.assetCode).map((p) => p.networkCode);
    return cat.data.networks.filter((n) => codes.includes(n.code));
  }, [cat.data, value.assetCode]);
  useEffect(() => {
    if (networks.length === 1 && value.networkCode !== networks[0]!.code) set({ networkCode: networks[0]!.code, addressId: '' });
  }, [networks]); // eslint-disable-line
  const asset = cat.data?.assets.find((a) => a.code === value.assetCode);
  const assetBal = bal.data?.assets.find((a: any) => a.assetCode === value.assetCode);
  const walletRow = assetBal?.byWallet.find((w: any) => w.networkCode === value.networkCode);
  const selected = addrs.data?.items.find((a: any) => a.id === value.addressId);
  const heldAssets = new Set((bal.data?.assets ?? []).map((a: any) => a.assetCode));
  const rule = me.policy.approval;
  const highN = Math.max(rule.highValueRequiredApprovals, rule.defaultRequiredApprovals);
  // 시세를 불러오는 중이거나 불러오지 못했으면 '시세 없음'과 구분한다(원인이 다르고, 시세 없음일 때의 승인 수 안내가 맞지 않는다).
  const priceInput = bal.isError ? { krw: null, asOf: null, state: 'load_error' }
    : bal.isPending ? { krw: null, asOf: null, state: 'loading' }
      : { krw: assetBal?.krwPrice ?? null, asOf: bal.data?.price?.asOf ?? null, state: bal.data?.price?.state ?? 'unavailable' };
  const preview = readAmount(value.amount, asset?.precision, priceInput);
  const amountError = step3Err?.fieldError('amount');

  return (
    <>
      <fieldset className="form-step">
        <legend><span className="step-no">1</span>보낼 자산</legend>
        <Field label="자산" htmlFor="assetCode" required error={err?.fieldError('assetCode')}>
          <select id="assetCode" value={value.assetCode} onChange={(e) => set({ assetCode: e.target.value, networkCode: '', addressId: '' })}>
            <option value="">자산 선택</option>
            {cat.data?.assets.filter((a) => heldAssets.has(a.code)).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        </Field>
        <Field label={<Term label="네트워크">{GLOSSARY.network}</Term>} htmlFor="networkCode" required error={err?.fieldError('networkCode')} hint={`${networks.length > 1 ? '받는 주소가 등록된 네트워크와 같아야 합니다. ' : ''}${NETWORK_ASK_HINT}`}>
          <select id="networkCode" value={value.networkCode} onChange={(e) => set({ networkCode: e.target.value, addressId: '' })} disabled={!value.assetCode}>
            <option value="">{value.assetCode ? '네트워크 선택' : '자산을 먼저 고르세요'}</option>
            {networks.map((n) => <option key={n.code} value={n.code}>{n.name}</option>)}
          </select>
        </Field>
      </fieldset>
      <fieldset className="form-step" disabled={!value.networkCode}>
        <legend><span className="step-no">2</span>받는 곳</legend>
        <Field label="받는 주소 (주소록의 사용 가능 주소만 표시)" htmlFor="addressId" required error={step2Err?.fieldError('addressId')}>
          <select id="addressId" value={value.addressId} onChange={(e) => set({ addressId: e.target.value })}>
            <option value="">{addrs.isFetching ? '불러오는 중…' : '받는 주소 선택'}</option>
            {addrs.data?.items.map((a: any) => <option key={a.id} value={a.id}>{a.label} — {a.counterparty}</option>)}
          </select>
        </Field>
        {value.networkCode && addrs.data && addrs.data.items.length === 0 && !waiting.isPending && waitingItems.length === 0 && (
          <Notice tone="info" title={`${value.assetCode} / ${networks.find((n) => n.code === value.networkCode)?.name}로 쓸 수 있는 주소가 없습니다`}>
            <Link to="/addresses/new">주소록에 먼저 등록</Link>하고 다른 담당자의 확인을 받으세요.
          </Notice>
        )}
        {value.networkCode && addrs.data && waitingItems.length > 0 && (
          <Notice tone="info" title={addrs.data.items.length === 0
            ? `${value.assetCode} / ${networks.find((n) => n.code === value.networkCode)?.name}로 지금 쓸 수 있는 주소가 없습니다`
            : `사용 대기 중인 주소 ${waitingItems.length}건은 아직 고를 수 없습니다`}>
            <ul className="rc-waiting">
              {waitingItems.map((a) => (
                <li key={a.id}>
                  {/* 정지 버튼이 있는 주소 상세로 바로 간다(요청자도 주소 등록 권한으로 사용 대기 중 정지를 할 수 있다). */}
                  <Link to={`/addresses/${a.id}`} style={{ fontWeight: 700 }}>{a.label}</Link> <span className="muted">· {a.counterparty}</span>
                  <span className="rc-waiting-when">{a.activeFrom ? `${dateTime(a.activeFrom)} KST부터 사용 가능` : '사용 대기 중'}</span>
                </li>
              ))}
            </ul>
            사용 가능해질 때까지 기다린 뒤 다시 요청하세요. 요청한 적 없는 등록이라면 주소 상세에서 「사용 대기 중 정지」로 바로 정지하세요.
          </Notice>
        )}
        {selected && <div className="verify-box"><div className="verify-label">선택한 주소</div><AddressStrip address={selected.address} memo={selected.memo} /></div>}
      </fieldset>
      <fieldset className="form-step" disabled={!value.addressId}>
        <legend><span className="step-no">3</span>수량과 목적</legend>
        <Field label={`수량 (${value.assetCode || '단위'})`} htmlFor="amount" required error={amountError}
          hint={<>사용 가능 {walletRow ? fmtAmount(walletRow.available, value.assetCode) : '—'}{asset ? ` · 소수점 아래 최대 ${asset.precision}자리 · 쉼표는 천 단위 구분에만` : ''}</>}>
          <div className="input-unit">
            <input id="amount" inputMode="decimal" className="num" value={value.amount} onChange={(e) => set({ amount: e.target.value.replace(/[^0-9.,]/g, '') })} autoComplete="off" maxLength={40} aria-required="true" {...fieldA11y('amount', true, amountError)} />
            <span>{value.assetCode}</span>
          </div>
        </Field>
        <AmountPreview preview={preview} unit={value.assetCode} thresholdKrw={rule.highValueThresholdKrw} highN={highN} serverMessage={amountError} />
        <Field label="요청 목적" htmlFor="purpose" required error={step3Err?.fieldError('purpose')} hint="승인자가 판단할 수 있게 근거 문서나 정산 건을 적으세요.">
          <input id="purpose" value={value.purpose} onChange={(e) => set({ purpose: e.target.value })} maxLength={200} />
        </Field>
        {/* 새 요청: 지급 근거(A2b)는 초안을 저장한 뒤 요청 화면에서 붙인다. 작성 양식의 값과 검증은 그대로다. */}
        {!requestId && <p className="muted small" style={{ margin: '-4px 0 0' }}>지급 근거 파일(PDF·PNG·JPEG)과 메모는 초안을 저장한 뒤 요청 화면의 「지급 근거」에서 붙일 수 있습니다.</p>}
        <ChecksPreview value={value} requestId={requestId} amountReadable={preview.kind === 'ok' && preview.positive} />
      </fieldset>
    </>
  );
}

/**
 * 수량 바로 아래 한 줄: 읽은 수량, 모의 시세 기준 원화 평가액, 필요 승인 수 기준.
 * 화면 낭독기는 입력을 멈춘 뒤 이 줄을 읽는다(output = status). 입력의 aria-describedby(도움말·오류)는 바꾸지 않는다.
 */
function AmountPreview({ preview, unit, thresholdKrw, highN, serverMessage }: { preview: Preview; unit: string; thresholdKrw: string; highN: number; serverMessage?: string }) {
  const threshold = krwThreshold(thresholdKrw);
  if (preview.kind === 'empty') return null;
  if (preview.kind === 'invalid') {
    // 같은 내용의 서버 오류가 바로 위에 있으면 다시 쓰지 않는다.
    if (serverMessage === preview.message) return null;
    return <output htmlFor="amount" className="amount-preview warn-text small" style={{ display: 'block', marginTop: -4 }}>입력한 수량을 읽을 수 없습니다. {preview.message}</output>;
  }
  const high = preview.krw !== null && preview.krw >= BigInt(thresholdKrw);
  const priceKnown = preview.krw !== null && preview.priceState === 'mock';
  // 시세를 아직 못 받았거나 받지 못한 경우: 시세가 없다고 말하지 않고, 승인 수는 규칙만 보인다.
  const notLoaded = preview.priceState === 'loading' || preview.priceState === 'load_error';
  return (
    <output htmlFor="amount" className="amount-preview small" style={{ display: 'block', marginTop: -4, color: 'var(--ink-2)' }}>
      읽은 수량 <b className="num" style={{ color: 'var(--ink)' }}>{preview.quantity} {unit}</b>
      {' · '}
      {priceKnown
        ? <>{krwShort(preview.krw!.toString())} (모의 시세 {dateTime(preview.priceAsOf).slice(11)} 기준)</>
        : preview.priceState === 'loading'
          ? <>시세를 불러오는 중…</>
          : preview.priceState === 'load_error'
            ? <span className="warn-text" style={{ fontWeight: 600 }}>시세를 불러오지 못해 평가액을 확인할 수 없습니다</span>
            : <span className="warn-text" style={{ fontWeight: 600 }}>{preview.priceState === 'stale' ? '시세가 지연되어' : '시세가 없어'} 평가액을 확인할 수 없습니다</span>}
      {' · '}
      {notLoaded
        ? <>{threshold} 이상이면 서로 다른 승인자 {highN}명 필요</>
        : !priceKnown
        ? <>이 경우 승인 요청 때 서로 다른 승인자 {highN}명이 필요합니다</>
        : high
          ? <b style={{ color: 'var(--ink)' }}>{threshold} 이상이라 서로 다른 승인자 {highN}명 필요</b>
          : <>{threshold} 이상이면 서로 다른 승인자 {highN}명 필요</>}
    </output>
  );
}
