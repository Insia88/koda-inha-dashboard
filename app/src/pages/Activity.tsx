import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { useCatalog, useUrlState } from '../hooks.ts';
import { Badge, Empty, ErrorState, Loading, PageHeader, Pagination } from '../components/ui.tsx';
import { DateInput } from '../components/DateInput.tsx';
import { SearchField } from '../components/SearchField.tsx';
import { amount, dateTime } from '../format.ts';
import { TX_STATUS, TX_TYPE } from '../../shared/terms.ts';

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
                    <td className="cell-wrap act-cp" data-label="상대방">{t.counterparty}</td>
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