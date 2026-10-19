import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { IconExternalLink } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useUrlState } from '../hooks.ts';
import { useMe } from '../auth.tsx';
import { Badge, Empty, ErrorState, Loading, PageHeader } from '../components/ui.tsx';
import { SearchField } from '../components/SearchField.tsx';
import { date } from '../format.ts';

/** 원문 링크의 도메인(표시용). 읽을 수 없으면 표시하지 않는다. */
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

export function InsightsPage() {
  const me = useMe();
  const experiment = me.insight.experiments.holdingRelatedFilter;
  const { state, set, qs } = useUrlState({ provider: '', q: '', related: '' });
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api('/api/insights/providers') });
  const q = useInfiniteQuery({
    queryKey: ['insights', qs],
    queryFn: ({ pageParam, signal }) => api(`/api/insights?${new URLSearchParams({ ...Object.fromEntries(Object.entries(state).filter(([, v]) => v)), offset: String(pageParam) })}`, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last: any) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
  });
  const items = q.data?.pages.flatMap((p: any) => p.items) ?? [];
  const first = q.data?.pages[0];
  const filtered = !!(state.provider || state.q || state.related);

  return (
    <div className="page">
      <PageHeader title="마켓 인사이트" description="KODA가 화이트리스트 기관의 리서치를 골라 제공합니다. 제목을 누르면 기관의 원문이 새 창에서 열립니다." />
      {first && <div className="disclosure" role="note"><b>이용 고지</b> {first.disclosure}</div>}
      <form className="toolbar" role="search" noValidate onSubmit={(e) => e.preventDefault()}>
        <div className="chips" role="group" aria-label="제공 기관">
          <button type="button" className={`chip ${!state.provider ? 'active' : ''}`} aria-pressed={!state.provider} onClick={() => set({ provider: '' })}>전체 기관</button>
          {providers.data?.map((p: any) => <button type="button" key={p.id} className={`chip ${state.provider === p.id ? 'active' : ''}`} aria-pressed={state.provider === p.id} onClick={() => set({ provider: p.id })}>{p.name}</button>)}
        </div>
        {experiment && <button type="button" className={`chip ${state.related ? 'active' : ''}`} aria-pressed={!!state.related} onClick={() => set({ related: state.related ? '' : '1' })} title="보유 자산 코드와 자료의 자산 태그만 비교합니다">보유 자산 관련 (실험)</button>}
        <SearchField label="제목 검색" placeholder="제목 검색" value={state.q} onCommit={(v) => set({ q: v })} />
      </form>
      {q.isPending ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : items.length === 0 ? (
        <Empty title={filtered ? '조건에 맞는 자료가 없습니다' : '게시된 자료가 없습니다'} action={filtered ? <button className="btn" onClick={() => set({ provider: '', q: '', related: '' })}>필터 초기화</button> : undefined}>{filtered ? '다른 기관이나 검색어를 선택해 보세요.' : 'KODA가 자료를 게시하면 여기에 표시됩니다.'}</Empty>
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
                <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {i.assetTags.length > 0 && (
                    <div className="insight-meta">
                      <span className="sr-only">관련 자산</span>
                      {i.assetTags.map((t: string) => <span key={t} className="badge badge-neutral" style={{ fontWeight: 600 }}>{t}</span>)}
                    </div>
                  )}
                  <div className="insight-meta">
                    {hostOf(i.url) && <span>원문: {hostOf(i.url)} (새 창)</span>}
                    {i.curatedAt && <span>KODA 선별 {date(i.curatedAt)}</span>}
                  </div>
                </div>
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