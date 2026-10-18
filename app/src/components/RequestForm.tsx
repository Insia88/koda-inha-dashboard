import { useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api.ts';
import { useCatalog } from '../hooks.ts';
import { AddressStrip, Field, Notice, Term } from './ui.tsx';
import { amount as fmtAmount } from '../format.ts';
import { GLOSSARY } from '../../shared/terms.ts';

export interface RequestFormValue { assetCode: string; networkCode: string; addressId: string; amount: string; purpose: string }

export function RequestForm({ value, onChange, error }: { value: RequestFormValue; onChange: (v: RequestFormValue) => void; error: unknown }) {
  const cat = useCatalog();
  const bal = useQuery({ queryKey: ['balances'], queryFn: () => api('/api/balances') });
  const addrs = useQuery({ queryKey: ['addresses', 'for-request', value.assetCode, value.networkCode], queryFn: () => api(`/api/addresses?status=ACTIVE&assetCode=${value.assetCode}&networkCode=${value.networkCode}&sort=label`), enabled: !!value.assetCode && !!value.networkCode });
  const set = (p: Partial<RequestFormValue>) => onChange({ ...value, ...p });
  const err = error instanceof ApiError ? error : null;
  const networks = useMemo(() => {
    if (!cat.data || !value.assetCode) return [];
    const codes = cat.data.pairs.filter((p) => p.assetCode === value.assetCode).map((p) => p.networkCode);
    return cat.data.networks.filter((n) => codes.includes(n.code));
  }, [cat.data, value.assetCode]);
  useEffect(() => {
    if (networks.length === 1 && value.networkCode !== networks[0]!.code) set({ networkCode: networks[0]!.code, addressId: '' });
  }, [networks]); // eslint-disable-line
  const asset = cat.data?.assets.find((a) => a.code === value.assetCode);
  const walletRow = bal.data?.assets.find((a: any) => a.assetCode === value.assetCode)?.byWallet.find((w: any) => w.networkCode === value.networkCode);
  const selected = addrs.data?.items.find((a: any) => a.id === value.addressId);
  const heldAssets = new Set((bal.data?.assets ?? []).map((a: any) => a.assetCode));

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
        <Field label="받는 주소 (주소록의 사용 가능 주소만 표시)" htmlFor="addressId" required error={err?.fieldError('addressId')}>
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
        <Field label={`수량 (${value.assetCode || '단위'})`} htmlFor="amount" required error={err?.fieldError('amount')}
          hint={<>사용 가능 {walletRow ? fmtAmount(walletRow.available, value.assetCode) : '—'}{asset ? ` · 소수점 아래 최대 ${asset.precision}자리` : ''}</>}>
          <div className="input-unit">
            <input id="amount" inputMode="decimal" className="num" value={value.amount} onChange={(e) => set({ amount: e.target.value.replace(/[^0-9.,]/g, '') })} autoComplete="off" aria-describedby="amount-hint" maxLength={40} />
            <span>{value.assetCode}</span>
          </div>
        </Field>
        <Field label="요청 목적" htmlFor="purpose" required error={err?.fieldError('purpose')} hint="승인자가 판단할 수 있게 근거 문서나 정산 건을 적으세요.">
          <input id="purpose" value={value.purpose} onChange={(e) => set({ purpose: e.target.value })} maxLength={200} aria-describedby="purpose-hint" />
        </Field>
      </fieldset>
    </>
  );
}