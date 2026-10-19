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
  'address.created': '주소 등록 요청', 'address.findings_updated': '주소 점검 결과 갱신', 'address.activated': '주소 사용 시작', 'address.cooldown_stopped': '사용 대기 중 정지', 'address.approved': '주소 확인', 'address.rejected': '주소 거절', 'address.disabled': '주소 사용 중지',
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
        <span className="small muted">{verify.data ? (verify.data.ok ? `기록 ${verify.data.count}건의 해시 연결이 끊김 없이 이어집니다.` : `${verify.data.brokenAtNo ?? verify.data.brokenAtSeq}번 기록에서 해시가 맞지 않습니다. 보안 담당자에게 알리세요.`) : ''}</span>
      </div>
      {/* 확인 범위: 해시가 키 없는 SHA-256이라, 이 확인은 해시 연결이 끊긴 곳만 찾는다. 가장 최근 기록을 지우거나,
          기록을 고친 뒤 그 뒤의 prev_hash·hash를 모두 다시 계산하면 연결은 그대로라 드러나지 않는다.
          둘 다 앱 밖에 보관한 건수·마지막 해시와 대조해야 알 수 있다. */}
      {verify.data?.ok && (
        <div className="audit-scope small">
          <p>이 확인은 각 기록이 바로 앞 기록의 해시와 맞게 이어지는지를 봅니다. 가장 최근 기록을 지운 경우나, 기록을 고친 뒤 그 뒤 기록의 해시를 모두 다시 계산한 경우는 이 확인만으로 찾을 수 없습니다. 기록 건수와 마지막 기록 해시를 앱 밖에 따로 보관해 두었다가 다음 확인 때 대조해야 합니다.</p>
          {verify.data.headHash && (
            <p className="audit-anchor">보관용 값: 기록 {verify.data.count}건 · 마지막 기록 해시 <span className="mono">{verify.data.headHash}</span></p>
          )}
        </div>
      )}
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
            {/* 번호는 이 조직 안의 기록 순서(orgSeq)다. 좁은 화면(≤560px)에서는 행마다 카드로 쌓인다. */}
            <table className="table table-stack aud-table">
              <caption className="sr-only">감사 기록</caption>
              <thead><tr><th scope="col" className="num">번호</th><th scope="col">일시 (KST)</th><th scope="col">수행자</th><th scope="col">행동</th><th scope="col">내용</th></tr></thead>
              <tbody>
                {q.data.items.map((e: any) => (
                  <tr key={e.id}>
                    <td className="num muted aud-no" data-label="번호">{e.orgSeq ?? e.seq}</td>
                    <td className="nowrap aud-when" data-label="일시 (KST)">{dateTime(e.createdAt)}</td>
                    <td className="aud-actor" data-label="수행자">{e.actorName}</td>
                    <td className="nowrap aud-action">{ACTION_LABEL[e.action] ?? e.action}</td>
                    <td className="cell-wrap aud-summary">{e.summary}{e.detail?.reason && <div className="muted small">사유: {e.detail.reason}</div>}</td>
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