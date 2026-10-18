import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { useMe } from '../auth.tsx';
import { ApiErrorNotice, ErrorState, Loading, Notice, PageHeader } from '../components/ui.tsx';
import { krwShort } from '../format.ts';
import { ROLE_LABEL, type Role } from '../../shared/terms.ts';

const ROLES: Role[] = ['requester', 'approver', 'auditor', 'admin'];

export function OrgPage() {
  const me = useMe();
  const qc = useQueryClient();
  const canManage = me.permissions.includes('org.manage');
  const members = useQuery({ queryKey: ['members'], queryFn: () => api('/api/org/members') });
  const policy = useQuery({ queryKey: ['policy'], queryFn: () => api('/api/org/policy') });
  const [editing, setEditing] = useState<{ id: string; roles: Role[]; rolesVersion: number } | null>(null);
  const save = useMutation({
    mutationFn: () => api(`/api/org/members/${editing!.id}/roles`, { method: 'PUT', body: { roles: editing!.roles, rolesVersion: editing!.rolesVersion } }),
    onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ['members'] }); qc.invalidateQueries({ queryKey: ['me'] }); },
  });
  if (members.isPending) return <Loading />;
  if (members.error) return <ErrorState error={members.error} onRetry={() => members.refetch()} />;
  return (
    <div className="page">
      <PageHeader title="조직 관리" description={`${me.org.name}의 구성원과 역할, 승인 정책입니다.`} />
      <section className="card">
        <h2>역할 설명</h2>
        <ul className="role-list">{ROLES.map((r) => <li key={r}><b>{ROLE_LABEL[r].label}</b> — {ROLE_LABEL[r].description}</li>)}</ul>
        <p className="muted small">한 사람이 요청자와 승인자 역할을 함께 가질 수 있지만, 자기 요청과 자기가 등록한 주소는 승인할 수 없습니다(서버에서 검사).</p>
      </section>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">구성원 목록</caption>
          <thead><tr><th scope="col">이름</th><th scope="col">직함</th><th scope="col">이메일 (모의)</th><th scope="col">역할</th>{canManage && <th scope="col"><span className="sr-only">작업</span></th>}</tr></thead>
          <tbody>
            {members.data.map((m: any) => (
              <tr key={m.id}>
                <th scope="row">{m.name}{m.id === me.user.id && <span className="muted small"> (나)</span>}</th>
                <td>{m.title}</td>
                <td className="small">{m.email}</td>
                <td>
                  {editing?.id === m.id ? (
                    <fieldset className="role-edit">
                      <legend className="sr-only">{m.name} 역할</legend>
                      {ROLES.map((r) => (
                        <label key={r} className="check-inline"><input type="checkbox" checked={editing!.roles.includes(r)} onChange={(e) => { const cur = editing!; setEditing({ ...cur, roles: e.target.checked ? [...cur.roles, r] : cur.roles.filter((x) => x !== r) }); }} />{ROLE_LABEL[r].label}</label>
                      ))}
                    </fieldset>
                  ) : m.roles.map((r: Role) => ROLE_LABEL[r].label).join(', ') || <span className="muted">역할 없음</span>}
                </td>
                {canManage && (
                  <td className="nowrap">
                    {editing?.id === m.id ? (
                      <><button className="btn btn-primary btn-sm" onClick={() => save.mutate()} disabled={save.isPending}>저장</button> <button className="btn btn-sm" onClick={() => { setEditing(null); save.reset(); }}>취소</button></>
                    ) : <button className="btn btn-sm" onClick={() => { save.reset(); setEditing({ id: m.id, roles: m.roles, rolesVersion: m.rolesVersion }); }}>역할 변경</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ApiErrorNotice error={save.error} />
      {canManage && <p className="muted small">역할 변경은 즉시 적용되고 감사 기록에 남습니다. 구성원 초대·비활성화는 운영 인증(SSO) 연동 후 제공합니다.</p>}
      {policy.data && (
        <section className="card">
          <h2>승인 정책</h2>
          <Notice tone="info">아래 값은 개발용 설계 가정입니다. 실제 KODA 승인 정책·한도는 확인되지 않았습니다.</Notice>
          <ul>
            <li>출금 요청: 기본 {policy.data.approval.defaultRequiredApprovals}명 승인, 원화 평가액 {krwShort(policy.data.approval.highValueThresholdKrw)} 이상은 서로 다른 {policy.data.approval.highValueRequiredApprovals}명 승인</li>
            <li>주소 등록: {policy.data.addressBook.requireSecondPersonReview ? '등록자가 아닌 승인자의 확인 필요' : '확인 없이 사용'} · 주소 끝 {policy.data.addressBook.confirmTailLength}자리 재입력</li>
          </ul>
        </section>
      )}
    </div>
  );
}