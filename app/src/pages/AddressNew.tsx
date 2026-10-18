import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api.ts';
import { useMe } from '../auth.tsx';
import { useCatalog } from '../hooks.ts';
import { AddressStrip, ApiErrorNotice, Field, Loading, Notice, PageHeader, Term } from '../components/ui.tsx';
import { Findings } from '../components/Findings.tsx';
import { GLOSSARY } from '../../shared/terms.ts';
import { checkAddressFormat, type Finding, type NetworkRule } from '../../shared/address-rules.ts';

export function AddressNewPage() {
  const me = useMe();
  const cat = useCatalog();
  const nav = useNavigate();
  const qc = useQueryClient();
  const n = me.policy.confirmTailLength;
  const [f, setF] = useState({ assetCode: '', networkCode: '', address: '', memo: '', label: '', counterparty: '', confirmTail: '', ackNotVerified: false, ackOutOfBandConfirmed: false });
  const [serverFindings, setServerFindings] = useState<Finding[] | null>(null);
  const [touched, setTouched] = useState(false);
  const set = (patch: Partial<typeof f>) => setF((p) => ({ ...p, ...patch }));

  const networks = useMemo(() => {
    if (!cat.data || !f.assetCode) return [];
    const codes = cat.data.pairs.filter((p) => p.assetCode === f.assetCode).map((p) => p.networkCode);
    return cat.data.networks.filter((x) => codes.includes(x.code));
  }, [cat.data, f.assetCode]);
  const network = cat.data?.networks.find((x) => x.code === f.networkCode);

  useEffect(() => {
    if (networks.length === 1 && f.networkCode !== networks[0]!.code) set({ networkCode: networks[0]!.code });
    if (networks.length > 1 && f.networkCode && !networks.some((x) => x.code === f.networkCode)) set({ networkCode: '' });
  }, [networks]); // eslint-disable-line

  // 입력 즉시 화면에서 형식 점검 → 잠시 뒤 서버에서 중복·유사 주소까지 다시 점검
  const localFindings = useMemo(() => {
    if (!cat.data || !network || !f.address) return [];
    const rules = cat.data.networks.map((x) => ({ ...x, family: x.family as NetworkRule['family'], memoPattern: x.memoRequired ? /^\d{1,10}$/ : null }));
    return checkAddressFormat({ address: f.address, memo: f.memo }, rules.find((r) => r.code === network.code)!, rules);
  }, [cat.data, network, f.address, f.memo]);

  useEffect(() => {
    setServerFindings(null);
    if (!f.assetCode || !f.networkCode || !f.address.trim()) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await api('/api/addresses/check', { method: 'POST', body: { assetCode: f.assetCode, networkCode: f.networkCode, address: f.address, memo: f.memo }, signal: ctrl.signal });
        setServerFindings(r.findings);
      } catch { /* 화면 점검 결과를 계속 표시 */ }
    }, 400);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [f.assetCode, f.networkCode, f.address, f.memo]);

  const findings = serverFindings ?? localFindings;
  const hasError = findings.some((x) => x.level === 'error');
  const formatOk = !!f.address && !hasError && findings.length > 0;

  const m = useMutation({
    mutationFn: () => api('/api/addresses', { method: 'POST', body: f }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['addresses'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      nav(`/addresses/${r.address.id}`, { replace: true, state: { created: true } });
    },
  });
  const err = m.error instanceof ApiError ? m.error : null;
  const fe = (name: string) => (touched || err ? err?.fieldError(name) : undefined);

  if (cat.isPending) return <Loading />;

  return (
    <div className="page page-narrow">
      <PageHeader title="주소 등록" eyebrow={<Link to="/addresses">← 주소록</Link>} description="받는 곳에서 받은 정보를 그대로 입력하세요. 등록 후 다른 담당자가 확인해야 출금에 쓸 수 있습니다." />
      <form className="form" noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); m.mutate(); }}>
        <fieldset className="form-step">
          <legend><span className="step-no">1</span>무엇을 어느 네트워크로 받나요?</legend>
          <Field label="자산" htmlFor="assetCode" required error={fe('assetCode')}>
            <select id="assetCode" value={f.assetCode} onChange={(e) => set({ assetCode: e.target.value })} required>
              <option value="">자산 선택</option>
              {cat.data?.assets.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
            </select>
          </Field>
          <Field label={<Term label="네트워크">{GLOSSARY.network}</Term>} htmlFor="networkCode" required error={fe('networkCode')}
            hint={networks.length > 1 ? `${f.assetCode}는 여러 네트워크에서 쓰입니다. 받는 곳이 안내한 네트워크를 고르세요.` : undefined}>
            <select id="networkCode" value={f.networkCode} onChange={(e) => set({ networkCode: e.target.value })} disabled={!f.assetCode} required aria-describedby={networks.length > 1 ? 'networkCode-hint' : undefined}>
              <option value="">{f.assetCode ? '네트워크 선택' : '자산을 먼저 고르세요'}</option>
              {networks.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            </select>
          </Field>
          {networks.length > 1 && <Notice tone="warning" title="네트워크를 잘못 고르면 자산을 찾지 못할 수 있습니다">같은 {f.assetCode}라도 네트워크가 다르면 받는 곳에서 입금을 확인하지 못하고, 회수가 어렵거나 불가능할 수 있습니다.</Notice>}
        </fieldset>

        <fieldset className="form-step" disabled={!f.networkCode}>
          <legend><span className="step-no">2</span>받는 주소</legend>
          <Field label="주소" htmlFor="address" required error={fe('address')} hint="직접 타이핑하지 말고 받는 곳이 보낸 원본에서 복사해 붙여 넣으세요. 개발 환경은 MOCK- 로 시작하는 모의 주소만 받습니다.">
            <textarea id="address" className="mono" rows={2} value={f.address} onChange={(e) => set({ address: e.target.value })} spellCheck={false} autoComplete="off" aria-describedby="address-hint" maxLength={200} />
          </Field>
          {network?.memoRequired ? (
            <Field label={<Term label={network.memoLabel ?? '메모'}>{GLOSSARY.memo}</Term>} htmlFor="memo" required error={fe('memo')} hint={`${network.name}는 ${network.memoLabel}가 필요합니다. ${network.memoHint ?? ''}`}>
              <input id="memo" inputMode="numeric" value={f.memo} onChange={(e) => set({ memo: e.target.value })} aria-describedby="memo-hint" maxLength={10} />
            </Field>
          ) : network ? <p className="muted small">{network.name}는 메모/태그를 쓰지 않습니다.</p> : null}
          <Findings findings={findings} />
        </fieldset>

        <fieldset className="form-step" disabled={!formatOk}>
          <legend><span className="step-no">3</span>이름 붙이고 대조하기</legend>
          <Field label="주소 이름" htmlFor="label" required error={fe('label')} hint="목록에서 알아보기 쉬운 이름. 예: 모의 거래소 A 입금 (USDC)">
            <input id="label" value={f.label} onChange={(e) => set({ label: e.target.value })} maxLength={60} aria-describedby="label-hint" />
          </Field>
          <Field label="받는 곳 (법인·거래소명)" htmlFor="counterparty" required error={fe('counterparty')}>
            <input id="counterparty" value={f.counterparty} onChange={(e) => set({ counterparty: e.target.value })} maxLength={80} />
          </Field>
          {formatOk && (
            <div className="verify-box">
              <div className="verify-label">입력한 주소 — 앞·뒤 묶음을 받는 곳의 원본과 한 글자씩 대조하세요</div>
              <AddressStrip address={f.address.trim()} memo={f.memo} memoLabel={network?.memoLabel} />
            </div>
          )}
          <Field label={`주소 끝 ${n}자리를 원본을 보고 다시 입력`} htmlFor="confirmTail" required error={fe('confirmTail')} hint="붙여 넣은 값이 아니라 받는 곳이 보낸 원본 문서를 보고 입력하세요. 중간에 바뀐 주소를 찾기 위한 확인입니다.">
            <input id="confirmTail" className="mono" value={f.confirmTail} onChange={(e) => set({ confirmTail: e.target.value })} maxLength={20} autoComplete="off" onPaste={(e) => e.preventDefault()} aria-describedby="confirmTail-hint" />
          </Field>
          <div className="checks">
            <label className="check"><input type="checkbox" checked={f.ackOutOfBandConfirmed} onChange={(e) => set({ ackOutOfBandConfirmed: e.target.checked })} />받는 곳과 전화 등 별도 연락 수단으로 자산·네트워크·주소{network?.memoRequired ? '·태그' : ''}를 확인했습니다.</label>
            <label className="check"><input type="checkbox" checked={f.ackNotVerified} onChange={(e) => set({ ackNotVerified: e.target.checked })} />형식 점검과 담당자 확인은 주소의 주인이나 안전성을 보증하지 않는다는 점을 이해했습니다.</label>
          </div>
          {(fe('ackNotVerified') || fe('ackOutOfBandConfirmed')) && <p className="field-error" role="alert">{fe('ackOutOfBandConfirmed') ?? fe('ackNotVerified')}</p>}
        </fieldset>

        <ApiErrorNotice error={m.error} />
        <div className="form-actions">
          <Link to="/addresses" className="btn">취소</Link>
          <button type="submit" className="btn btn-primary" disabled={m.isPending || !formatOk}>{m.isPending ? '등록 중…' : '확인 요청 보내기'}</button>
        </div>
        <p className="muted small">등록하면 '확인 대기' 상태가 되고, 등록자가 아닌 승인자가 원본과 대조한 뒤 '사용 가능'으로 바꿉니다.</p>
      </form>
    </div>
  );
}