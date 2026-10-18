import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api.ts';
import { ApiErrorNotice, Badge, ErrorState, Field, Loading, Notice, PageHeader, TextareaAuto } from '../components/ui.tsx';
import { DateInput } from '../components/DateInput.tsx';
import { useFocusFirstError } from '../lib/forms.ts';
import { useUnsavedGuard } from '../lib/unsaved.tsx';
import { date } from '../format.ts';

export function InsightsManagePage() {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ['providers', 'manage'], queryFn: () => api('/api/insights/providers') });
  const list = useQuery({ queryKey: ['insights', 'manage'], queryFn: () => api('/api/insights?includeHidden=1&limit=50') });
  const [f, setF] = useState({ providerId: '', title: '', summary: '', language: 'ko', publishedAt: new Date().toISOString().slice(0, 10), url: '' });
  const create = useMutation({
    mutationFn: () => api('/api/insights', { method: 'POST', body: f }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['insights'] }); setF({ ...f, title: '', summary: '', url: '' }); },
  });
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, create.error);
  // 직접 입력한 본문(제목·요약·원문 주소)이 있을 때만 이탈을 확인한다.
  const guard = useUnsavedGuard(!!(f.title.trim() || f.summary.trim() || f.url.trim()));
  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/api/insights/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['insights'] }),
  });
  const err = create.error instanceof ApiError ? create.error : null;
  if (list.isPending || providers.isPending) return <Loading />;
  if (list.error) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  return (
    <div className="page">
      <PageHeader title="인사이트 자료 관리" description="화이트리스트 기관의 자료만 게시할 수 있습니다(서버에서 검사). 운영 기준은 config/insight-policy.json 설정으로 분리되어 있습니다." />
      <Notice tone="info">기관 화이트리스트와 선별 기준은 KODA 운영팀이 정합니다. 이 화면의 기관과 자료는 모두 모의 데이터입니다.</Notice>
      <form ref={formRef} className="form card" noValidate onSubmit={(e) => { e.preventDefault(); if (!create.isPending) create.mutate(); }}>
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
        <ApiErrorNotice error={create.error} />
        {create.isSuccess && <Notice tone="success" role="status" title="자료를 게시했습니다">아래 목록에서 게시 상태를 확인할 수 있습니다.</Notice>}
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