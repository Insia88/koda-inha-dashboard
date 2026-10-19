import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconX } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useMe } from '../auth.tsx';
import { useUrlState } from '../hooks.ts';
import { Badge, Empty, ErrorState, Loading, PageHeader, Pagination, StatusRail } from '../components/ui.tsx';
import { SearchField } from '../components/SearchField.tsx';
import { amount, dateTime } from '../format.ts';
import { REQUEST_STATUS, type RequestStatus } from '../../shared/terms.ts';

// '진행 중'은 홈의 '진행 중인 요청'과 같은 상태 묶음이다(작성 중 제외). 작성 중·검토 중은 따로 묶는다.
const STATUS_GROUPS: { key: string; label: string; statuses: string }[] = [
  { key: '', label: '전체', statuses: '' },
  { key: 'open', label: '진행 중', statuses: 'REVIEW,PENDING_APPROVAL,PROCESSING' },
  { key: 'drafting', label: '작성·검토 중', statuses: 'DRAFT,REVIEW' },
  { key: 'pending', label: '승인 대기', statuses: 'PENDING_APPROVAL' },
  { key: 'done', label: '완료', statuses: 'COMPLETED' },
  { key: 'closed', label: '반려·취소·실패', statuses: 'REJECTED,CANCELLED,FAILED' },
];

const statusList = (s: string) => s.split(',').map((x) => x.trim()).filter((x): x is RequestStatus => x in REQUEST_STATUS);
/** 순서와 상관없이 같은 상태 묶음인지 */
const sameSet = (a: string, b: string) => {
  const x = new Set(statusList(a));
  const y = new Set(statusList(b));
  return x.size === y.size && [...x].every((k) => y.has(k));
};

const OPEN_STATUSES = ['DRAFT', 'REVIEW', 'PENDING_APPROVAL'];

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
    { key: 'blocked', label: '승인 불가(주소 중지)' },
  ];
  const filtered = !!(state.status || state.q || state.view);
  const countOf = (statuses: string) => (q.data?.counts ? statusList(statuses).reduce((s, k) => s + (q.data.counts[k] ?? 0), 0) : null);
  const matchedGroup = STATUS_GROUPS.find((g) => (g.statuses === '' ? state.status === '' : sameSet(g.statuses, state.status)));
  // 홈의 할 일 링크처럼 칩에 없는 상태 묶음(예: 반려·처리 실패)으로 들어오면, 눌린 상태의 해제 가능한 칩으로 보여 준다.
  const customStatuses = !matchedGroup && state.status ? statusList(state.status) : [];
  const page = Number(state.page);
  const outOfRange = !!q.data && q.data.items.length === 0 && q.data.total > 0 && page > 1;

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
      {state.view === 'blocked' && <p className="result-count">받는 주소가 사용 중지되어 승인할 수 없는 승인 대기 요청입니다. 요청자가 취소하거나 승인자가 사유와 함께 반려하면 예약 수량이 풀립니다.</p>}
      <form className="toolbar" role="search" noValidate onSubmit={(e) => e.preventDefault()}>
        <SearchField label="요청 검색" placeholder="요청 번호·목적·받는 곳 이름" value={state.q} onCommit={(v) => set({ q: v })} />
        <div className="chips" role="group" aria-label="상태 필터">
          {STATUS_GROUPS.map((g) => {
            const on = matchedGroup?.key === g.key;
            const c = g.statuses ? countOf(g.statuses) : null;
            return (
              <button type="button" key={g.key} className={`chip ${on ? 'active' : ''}`} aria-pressed={on} onClick={() => set({ status: g.statuses })}>
                {g.label}{c !== null ? ` ${c}` : ''}
              </button>
            );
          })}
          {customStatuses.length > 0 && (
            <button type="button" className="chip active" aria-pressed="true" onClick={() => set({ status: '' })}>
              {customStatuses.map((s) => REQUEST_STATUS[s].label).join('·')}{countOf(state.status) !== null ? ` ${countOf(state.status)}` : ''}
              <span className="sr-only"> (누르면 이 상태 필터를 해제합니다)</span>
              <IconX size={14} aria-hidden="true" style={{ marginLeft: 6, verticalAlign: -2 }} />
            </button>
          )}
        </div>
        <label><span className="sr-only">정렬</span>
          <select value={state.order} onChange={(e) => set({ order: e.target.value })}>
            <option value="desc">최근 작성순</option>
            <option value="asc">오래된 순</option>
          </select>
        </label>
      </form>
      {q.isPending ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : outOfRange ? (
        <Empty title="이 페이지에는 요청이 없습니다" action={<button className="btn" onClick={() => set({ page: '1' }, { resetPage: false })}>첫 페이지로</button>}>
          조건에 맞는 요청은 {q.data.total.toLocaleString('ko-KR')}건이며 {Math.max(1, Math.ceil(q.data.total / Number(state.pageSize)))}페이지까지 있습니다.
        </Empty>
      ) : q.data.items.length === 0 ? (
        filtered ? <Empty title={state.view === 'to_approve' ? '지금 승인할 요청이 없습니다' : state.view === 'blocked' ? '승인할 수 없는 요청이 없습니다' : '조건에 맞는 요청이 없습니다'} action={<button className="btn" onClick={() => set({ status: '', q: '', view: '' })}>필터 초기화</button>}>다른 상태나 보기를 선택해 보세요.</Empty>
          : <Empty title="아직 출금 요청이 없습니다" action={can('request.create') ? <Link className="btn btn-primary" to="/requests/new">첫 요청 작성</Link> : undefined}>요청을 작성하면 승인자에게 전달되기 전까지 여기서 진행 상태를 볼 수 있습니다.</Empty>
      ) : (
        <>
          <ul className="req-list">
            {q.data.items.map((r: any) => {
              const st = REQUEST_STATUS[r.status as RequestStatus];
              // 받는 주소가 사용 가능 상태가 아니면 진행 중인 요청에 표시한다(끝난 요청에는 영향이 없으므로 표시하지 않는다).
              const addrOff = r.address.status !== 'ACTIVE' && OPEN_STATUSES.includes(r.status);
              return (
                <li key={r.id}>
                  <Link to={`/requests/${r.id}`} state={{ back: `/requests?${qs}` }} className="req-item">
                    <div className="req-main">
                      <span className="ref">{r.refNo}</span>
                      <Badge tone={st.tone}>{st.label}</Badge>
                      {addrOff && <Badge tone="danger">{r.blockedReason === 'ADDRESS_NOT_ACTIVE' ? '승인 불가 · 주소 사용 중지' : '받는 주소 사용 중지'}</Badge>}
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
          <Pagination page={page} pageSize={Number(state.pageSize)} total={q.data.total} onPage={(p) => set({ page: String(p) }, { resetPage: false })} onPageSize={(s) => set({ pageSize: String(s) })} sizes={[10, 25, 50]} />
        </>
      )}
    </div>
  );
}
