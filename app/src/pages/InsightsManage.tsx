import { useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api.ts';
import { ApiErrorNotice, Badge, Empty, ErrorState, Field, Loading, Notice, PageHeader, TextareaAuto } from '../components/ui.tsx';
import { DateInput } from '../components/DateInput.tsx';
import { SearchField } from '../components/SearchField.tsx';
import { useFocusFirstError } from '../lib/forms.ts';
import { useUnsavedGuard } from '../lib/unsaved.tsx';
import { useUrlState } from '../hooks.ts';
import { date } from '../format.ts';

type InsightForm = { providerId: string; title: string; summary: string; language: string; publishedAt: string; url: string };
// 기본 발행일은 이용자 기기 기준 오늘(UTC 날짜를 쓰면 한국 시간 0~9시에 전날로 보인다).
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const initialInsightForm = (): InsightForm => ({ providerId: '', title: '', summary: '', language: 'ko', publishedAt: localToday(), url: '' });
const insightKeys: (keyof InsightForm)[] = ['providerId', 'title', 'summary', 'language', 'publishedAt', 'url'];
/** 본문(제목·요약·원문 주소)은 앞뒤 공백만 다른 경우를 작성으로 보지 않고, 메타데이터는 값이 다르면 작성 중으로 본다. */
function isInsightFormDirty(f: InsightForm, base: InsightForm) {
  return insightKeys.some((k) => (k === 'title' || k === 'summary' || k === 'url' ? f[k].trim() !== base[k].trim() : f[k] !== base[k]));
}

export function InsightsManagePage() {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers', 'manage'], queryFn: () => api('/api/insights/providers') });
  // 목록은 운영 설정의 한 번에 불러올 건수(listBatchSize, 기본값으로 적용)씩 '더 보기'로 이어 받아 모든 자료에 닿을 수 있게 한다.
  const { state: filter, set: setFilter, qs } = useUrlState({ q: '', provider: '' });
  const list = useInfiniteQuery({
    queryKey: ['insights', 'manage', qs],
    queryFn: ({ pageParam, signal }) => api(`/api/insights?${new URLSearchParams({ includeHidden: '1', ...Object.fromEntries(Object.entries(filter).filter(([, v]) => v)), offset: String(pageParam) })}`, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last: any) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
    placeholderData: (p) => p,
  });
  const items: any[] = list.data?.pages.flatMap((p: any) => p.items) ?? [];
  const total: number = list.data?.pages[0]?.total ?? 0;
  const filtered = !!(filter.q || filter.provider);
  // 폼 기준값(최초 값 또는 마지막 게시 성공 뒤 값). 기관·발행일·언어를 포함한 전체 폼을 비교해 작성 중 여부를 판단한다.
  const [baseline, setBaseline] = useState<InsightForm>(initialInsightForm);
  const [f, setF] = useState<InsightForm>(baseline);
  const create = useMutation({
    // 제출 시점 스냅샷을 보낸다. 게시 중에는 입력을 잠가(fieldset disabled) 성공 뒤 초기화가 새 입력을 지우지 않게 한다.
    mutationFn: (snapshot: InsightForm) => api('/api/insights', { method: 'POST', body: snapshot }),
    onSuccess: (_d, snapshot) => {
      qc.invalidateQueries({ queryKey: ['insights'] });
      // 연속 게시를 위해 기관·발행일·언어는 유지하고 본문만 비운다. 이 값이 새 깨끗한 기준이다.
      const next = { ...snapshot, title: '', summary: '', url: '' };
      setBaseline(next);
      setF(next);
    },
  });
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, create.error);
  const dirty = isInsightFormDirty(f, baseline);
  const guard = useUnsavedGuard(dirty);
  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/api/insights/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insights'] }),
    // 다시 게시가 거부되어도(422) 목록을 다시 받아 실제 상태와 맞춘다. 원인은 아래 안내에 남는다.
    onError: () => qc.invalidateQueries({ queryKey: ['insights'] }),
  });
  const err = create.error instanceof ApiError ? create.error : null;
  if (providers.isPending) return <Loading />;
  if (providers.error) return <ErrorState error={providers.error} onRetry={() => providers.refetch()} />;
  return (
    <div className="page">
      <PageHeader title="인사이트 자료 관리" description="게시가 허용된 기관의 자료를 올리고 공개 상태를 관리합니다." />
      <Notice tone="info">기관 화이트리스트와 선별 기준은 KODA 운영팀이 정합니다. 이 화면의 기관과 자료는 모두 모의 데이터입니다.</Notice>
      <form ref={formRef} className="form card" noValidate onSubmit={(e) => { e.preventDefault(); if (!create.isPending) create.mutate(f); }}>
        <fieldset className="form-lock" disabled={create.isPending}>
        <legend className="sr-only">자료 게시 입력</legend>
        <h2>자료 게시</h2>
        <div className="form-grid">
          <Field label="제공 기관" htmlFor="providerId" required error={err?.fieldError('providerId')}>
            <select id="providerId" value={f.providerId} onChange={(e) => setF({ ...f, providerId: e.target.value })}>
              <option value="">기관 선택</option>
              {providers.data.map((p: any) => <option key={p.id} value={p.id}>{p.name}{p.isWhitelisted ? '' : ' (화이트리스트 아님)'}</option>)}
            </select>
          </Field>
          <Field label="발행일" htmlFor="publishedAt" required error={err?.fieldError('publishedAt')}><DateInput id="publishedAt" value={f.publishedAt} onValueChange={(v) => setF((p) => ({ ...p, publishedAt: v }))} /></Field>
          <Field label="언어" htmlFor="language"><select id="language" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}><option value="ko">국문</option><option value="en">영문</option></select></Field>
        </div>
        <Field label="제목" htmlFor="title" required error={err?.fieldError('title')}><input id="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={160} /></Field>
        <Field label="요약" htmlFor="summary" required error={err?.fieldError('summary')}><TextareaAuto id="summary" rows={3} maxRows={8} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} maxLength={400} /></Field>
        <Field label="원문 주소 (https)" htmlFor="url" required error={err?.fieldError('url')}><input id="url" type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} maxLength={500} /></Field>
        </fieldset>
        <ApiErrorNotice error={create.error} />
        {create.isSuccess && !dirty && <Notice tone="success" role="status" title="자료를 게시했습니다">아래 목록에서 게시 상태를 확인할 수 있습니다.</Notice>}
        <div className="form-actions"><button className="btn btn-primary" type="submit" disabled={create.isPending}>{create.isPending ? '게시 중…' : '게시'}</button></div>
      </form>
      {guard.guardDialog}
      <section className="card" aria-labelledby="manage-list-h">
        <div className="card-head">
          <h2 id="manage-list-h">게시 자료 목록</h2>
        </div>
        <form className="toolbar" role="search" noValidate onSubmit={(e) => e.preventDefault()}>
          <SearchField label="자료 제목 검색" placeholder="제목 검색" value={filter.q} onCommit={(v) => setFilter({ q: v })} />
          {/* 이름을 '제공 기관'으로 시작하지 않는다(게시 양식의 '제공 기관' 선택과 구분). */}
          <label><span className="sr-only">기관 필터</span>
            <select value={filter.provider} onChange={(e) => setFilter({ provider: e.target.value })}>
              <option value="">전체 기관</option>
              {providers.data.map((p: any) => <option key={p.id} value={p.id}>{p.name}{p.isWhitelisted ? '' : ' (화이트리스트 아님)'}</option>)}
            </select>
          </label>
        </form>
        {/* 숨기기·다시 게시 실패(예: 화이트리스트에서 빠진 기관, 등록 도메인과 다른 원문 링크)는 원인과 복구 방법을 함께 보인다. */}
        <ApiErrorNotice error={toggle.error} />
        {list.isPending ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : items.length === 0 ? (
          <Empty title={filtered ? '조건에 맞는 자료가 없습니다' : '게시한 자료가 없습니다'} action={filtered ? <button className="btn" onClick={() => setFilter({ q: '', provider: '' })}>필터 초기화</button> : undefined}>
            {filtered ? '다른 기관이나 검색어를 선택해 보세요.' : '위 양식으로 자료를 게시하면 여기에 표시됩니다.'}
          </Empty>
        ) : (
          <>
            <p className="result-count" aria-live="polite">{total}건 중 {items.length}건 표시 · 발행일 최신순 · 숨긴 자료 포함</p>
            <div className="table-wrap">
              {/* 좁은 화면에서는 표의 행을 카드처럼 쌓는다(table-stack). 제목은 한 줄 전체를 쓴다. */}
              <table className="table table-stack">
                <caption className="sr-only">게시 자료 목록</caption>
                <thead><tr><th scope="col">발행일</th><th scope="col">기관</th><th scope="col">제목</th><th scope="col">상태</th><th scope="col"><span className="sr-only">작업</span></th></tr></thead>
                <tbody>
                  {items.map((i: any) => (
                    <tr key={i.id}>
                      <td className="nowrap" data-label="발행일">{date(i.publishedAt)}</td>
                      <td data-label="기관">{i.providerName}{!i.providerWhitelisted && <div><Badge tone="warning">화이트리스트 아님 · 고객에게 숨김</Badge></div>}</td>
                      <td className="cell-wrap" data-label="제목" id={`ins-title-${i.id}`} style={{ gridColumn: '1 / -1' }}>{i.title}</td>
                      <td data-label="상태">{i.status === 'published' ? <Badge tone="success">게시</Badge> : <Badge tone="neutral">숨김</Badge>}</td>
                      <td><button className="btn btn-sm" onClick={() => toggle.mutate({ id: i.id, status: i.status === 'published' ? 'hidden' : 'published' })} disabled={toggle.isPending} aria-describedby={`ins-title-${i.id}`}>{i.status === 'published' ? '숨기기' : '다시 게시'}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.hasNextPage
              ? <div className="load-more"><button type="button" className="btn" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>{list.isFetchingNextPage ? '불러오는 중…' : '더 보기'}</button></div>
              : <p className="muted small center">마지막 자료입니다.</p>}
          </>
        )}
      </section>
    </div>
  );
}