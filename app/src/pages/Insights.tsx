import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { IconExternalLink, IconSearch } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useUrlState } from '../hooks.ts';
import { Badge, Empty, ErrorState, Loading, PageHeader } from '../components/ui.tsx';
import { date } from '../format.ts';

export function InsightsPage() {
  const { state, set, qs } = useUrlState({ provider: '', q: '' });
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api('/api/insights/providers') });
  const q = useInfiniteQuery({
    queryKey: ['insights', qs],
    queryFn: ({ pageParam }) => api(`/api/insights?${new URLSearchParams({ ...Object.fromEntries(Object.entries(state).filter(([, v]) => v)), offset: String(pageParam) })}`),
    initialPageParam: 0,
    getNextPageParam: (last: any) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
  });
  const items = q.data?.pages.flatMap((p: any) => p.items) ?? [];
  const first = q.data?.pages[0];
  const filtered = !!(state.provider || state.q);

  return (
    <div className="page">
      <PageHeader title="마켓 인사이트" description="KODA가 화이트리스트 기관의 리서치를 골라 제공합니다. 제목을 누르면 기관의 원문이 새 창에서 열립니다." />
      {first && <div className="disclosure" role="note"><b>이용 고지</b> {first.disclosure}</div>}
      <form className="toolbar" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="chips" role="group" aria-label="제공 기관">
          <button type="button" className={`chip ${!state.provider ? 'active' : ''}`} aria-pressed={!state.provider} onClick={() => set({ provider: '' })}>전체 기관</button>
          {providers.data?.map((p: any) => <button type="button" key={p.id} className={`chip ${state.provider === p.id ? 'active' : ''}`} aria-pressed={state.provider === p.id} onClick={() => set({ provider: p.id })}>{p.name}</button>)}
        </div>
        <label className="search"><IconSearch size={16} aria-hidden="true" /><span className="sr-only">제목 검색</span><input type="search" placeholder="제목 검색" value={state.q} onChange={(e) => set({ q: e.target.value })} maxLength={100} /></label>
      </form>
      {q.isPending ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : items.length === 0 ? (
        <Empty title={filtered ? '조건에 맞는 자료가 없습니다' : '게시된 자료가 없습니다'} action={filtered ? <button className="btn" onClick={() => set({ provider: '', q: '' })}>필터 초기화</button> : undefined}>{filtered ? '다른 기관이나 검색어를 선택해 보세요.' : 'KODA가 자료를 게시하면 여기에 표시됩니다.'}</Empty>
      ) : (
        <>
          <p className="result-count" aria-live="polite">{first.total}건 중 {items.length}건 표시 · 발행일 최신순</p>
          <ul className="insight-list">
            {items.map((i: any) => (
              <li key={i.id} className="insight">
                <div className="insight-meta">
                  <span className="insight-provider">{i.providerName}</span>
                  <time dateTime={i.publishedAt}>발행 {date(i.publishedAt)}</time>
                  <span className="muted small">{i.language === 'en' ? '영문' : '국문'}</span>
                  {i.isNew && <Badge tone="info">새 자료</Badge>}
                </div>
                <h2 className="insight-title"><a href={i.url} target="_blank" rel="noopener noreferrer">{i.title}<IconExternalLink size={14} aria-label="(새 창, 외부 원문)" /></a></h2>
                <p className="insight-summary">{i.summary}</p>
              </li>
            ))}
          </ul>
          {q.hasNextPage && <div className="load-more"><button className="btn" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>{q.isFetchingNextPage ? '불러오는 중…' : '자료 더 보기'}</button></div>}
          {!q.hasNextPage && items.length > 0 && <p className="muted small center">마지막 자료입니다.</p>}
        </>
      )}
    </div>
  );
}