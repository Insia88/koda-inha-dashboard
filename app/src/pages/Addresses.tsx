import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useMe } from '../auth.tsx';
import { useCatalog, useUrlState } from '../hooks.ts';
import { AddressStrip, Badge, Empty, ErrorState, Loading, Notice, PageHeader } from '../components/ui.tsx';
import { date } from '../format.ts';
import { ADDRESS_STATUS, type AddressStatus } from '../../shared/terms.ts';

export function AddressesPage() {
  const me = useMe();
  const cat = useCatalog();
  const { state, set, qs } = useUrlState({ q: '', status: '', assetCode: '', networkCode: '', sort: 'status' });
  const q = useQuery({ queryKey: ['addresses', qs], queryFn: () => api(`/api/addresses?${new URLSearchParams(Object.entries(state).filter(([, v]) => v)).toString()}`), placeholderData: (p) => p });
  const filtered = !!(state.q || state.status || state.assetCode || state.networkCode);

  return (
    <div className="page">
      <PageHeader
        title="주소록 관리"
        description="출금할 때 쓰는 받는 곳 주소입니다. 등록자와 다른 담당자가 확인해야 출금 요청에 쓸 수 있습니다."
        actions={me.permissions.includes('address.create') && <Link className="btn btn-primary" to="/addresses/new"><IconPlus size={16} aria-hidden="true" />주소 등록</Link>}
      />
      <Notice tone="info" title="주소록의 '사용 가능'은 주소가 안전하다는 뜻이 아닙니다">
        두 사람이 입력 내용을 확인했다는 기록입니다. 블록체인 전송은 되돌릴 수 없으니 받는 곳과 별도 연락 수단으로 주소를 대조하세요.
      </Notice>

      <form className="toolbar" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="search">
          <IconSearch size={16} aria-hidden="true" />
          <span className="sr-only">주소 검색</span>
          <input type="search" placeholder="이름·받는 곳·주소 일부로 검색" value={state.q} onChange={(e) => set({ q: e.target.value })} maxLength={100} />
        </label>
        <label><span className="sr-only">상태</span>
          <select value={state.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">모든 상태</option>
            {Object.entries(ADDRESS_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label><span className="sr-only">자산</span>
          <select value={state.assetCode} onChange={(e) => set({ assetCode: e.target.value })}>
            <option value="">모든 자산</option>
            {cat.data?.assets.map((a) => <option key={a.code} value={a.code}>{a.code}</option>)}
          </select>
        </label>
        <label><span className="sr-only">네트워크</span>
          <select value={state.networkCode} onChange={(e) => set({ networkCode: e.target.value })}>
            <option value="">모든 네트워크</option>
            {cat.data?.networks.map((n) => <option key={n.code} value={n.code}>{n.name}</option>)}
          </select>
        </label>
        <label><span className="sr-only">정렬</span>
          <select value={state.sort} onChange={(e) => set({ sort: e.target.value })}>
            <option value="status">확인 필요 먼저</option>
            <option value="recent">최근 등록순</option>
            <option value="label">이름순</option>
          </select>
        </label>
        {filtered && <button type="button" className="btn btn-ghost" onClick={() => set({ q: '', status: '', assetCode: '', networkCode: '' })}>필터 초기화</button>}
      </form>

      {q.isPending ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <p className="result-count" aria-live="polite">{filtered ? `조건에 맞는 주소 ${q.data.items.length}개 (전체 ${q.data.totalInOrg}개)` : `전체 ${q.data.totalInOrg}개`}</p>
          {q.data.items.length === 0 ? (
            filtered ? <Empty title="조건에 맞는 주소가 없습니다" action={<button className="btn" onClick={() => set({ q: '', status: '', assetCode: '', networkCode: '' })}>필터 초기화</button>}>검색어나 필터를 바꿔 보세요.</Empty>
              : <Empty title="등록된 주소가 없습니다" action={me.permissions.includes('address.create') ? <Link className="btn btn-primary" to="/addresses/new">첫 주소 등록</Link> : undefined}>출금하려면 받는 곳 주소를 먼저 등록하고 다른 담당자의 확인을 받아야 합니다.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">주소록 목록</caption>
                <thead><tr><th scope="col">이름 · 받는 곳</th><th scope="col">자산 / 네트워크</th><th scope="col">주소</th><th scope="col">상태</th><th scope="col">등록</th></tr></thead>
                <tbody>
                  {q.data.items.map((a: any) => {
                    const st = ADDRESS_STATUS[a.status as AddressStatus];
                    return (
                      <tr key={a.id}>
                        <th scope="row" className="cell-wrap">
                          <Link to={`/addresses/${a.id}`} state={{ back: `/addresses?${qs}` }} className="row-link">{a.label}</Link>
                          <div className="muted small">{a.counterparty}</div>
                        </th>
                        <td><span className="asset-code">{a.assetCode}</span> / {a.networkName}</td>
                        <td><AddressStrip address={a.address} memo={a.memo} compact /></td>
                        <td><Badge tone={st.tone} title={st.description}>{st.label}</Badge>{a.allowedActions.includes('review') && <div className="small action-hint">내 확인 필요</div>}</td>
                        <td className="nowrap small">{date(a.createdAt)}<div className="muted">{a.createdBy.name}</div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">주소록은 조직당 수십 개 규모를 가정해 페이지를 나누지 않고 한 화면에 보여 줍니다. 검색과 필터로 좁혀 보세요.</p>
        </>
      )}
    </div>
  );
}