import { useQuery } from '@tanstack/react-query';
import { IconDownload } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useMe } from '../auth.tsx';
import { useUrlState } from '../hooks.ts';
import { Badge, Empty, ErrorState, Loading, PageHeader, Pagination } from '../components/ui.tsx';
import { DateInput } from '../components/DateInput.tsx';
import { SearchField } from '../components/SearchField.tsx';
import { dateTime } from '../format.ts';

const ACTION_LABEL: Record<string, string> = {
  'auth.login': '로그인', 'auth.logout': '로그아웃',
  'address.created': '주소 등록 요청', 'address.approved': '주소 확인', 'address.rejected': '주소 거절', 'address.disabled': '주소 사용 중지',
  'request.created': '요청 작성', 'request.updated': '요청 수정', 'request.reviewing': '검토 이동', 'request.back_to_draft': '작성으로 되돌림',
  'request.submitted': '승인 요청', 'request.approved': '승인', 'request.rejected': '반려', 'request.cancelled': '취소',
  'request.processing': '처리 시작', 'request.completed': '처리 완료', 'request.failed': '처리 실패',
  'member.roles_changed': '역할 변경', 'audit.exported': '감사 기록 내보내기', 'insight.published': '리서치 게시', 'insight.hidden': '리서치 숨김',
};

export function AuditPage() {
  const me = useMe();
  const { state, set, qs } = useUrlState({ action: '', actor: '', q: '', from: '', to: '', page: '1', pageSize: '50' });
  const params = new URLSearchParams(Object.entries(state).filter(([, v]) => v));
  const q = useQuery({ queryKey: ['audit', qs], queryFn: ({ signal }) => api(`/api/audit?${params}`, { signal }), placeholderData: (p) => p });
  const verify = useQuery({ queryKey: ['audit-verify'], queryFn: () => api('/api/audit/verify') });
  const exportParams = new URLSearchParams(Object.entries({ action: state.action, actor: state.actor, q: state.q, from: state.from, to: state.to }).filter(([, v]) => v));
  const filtered = !!(state.action || state.actor || state.q || state.from || state.to);
  const reset = () => set({ action: '', actor: '', q: '', from: '', to: '' });

  return (
    <div className="page">
      <PageHeader
        title="감사 기록"
        description="요청·승인·주소·역할 변경과 로그인 기록입니다. 기록은 추가만 가능하며 수정·삭제할 수 없습니다."
        actions={me.permissions.includes('audit.export') && <a className="btn" href={`/api/audit/export.csv?${exportParams}`} download><IconDownload size={16} aria-hidden="true" />CSV 내보내기{filtered ? ' (필터 적용)' : ''}</a>}
      />
      <div className="audit-integrity" role="status">
        {verify.data ? (verify.data.ok ? <Badge tone="success">무결성 확인됨</Badge> : <Badge tone="danger">무결성 오류</Badge>) : <Badge tone="neutral">무결성 확인 중</Badge>}
        <span className="small muted">{verify.data ? (verify.data.ok ? `기록 ${verify.data.count}건의 해시 연결이 끊김 없이 이어집니다.` : `${verify.data.brokenAtSeq}번 기록에서 해시가 맞지 않습니다. 보안 담당자에게 알리세요.`) : ''}</span>
      </div>
      <form className="toolbar" role="search" noValidate onSubmit={(e) => e.preventDefault()}>
        <SearchField label="내용 검색" placeholder="내용·요청 번호 검색" value={state.q} onCommit={(v) => set({ q: v })} />
        <SearchField label="수행자 이름" placeholder="수행자 이름" value={state.actor} onCommit={(v) => set({ actor: v })} maxLength={50} icon={false} className="search-narrow" clearLabel="수행자 이름 지우기" />
        <label><span className="sr-only">행동</span><select value={state.action} onChange={(e) => set({ action: e.target.value })}><option value="">모든 행동</option>{(q.data?.actions ?? []).map((a: string) => <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>)}</select></label>
        <label className="date-field"><span>시작일</span><DateInput commit="debounce" value={state.from} onValueChange={(v) => set({ from: v })} max={state.to || undefined} /></label>
        <label className="date-field"><span>종료일</span><DateInput commit="debounce" value={state.to} onValueChange={(v) => set({ to: v })} min={state.from || undefined} /></label>
        {filtered && <button type="button" className="btn btn-ghost" onClick={reset}>필터 초기화</button>}
      </form>
      {q.isPending ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.items.length === 0 ? (
        <Empty title="조건에 맞는 기록이 없습니다" action={filtered ? <button className="btn" onClick={reset}>필터 초기화</button> : undefined} />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">감사 기록</caption>
              <thead><tr><th scope="col" className="num">순번</th><th scope="col">일시 (KST)</th><th scope="col">수행자</th><th scope="col">행동</th><th scope="col">내용</th></tr></thead>
              <tbody>
                {q.data.items.map((e: any) => (
                  <tr key={e.id}>
                    <td className="num muted">{e.seq}</td>
                    <td className="nowrap">{dateTime(e.createdAt)}</td>
                    <td>{e.actorName}</td>
                    <td className="nowrap">{ACTION_LABEL[e.action] ?? e.action}</td>
                    <td className="cell-wrap">{e.summary}{e.detail?.reason && <div className="muted small">사유: {e.detail.reason}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={Number(state.page)} pageSize={Number(state.pageSize)} total={q.data.total} onPage={(p) => set({ page: String(p) }, { resetPage: false })} onPageSize={(s) => set({ pageSize: String(s) })} sizes={[25, 50, 100]} />
        </>
      )}
    </div>
  );
}