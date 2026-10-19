import { useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api.ts';
import { useCatalog } from '../hooks.ts';
import { useMe } from '../auth.tsx';
import { AddressStrip, Field, fieldA11y, Notice, Term } from './ui.tsx';
import { amount as fmtAmount, dateTime, krw, krwShort } from '../format.ts';
import { AmountError, formatGrouped, formatUnits, krwValue, parseUnits } from '../../shared/decimal.ts';
import { GLOSSARY } from '../../shared/terms.ts';

export interface RequestFormValue { assetCode: string; networkCode: string; addressId: string; amount: string; purpose: string }

/** 승인 기준 금액 표기: 정확한 기준값이므로 '약'을 붙이지 않는다. 100000000 → "1억 원" */
export function krwThreshold(value: string): string {
  const v = BigInt(value);
  const eok = 100_000_000n;
  return v >= eok && v % eok === 0n ? `${formatGrouped((v / eok).toString())}억 원` : krw(value);
}

type Preview =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'ok'; quantity: string; krw: bigint | null; priceAsOf: string | null; priceState: string };

/** 입력한 수량을 서버와 같은 규칙(shared/decimal)으로 읽어 본다. 쉼표 위치가 틀리면 여기서 바로 드러난다. */
function readAmount(raw: string, precision: number | undefined, price: { krw: string | null; asOf: string | null; state: string }): Preview {
  if (!raw.trim() || precision === undefined) return { kind: 'empty' };
  try {
    const units = parseUnits(raw, precision);
    const krw = price.krw && price.state !== 'unavailable' ? krwValue(units, precision, price.krw) : null;
    return { kind: 'ok', quantity: formatGrouped(formatUnits(units, precision)), krw, priceAsOf: price.asOf, priceState: price.state };
  } catch (e) {
    if (e instanceof AmountError) return { kind: 'invalid', message: e.message };
    throw e;
  }
}

export function RequestForm({ value, onChange, error }: { value: RequestFormValue; onChange: (v: RequestFormValue) => void; error: unknown }) {
  const me = useMe();
  const cat = useCatalog();
  const bal = useQuery({ queryKey: ['balances'], queryFn: () => api('/api/balances') });
  const addrs = useQuery({ queryKey: ['addresses', 'for-request', value.assetCode, value.networkCode], queryFn: () => api(`/api/addresses?status=ACTIVE&assetCode=${value.assetCode}&networkCode=${value.networkCode}&sort=label`), enabled: !!value.assetCode && !!value.networkCode });
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
  const preview = readAmount(value.amount, asset?.precision, { krw: assetBal?.krwPrice ?? null, asOf: bal.data?.price?.asOf ?? null, state: bal.data?.price?.state ?? 'unavailable' });
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
        <Field label={<Term label="네트워크">{GLOSSARY.network}</Term>} htmlFor="networkCode" required error={err?.fieldError('networkCode')} hint={networks.length > 1 ? '받는 주소가 등록된 네트워크와 같아야 합니다.' : undefined}>
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
        {value.networkCode && addrs.data && addrs.data.items.length === 0 && (
          <Notice tone="info" title={`${value.assetCode} / ${networks.find((n) => n.code === value.networkCode)?.name}로 쓸 수 있는 주소가 없습니다`}>
            <Link to="/addresses/new">주소록에 먼저 등록</Link>하고 다른 담당자의 확인을 받으세요.
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
  return (
    <output htmlFor="amount" className="amount-preview small" style={{ display: 'block', marginTop: -4, color: 'var(--ink-2)' }}>
      읽은 수량 <b className="num" style={{ color: 'var(--ink)' }}>{preview.quantity} {unit}</b>
      {' · '}
      {priceKnown
        ? <>{krwShort(preview.krw!.toString())} (모의 시세 {dateTime(preview.priceAsOf).slice(11)} 기준)</>
        : <span className="warn-text" style={{ fontWeight: 600 }}>{preview.priceState === 'stale' ? '시세가 지연되어' : '시세가 없어'} 평가액을 확인할 수 없습니다</span>}
      {' · '}
      {!priceKnown
        ? <>이 경우 승인 요청 때 서로 다른 승인자 {highN}명이 필요합니다</>
        : high
          ? <b style={{ color: 'var(--ink)' }}>{threshold} 이상이라 서로 다른 승인자 {highN}명 필요</b>
          : <>{threshold} 이상이면 서로 다른 승인자 {highN}명 필요</>}
    </output>
  );
}
