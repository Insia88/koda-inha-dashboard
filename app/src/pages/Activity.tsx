import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { useCatalog, useUrlState } from '../hooks.ts';
import { Badge, Empty, ErrorState, Loading, PageHeader, Pagination } from '../components/ui.tsx';
import { DateInput } from '../components/DateInput.tsx';
import { SearchField } from '../components/SearchField.tsx';
import { amount, dateTime } from '../format.ts';
import { ADDRESS_STATUS, TX_STATUS, TX_TYPE, type AddressStatus } from '../../shared/terms.ts';
import { chunkAddress } from '../../shared/address-rules.ts';
import '../components/address-lifecycle.css';

interface PoisonFlag { reason: 'dust'; lookalike: { id: string; label: string; status: string; prefix: number; suffix: number } | null }

/**
 * 주소 오염 의심 입금을 보낸 주소. 4자 묶음으로 전체를 같은 굵기로 보여 주되 복사 버튼은 두지 않는다
 * (거래 내역에서 주소를 복사해 쓰게 만드는 것이 이 공격의 목적이다).
 */
function PoisonSender({ address }: { address: string }) {
  const chunks = chunkAddress(address.trim());
  const [prefix, ...body] = chunks[0]?.startsWith('MOCK') ? chunks : ['', ...chunks];
  return (
    <span className="addr lc-poison-addr">
      <span className="addr-code" aria-label={`보낸 주소 ${address}`}>
        {prefix && <span className="addr-prefix">{prefix}</span>}
        {body.map((c, i) => <span key={i} className="addr-chunk">{c}</span>)}
      </span>
    </span>
  );
}

function PoisonNote({ flag, address }: { flag: PoisonFlag; address: string | null }) {
  const look = flag.lookalike;
  return (
    <div className="lc-poison">
      <Badge tone="danger">주소 오염 의심</Badge>
      {address && <PoisonSender address={address} />}
      <p className="lc-poison-text">
        0원·소액 입금으로 거래 내역에 비슷한 주소를 남기는 공격에서 자주 보이는 기록입니다.
        {look && ` 주소록의 '${look.label}'(${ADDRESS_STATUS[look.status as AddressStatus]?.label ?? look.status})와 앞 ${look.prefix}자·뒤 ${look.suffix}자가 같습니다.`}
        {' '}이 주소를 복사해 쓰지 말고, 출금은 주소록에서 확인을 마친 주소만 고르세요.
      </p>
    </div>
  );
}

export function ActivityPage() {
  const cat = useCatalog();
  const { state, set, qs } = useUrlState({ type: '', assetCode: '', status: '', q: '', from: '', to: '', order: 'desc', page: '1', pageSize: '25' });
  const params = new URLSearchParams(Object.entries(state).filter(([, v]) => v));
  const q = useQuery({ queryKey: ['activity', qs], queryFn: ({ signal }) => api(`/api/activity?${params}`, { signal }), placeholderData: (p) => p });
  const filtered = !!(state.type || state.assetCode || state.status || state.q || state.from || state.to);
  const reset = () => set({ type: '', assetCode: '', status: '', q: '', from: '', to: '' });

  return (
    <div className="page">
      <PageHeader title="자산 활동 내역" description="입금·출금·스테이킹 보상 기록입니다. 많은 기록을 다루므로 기간·종류로 좁히고 페이지 단위로 넘겨 봅니다." />
      <form className="toolbar" role="search" noValidate onSubmit={(e) => e.preventDefault()}>
        <SearchField label="상대방·참조 검색" placeholder="상대방·거래 참조로 검색" value={state.q} onCommit={(v) => set({ q: v })} />
        <label><span className="sr-only">종류</span><select value={state.type} onChange={(e) => set({ type: e.target.value })}><option value="">모든 종류</option>{Object.entries(TX_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label><span className="sr-only">자산</span><select value={state.assetCode} onChange={(e) => set({ assetCode: e.target.value })}><option value="">모든 자산</option>{cat.data?.assets.map((a) => <option key={a.code} value={a.code}>{a.code}</option>)}</select></label>
        <label><span className="sr-only">상태</span><select value={state.status} onChange={(e) => set({ status: e.target.value })}><option value="">모든 상태</option>{Object.entries(TX_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
        <label className="date-field"><span>시작일</span><DateInput commit="debounce" value={state.from} onValueChange={(v) => set({ from: v })} max={state.to || undefined} /></label>
        <label className="date-field"><span>종료일</span><DateInput commit="debounce" value={state.to} onValueChange={(v) => set({ to: v })} min={state.from || undefined} /></label>
        <label><span className="sr-only">정렬</span><select value={state.order} onChange={(e) => set({ order: e.target.value })}><option value="desc">최신순</option><option value="asc">오래된 순</option></select></label>
        {filtered && <button type="button" className="btn btn-ghost" onClick={reset}>필터 초기화</button>}
      </form>
      {q.isPending ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.items.length === 0 ? (
        filtered ? <Empty title="조건에 맞는 기록이 없습니다" action={<button className="btn" onClick={reset}>필터 초기화</button>}>기간을 넓히거나 다른 종류를 선택해 보세요.</Empty>
          : Number(state.page) > 1 ? <Empty title="이 페이지에는 기록이 없습니다" action={<button className="btn" onClick={() => set({ page: '1' }, { resetPage: false })}>첫 페이지로</button>} />
          : <Empty title="아직 자산 활동이 없습니다">입금이나 출금이 처리되면 여기에 기록됩니다.</Empty>
      ) : (
        <>
          <div className="table-wrap">
            {/* 좁은 화면(≤560px)에서는 행마다 레이블이 붙은 카드로 쌓인다(table-stack, data-label). */}
            <table className="table table-stack act-table">
              <caption className="sr-only">자산 활동 내역</caption>
              <thead><tr><th scope="col">일시 (KST)</th><th scope="col">종류</th><th scope="col">상대방</th><th scope="col" className="num">수량</th><th scope="col">네트워크 · 지갑</th><th scope="col">상태</th><th scope="col">참조</th></tr></thead>
              <tbody>
                {q.data.items.map((t: any) => (
                  <tr key={t.id}>
                    <td className="nowrap act-when" data-label="일시 (KST)">{dateTime(t.occurredAt)}</td>
                    <td className="act-type"><span className={`dir dir-${t.type}`}>{TX_TYPE[t.type]}</span></td>
                    <td className="cell-wrap act-cp" data-label="상대방">
                      {t.counterparty}
                      {t.poison && <PoisonNote flag={t.poison} address={t.counterpartyAddress} />}
                    </td>
                    <td className="num nowrap act-amt">{t.type === 'withdrawal' ? '−' : '+'}{amount(t.amount, t.assetCode)}</td>
                    <td className="small act-net" data-label="네트워크 · 지갑">{t.networkName}<div className="muted">{t.walletName}</div></td>
                    <td className="act-status" data-label="상태"><Badge tone={TX_STATUS[t.status]!.tone}>{TX_STATUS[t.status]!.label}</Badge></td>
                    <td className="small mono act-ref" data-label="참조">{t.requestId ? <Link to={`/requests/${t.requestId}`} state={{ back: `/activity?${qs}` }}>{t.requestRef}</Link> : t.txRef}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={Number(state.page)} pageSize={Number(state.pageSize)} total={q.data.total} onPage={(p) => set({ page: String(p) }, { resetPage: false })} onPageSize={(s) => set({ pageSize: String(s) })} />
        </>
      )}
    </div>
  );
}