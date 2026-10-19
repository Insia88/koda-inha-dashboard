import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api.ts';
import { useMe } from '../auth.tsx';
import { useCatalog } from '../hooks.ts';
import { AddressStrip, ApiErrorNotice, Field, Loading, Notice, PageHeader, Term, TextareaAuto } from '../components/ui.tsx';
import { useFocusFirstError } from '../lib/forms.ts';
import { useUnsavedGuard } from '../lib/unsaved.tsx';
import { Findings } from '../components/Findings.tsx';
import { LookalikeComparisons } from '../components/AddressCompare.tsx';
import { GLOSSARY, RECEIVED_VIA, VERIFIED_VIA } from '../../shared/terms.ts';
import { checkAddressFormat, CONFIRM_MIDDLE_LENGTH, middleSegment, XRPL_TAG_PATTERN, type Finding, type NetworkRule } from '../../shared/address-rules.ts';
import { LifecycleSteps, useAddressPolicy } from './AddressDetail.tsx';
import '../components/address-lifecycle.css';

const EMPTY = {
  assetCode: '', networkCode: '', address: '', memo: '', label: '', counterparty: '', confirmTail: '', confirmMiddle: '', lookalikeReason: '',
  receivedVia: '', verifiedVia: '', verifiedWith: '',
  ackNotVerified: false, ackOutOfBandConfirmed: false,
};

/** 원본을 보고 직접 입력해야 하는 값: 붙여넣기·끌어 놓기를 막는다. */
const blockPaste = (e: ClipboardEvent | DragEvent) => e.preventDefault();

export function AddressNewPage() {
  const me = useMe();
  const cat = useCatalog();
  const policy = useAddressPolicy();
  const nav = useNavigate();
  const qc = useQueryClient();
  const n = me.policy.confirmTailLength;
  const [f, setF] = useState(EMPTY);
  const formRef = useRef<HTMLFormElement>(null);
  const guard = useUnsavedGuard(JSON.stringify(f) !== JSON.stringify(EMPTY));
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
    const rules = cat.data.networks.map((x) => ({ ...x, family: x.family as NetworkRule['family'], memoPattern: x.memoRequired ? XRPL_TAG_PATTERN : null }));
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
  const lookalike = findings.some((x) => x.code === 'ADDRESS_LOOKALIKE');
  const mid = middleSegment(f.address);
  const bodyPrefix = f.address.trim().match(/^MOCK-[A-Z]+-/)?.[0] ?? "'MOCK-계열-'";

  const m = useMutation({
    mutationFn: () => api('/api/addresses', { method: 'POST', body: f }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['addresses'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      guard.allowNavigation();
      nav(`/addresses/${r.address.id}`, { replace: true, state: { created: true } });
    },
    // 서버가 점검 결과를 함께 돌려주면(유사 주소 사유 누락 등) 화면의 점검 결과를 서버 기준으로 맞춘다.
    onError: (e) => { if (e instanceof ApiError && Array.isArray(e.body.findings)) setServerFindings(e.body.findings as Finding[]); },
  });
  const err = m.error instanceof ApiError ? m.error : null;
  useFocusFirstError(formRef, m.error);
  const fe = (name: string) => (touched || err ? err?.fieldError(name) : undefined);
  // 받은 경로와 같은 경로로는 다시 확인한 것으로 보지 않는다(등록 때 다시 검사). 고르는 즉시 알린다.
  const sameChannel = !!f.receivedVia && f.receivedVia === f.verifiedVia;
  const sameChannelText = '받은 경로와 같은 경로입니다. 주소를 받은 경로와 다른 경로로 다시 확인하세요.';

  if (cat.isPending) return <Loading />;

  return (
    <div className="page page-narrow">
      <PageHeader title="주소 등록" eyebrow={<Link to="/addresses">← 주소록</Link>} description="받는 곳에서 받은 정보를 그대로 입력하세요. 등록 후 다른 담당자가 확인해야 출금에 쓸 수 있습니다." />
      <form ref={formRef} className="form" noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!m.isPending) m.mutate(); }}>
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
            <select id="networkCode" value={f.networkCode} onChange={(e) => set({ networkCode: e.target.value })} disabled={!f.assetCode} required>
              <option value="">{f.assetCode ? '네트워크 선택' : '자산을 먼저 고르세요'}</option>
              {networks.map((x) => <option key={x.code} value={x.code}>{x.name}</option>)}
            </select>
          </Field>
          {networks.length > 1 && <Notice tone="warning" title="네트워크를 잘못 고르면 자산을 찾지 못할 수 있습니다">같은 {f.assetCode}라도 네트워크가 다르면 받는 곳에서 입금을 확인하지 못하고, 회수가 어렵거나 불가능할 수 있습니다.</Notice>}
        </fieldset>

        <fieldset className="form-step" disabled={!f.networkCode}>
          <legend><span className="step-no">2</span>받는 주소</legend>
          <Field label="주소" htmlFor="address" required error={fe('address')} hint="직접 타이핑하지 말고 받는 곳이 보낸 원본에서 복사해 붙여 넣으세요. 개발 환경은 MOCK- 로 시작하는 모의 주소만 받습니다.">
            <TextareaAuto id="address" className="mono" rows={2} maxRows={4} value={f.address} onChange={(e) => set({ address: e.target.value })} spellCheck={false} autoComplete="off" maxLength={200} />
          </Field>
          {network?.memoRequired ? (
            <Field label={<Term label={network.memoLabel ?? '메모'}>{GLOSSARY.memo}</Term>} htmlFor="memo" required error={fe('memo')} hint={`${network.name}는 ${network.memoLabel}가 필요합니다. ${network.memoHint ?? ''}`}>
              <input id="memo" inputMode="numeric" value={f.memo} onChange={(e) => set({ memo: e.target.value })} maxLength={10} />
            </Field>
          ) : network ? <p className="muted small">{network.name}는 메모/태그를 쓰지 않습니다.</p> : null}
          <Findings findings={findings} />
          {lookalike && <LookalikeComparisons address={f.address} findings={findings} candidateLabel="입력한 주소" />}
        </fieldset>

        <fieldset className="form-step" disabled={!formatOk}>
          <legend><span className="step-no">3</span>이름 붙이고 대조하기</legend>
          <Field label="주소 이름" htmlFor="label" required error={fe('label')} hint="목록에서 알아보기 쉬운 이름. 예: 모의 거래소 A 입금 (USDC)">
            <input id="label" value={f.label} onChange={(e) => set({ label: e.target.value })} maxLength={60} />
          </Field>
          <Field label="받는 곳 (법인·거래소명)" htmlFor="counterparty" required error={fe('counterparty')}>
            <input id="counterparty" value={f.counterparty} onChange={(e) => set({ counterparty: e.target.value })} maxLength={80} />
          </Field>
          {formatOk && (
            <div className="verify-box">
              <div className="verify-label">입력한 주소 — 가운데를 포함한 전체 글자를 받는 곳의 원본과 한 글자씩 대조하세요</div>
              <AddressStrip address={f.address.trim()} memo={f.memo} memoLabel={network?.memoLabel} verify />
            </div>
          )}
          <Field label={`주소 끝 ${n}자리를 원본을 보고 다시 입력`} htmlFor="confirmTail" required error={fe('confirmTail')} hint="붙여 넣은 값이 아니라 받는 곳이 보낸 원본 문서를 보고 입력하세요.">
            <input id="confirmTail" className="mono" value={f.confirmTail} onChange={(e) => set({ confirmTail: e.target.value })} maxLength={20} autoComplete="off" spellCheck={false} onPaste={blockPaste} onDrop={blockPaste} />
          </Field>
          <Field label={`원본 주소의 가운데 ${CONFIRM_MIDDLE_LENGTH}자리${formatOk ? ` (고유부 ${mid.start}~${mid.end}번째)` : ''}`} htmlFor="confirmMiddle" required error={fe('confirmMiddle')}
            hint={`고유부는 주소에서 ${bodyPrefix} 다음부터 센 글자입니다. 앞·뒤만 같게 만든 가짜 주소는 가운데가 다르므로, 원본 문서에서 이 위치의 글자를 직접 보고 입력하세요.`}>
            <input id="confirmMiddle" className="mono" value={f.confirmMiddle} onChange={(e) => set({ confirmMiddle: e.target.value })} maxLength={20} autoComplete="off" spellCheck={false} onPaste={blockPaste} onDrop={blockPaste} />
          </Field>
          {lookalike && (
            <Field label="비슷한 주소가 있는데도 등록하는 사유" htmlFor="lookalikeReason" required error={fe('lookalikeReason')}
              hint="받는 곳에 어떤 연락 수단으로 전체 주소를 확인했는지, 기존 주소와 어떻게 다른지 5자 이상 적어 주세요. 확인 담당자와 감사 기록에 남습니다.">
              <TextareaAuto id="lookalikeReason" rows={2} maxRows={6} value={f.lookalikeReason} onChange={(e) => set({ lookalikeReason: e.target.value })} maxLength={300} />
            </Field>
          )}
        </fieldset>

        <fieldset className="form-step" disabled={!formatOk}>
          <legend><span className="step-no">4</span>어떤 경로로 받고, 어떻게 다시 확인했나요?</legend>
          <p className="field-hint">주소를 받은 경로만으로는 확인이 되지 않습니다. 이메일·메신저가 도용되면 주소와 연락처가 함께 바뀔 수 있으니, 미리 알고 있던 다른 경로로 다시 확인하고 기록을 남기세요. 확인 담당자와 감사 기록에 남습니다.</p>
          <Field label="받은 경로" htmlFor="receivedVia" required error={fe('receivedVia')}>
            <select id="receivedVia" value={f.receivedVia} onChange={(e) => set({ receivedVia: e.target.value })}>
              <option value="">받은 경로 선택</option>
              {Object.entries(RECEIVED_VIA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="다시 확인한 경로" htmlFor="verifiedVia" required error={fe('verifiedVia') ?? (sameChannel ? sameChannelText : undefined)}
            hint="받은 경로와 달라야 합니다. 예: 이메일로 받았다면 거래처로 미리 등록해 둔 대표번호로 전화합니다. 받은 메시지에 적힌 연락처는 쓰지 마세요.">
            <select id="verifiedVia" value={f.verifiedVia} onChange={(e) => set({ verifiedVia: e.target.value })}>
              <option value="">다시 확인한 경로 선택</option>
              {Object.entries(VERIFIED_VIA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="확인한 상대·연락처" htmlFor="verifiedWith" required error={fe('verifiedWith')} hint="누구와 어떤 연락처로 확인했는지 적습니다. 예: 거래처 재무팀 담당자, 거래처 등록 대표번호 (100자 이내)">
            <input id="verifiedWith" value={f.verifiedWith} onChange={(e) => set({ verifiedWith: e.target.value })} maxLength={100} autoComplete="off" />
          </Field>
          <div className="checks">
            <label className="check"><input type="checkbox" checked={f.ackOutOfBandConfirmed} onChange={(e) => set({ ackOutOfBandConfirmed: e.target.checked })} aria-invalid={fe('ackOutOfBandConfirmed') ? true : undefined} aria-describedby={fe('ackOutOfBandConfirmed') ? 'ack-error' : undefined} />받는 곳과 전화 등 별도 연락 수단으로 자산·네트워크·주소{network?.memoRequired ? '·태그' : ''}를 확인했습니다.</label>
            <label className="check"><input type="checkbox" checked={f.ackNotVerified} onChange={(e) => set({ ackNotVerified: e.target.checked })} aria-invalid={fe('ackNotVerified') ? true : undefined} aria-describedby={fe('ackNotVerified') ? 'ack-error' : undefined} />형식 점검과 담당자 확인은 주소의 주인이나 안전성을 보증하지 않는다는 점을 이해했습니다.</label>
          </div>
          {(fe('ackNotVerified') || fe('ackOutOfBandConfirmed')) && <p className="field-error" id="ack-error">{fe('ackOutOfBandConfirmed') ?? fe('ackNotVerified')}</p>}
        </fieldset>

        <ApiErrorNotice error={m.error} />
        <div className="form-actions">
          <Link to="/addresses" className="btn">취소</Link>
          <button type="submit" className="btn btn-primary" disabled={m.isPending || !formatOk}>{m.isPending ? '등록 중…' : '확인 요청 보내기'}</button>
        </div>
        {guard.guardDialog}
        <div className="lc-flow muted small">
          <p>
            {policy.data?.addressBook?.cooldownHours === 0
              ? "등록하면 '확인 대기' 상태가 되고, 등록자가 아닌 승인자가 원본과 대조해 확인하면 '사용 가능'이 됩니다."
              : "등록하면 '확인 대기' 상태가 됩니다. 등록자가 아닌 승인자가 원본과 대조해 확인하면 '사용 대기'가 되고, 대기 시간이 지나야 '사용 가능'이 되어 출금 요청에 쓸 수 있습니다. 대기 중에 요청하지 않은 등록이 보이면 바로 정지할 수 있습니다."}
          </p>
          <LifecycleSteps hours={policy.data?.addressBook?.cooldownHours} />
        </div>
      </form>
    </div>
  );
}
