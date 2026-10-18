import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api.ts';
import { ApiErrorNotice, Badge, ErrorState, Field, Loading, Notice, PageHeader, TextareaAuto } from '../components/ui.tsx';
import { DateInput } from '../components/DateInput.tsx';
import { useFocusFirstError } from '../lib/forms.ts';
import { useUnsavedGuard } from '../lib/unsaved.tsx';
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
  const list = useQuery({ queryKey: ['insights', 'manage'], queryFn: () => api('/api/insights?includeHidden=1&limit=50') });
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
  });
  const err = create.error instanceof ApiError ? create.error : null;
  if (list.isPending || providers.isPending) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
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
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">게시 자료 목록</caption>
          <thead><tr><th scope="col">발행일</th><th scope="col">기관</th><th scope="col">제목</th><th scope="col">상태</th><th scope="col"><span className="sr-only">작업</span></th></tr></thead>
          <tbody>
            {list.data.items.map((i: any) => (
              <tr key={i.id}>
                <td className="nowrap">{date(i.publishedAt)}</td>
                <td>{i.providerName}{!i.providerWhitelisted && <div><Badge tone="warning">화이트리스트 아님 · 고객에게 숨김</Badge></div>}</td>
                <td className="cell-wrap">{i.title}</td>
                <td>{i.status === 'published' ? <Badge tone="success">게시</Badge> : <Badge tone="neutral">숨김</Badge>}</td>
                <td><button className="btn btn-sm" onClick={() => toggle.mutate({ id: i.id, status: i.status === 'published' ? 'hidden' : 'published' })} disabled={toggle.isPending}>{i.status === 'published' ? '숨기기' : '다시 게시'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}