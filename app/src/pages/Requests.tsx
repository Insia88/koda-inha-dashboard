import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useMe } from '../auth.tsx';
import { useUrlState } from '../hooks.ts';
import { Badge, Empty, ErrorState, Loading, PageHeader, Pagination, StatusRail } from '../components/ui.tsx';
import { SearchField } from '../components/SearchField.tsx';
import { amount, dateTime } from '../format.ts';
import { REQUEST_STATUS, type RequestStatus } from '../../shared/terms.ts';

const STATUS_GROUPS: { key: string; label: string; statuses: string }[] = [
  { key: '', label: '전체', statuses: '' },
  { key: 'open', label: '진행 중', statuses: 'DRAFT,REVIEW,PENDING_APPROVAL,PROCESSING' },
  { key: 'pending', label: '승인 대기', statuses: 'PENDING_APPROVAL' },
  { key: 'done', label: '완료', statuses: 'COMPLETED' },
  { key: 'closed', label: '반려·취소·실패', statuses: 'REJECTED,CANCELLED,FAILED' },
];

export function RequestsPage() {
  const me = useMe();
  const can = (p: string) => me.permissions.includes(p);
  const { state, set, qs } = useUrlState({ view: '', status: '', q: '', order: 'desc', page: '1', pageSize: '10' });
  const params = new URLSearchParams(Object.entries(state).filter(([, v]) => v));
  const q = useQuery({ queryKey: ['requests', qs], queryFn: ({ signal }) => api(`/api/requests?${params}`, { signal }), placeholderData: (p) => p, refetchInterval: 10_000 });
  const views = [
    { key: '', label: '조직 전체' },
    ...(can('request.approve') ? [{ key: 'to_approve', label: '내가 승인할 요청' }] : []),
    ...(can('request.create') ? [{ key: 'mine', label: '내가 작성한 요청' }] : []),
  ];
  const filtered = !!(state.status || state.q || state.view);

  return (
    <div className="page">
      <PageHeader
        title="결재 및 요청"
        description="출금 요청은 작성 → 검토 → 승인 대기 → 처리 결과 순서로 진행됩니다. 요청자는 자기 요청을 승인할 수 없습니다."
        actions={can('request.create') && <Link className="btn btn-primary" to="/requests/new"><IconPlus size={16} aria-hidden="true" />출금 요청 작성</Link>}
      />
      <div className="tabs" role="tablist" aria-label="요청 보기">
        {views.map((v) => (
          <button key={v.key} role="tab" aria-selected={state.view === v.key} className={`tab ${state.view === v.key ? 'active' : ''}`} onClick={() => set({ view: v.key })}>{v.label}</button>
        ))}
      </div>
      <form className="toolbar" role="search" noValidate onSubmit={(e) => e.preventDefault()}>
        <SearchField label="요청 검색" placeholder="요청 번호·목적·받는 곳 이름" value={state.q} onCommit={(v) => set({ q: v })} />
        <div className="chips" role="group" aria-label="상태 필터">
          {STATUS_GROUPS.map((g) => (
            <button type="button" key={g.key} className={`chip ${state.status === g.statuses ? 'active' : ''}`} aria-pressed={state.status === g.statuses} onClick={() => set({ status: g.statuses })}>
              {g.label}{g.statuses && q.data?.counts ? ` ${g.statuses.split(',').reduce((s, k) => s + (q.data.counts[k] ?? 0), 0)}` : ''}
            </button>
          ))}
        </div>
        <label><span className="sr-only">정렬</span>
          <select value={state.order} onChange={(e) => set({ order: e.target.value })}>
            <option value="desc">최근 작성순</option>
            <option value="asc">오래된 순</option>
          </select>
        </label>
      </form>
      {q.isPending ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.items.length === 0 ? (
        filtered ? <Empty title={state.view === 'to_approve' ? '지금 승인할 요청이 없습니다' : '조건에 맞는 요청이 없습니다'} action={<button className="btn" onClick={() => set({ status: '', q: '', view: '' })}>필터 초기화</button>}>다른 상태나 보기를 선택해 보세요.</Empty>
          : <Empty title="아직 출금 요청이 없습니다" action={can('request.create') ? <Link className="btn btn-primary" to="/requests/new">첫 요청 작성</Link> : undefined}>요청을 작성하면 승인자에게 전달되기 전까지 여기서 진행 상태를 볼 수 있습니다.</Empty>
      ) : (
        <>
          <ul className="req-list">
            {q.data.items.map((r: any) => {
              const st = REQUEST_STATUS[r.status as RequestStatus];
              return (
                <li key={r.id}>
                  <Link to={`/requests/${r.id}`} state={{ back: `/requests?${qs}` }} className="req-item">
                    <div className="req-main">
                      <span className="ref">{r.refNo}</span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      <span className="req-purpose" title={r.purpose}>{r.purpose}</span>
                    </div>
                    <div className="req-amt num">{amount(r.amount, r.assetCode)}<div className="muted small">{r.networkName}</div></div>
                    <div className="req-meta small">
                      <span>{r.createdBy.name} → {r.address.label}</span>
                      <span className="muted">{dateTime(r.createdAt)}</span>
                    </div>
                    <StatusRail step={st.step} status={r.status} compact />
                  </Link>
                </li>
              );
            })}
          </ul>
          <Pagination page={Number(state.page)} pageSize={Number(state.pageSize)} total={q.data.total} onPage={(p) => set({ page: String(p) }, { resetPage: false })} onPageSize={(s) => set({ pageSize: String(s) })} sizes={[10, 25, 50]} />
        </>
      )}
    </div>
  );
}