import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { useMe } from '../auth.tsx';
import { ApiErrorNotice, ErrorState, Loading, Notice, PageHeader } from '../components/ui.tsx';
import { krwThreshold } from '../components/RequestForm.tsx';
import { krwShort } from '../format.ts';
import { ROLE_LABEL, type Role } from '../../shared/terms.ts';
import { CONFIRM_MIDDLE_LENGTH } from '../../shared/address-rules.ts';

const ROLES: Role[] = ['requester', 'approver', 'auditor', 'admin'];

/**
 * 역할 변경 영향 안내(A1): 이미 받은 구성원 목록(활성 사용자만)에 고친 역할을 넣어, 저장하면 역할별 인원이 어떻게 되는지 저장 전에 보인다.
 * 안내만 한다. 저장은 지금처럼 한 번에 즉시 적용되고(A-19), 서버 규칙(본인 역할 상승 금지·마지막 관리자·제출 때 승인자 부족 거부)은 그대로다.
 */
function RoleImpact({ members, editing, policy }: { members: any[]; editing: { id: string; roles: Role[] }; policy?: { highValueThresholdKrw: string; highValueRequiredApprovals: number } }) {
  const active = members.filter((m) => m.isActive);
  const rolesOf = (m: any): Role[] => (m.id === editing.id ? editing.roles : m.roles);
  const count = (r: Role) => active.filter((m) => rolesOf(m).includes(r)).length;
  const approvers = count('approver');
  const requesters = count('requester');
  const admins = count('admin');
  const warnings: string[] = [];
  if (approvers === 0) warnings.push('승인자가 0명이 되면 아무도 출금 요청을 승인하거나 새 주소를 확인할 수 없고, 승인 요청 보내기가 거부됩니다.');
  else if (policy && approvers < policy.highValueRequiredApprovals) {
    warnings.push(`승인자가 ${approvers}명이면 원화 평가액 ${krwThreshold(policy.highValueThresholdKrw)} 이상 출금(서로 다른 승인자 ${policy.highValueRequiredApprovals}명 필요, 설계 가정)은 승인 요청을 보낼 수 없습니다. 요청을 작성한 본인은 승인자 수에서 빠집니다.`);
  }
  if (requesters === 0) warnings.push('자산 담당자가 0명이 되면 출금 요청 작성과 주소 등록을 할 수 없습니다.');
  return (
    // 인원 줄과 경고를 한 번에 읽어 주도록 바깥 상자를 알림 영역으로 둔다(경고만 빠지지 않게).
    <div className="role-impact" role="status">
      <p className="small role-impact-note">저장하면 승인자 {approvers}명 · 자산 담당자 {requesters}명 · 조직 관리자 {admins}명이 됩니다.</p>
      {warnings.map((w) => <Notice key={w} tone="warning">{w}</Notice>)}
    </div>
  );
}

export function OrgPage() {
  const me = useMe();
  const qc = useQueryClient();
  const canManage = me.permissions.includes('org.manage');
  const members = useQuery({ queryKey: ['members'], queryFn: () => api('/api/org/members') });
  const policy = useQuery({ queryKey: ['policy'], queryFn: () => api('/api/org/policy') });
  const [editing, setEditing] = useState<{ id: string; name: string; roles: Role[]; rolesVersion: number } | null>(null);
  // 방금 역할을 저장한 구성원 이름. 저장 버튼이 사라지므로 결과 안내로 포커스를 옮긴다.
  const [saved, setSaved] = useState<string | null>(null);
  const savedRef = useRef<HTMLDivElement>(null);
  const save = useMutation({
    mutationFn: () => api(`/api/org/members/${editing!.id}/roles`, { method: 'PUT', body: { roles: editing!.roles, rolesVersion: editing!.rolesVersion } }),
    onSuccess: () => { setSaved(editing?.name ?? null); setEditing(null); qc.invalidateQueries({ queryKey: ['members'] }); qc.invalidateQueries({ queryKey: ['me'] }); },
  });
  useEffect(() => {
    if (!saved) return;
    const raf = requestAnimationFrame(() => { const el = savedRef.current; if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); } });
    return () => cancelAnimationFrame(raf);
  }, [saved]);
  if (members.isPending) return <Loading />;
  if (members.error) return <ErrorState error={members.error} onRetry={() => members.refetch()} />;
  return (
    <div className="page">
      <PageHeader title="조직 관리" description={`${me.org.name}의 구성원과 역할, 승인 정책입니다.`} />
      <section className="card">
        <h2>역할 설명</h2>
        <ul className="role-list">{ROLES.map((r) => <li key={r}><b>{ROLE_LABEL[r].label}</b> — {ROLE_LABEL[r].description}</li>)}</ul>
        <p className="muted small">한 사람이 자산 담당자와 승인자 역할을 함께 가질 수 있지만, 자기 요청과 자기가 등록한 주소는 승인할 수 없습니다. 출금 요청 화면의 '요청자'는 그 요청을 작성한 사람입니다.</p>
      </section>
      <div className="table-wrap">
        {/* 좁은 화면(≤560px)에서는 구성원마다 레이블이 붙은 카드로 쌓인다. */}
        <table className="table table-stack">
          <caption className="sr-only">구성원 목록</caption>
          <thead><tr><th scope="col">이름</th><th scope="col">직함</th><th scope="col">이메일 (모의)</th><th scope="col">역할</th>{canManage && <th scope="col"><span className="sr-only">작업</span></th>}</tr></thead>
          <tbody>
            {members.data.map((m: any) => (
              <tr key={m.id}>
                <th scope="row">{m.name}{m.id === me.user.id && <span className="muted small"> (나)</span>}</th>
                <td data-label="직함">{m.title}</td>
                <td className="small" data-label="이메일 (모의)">{m.email}</td>
                <td className="stack-full" data-label="역할">
                  {editing?.id === m.id ? (
                    <>
                      <fieldset className="role-edit">
                        <legend className="sr-only">{m.name} 역할</legend>
                        {ROLES.map((r) => (
                          <label key={r} className="check-inline"><input type="checkbox" checked={editing!.roles.includes(r)} onChange={(e) => { const cur = editing!; setEditing({ ...cur, roles: e.target.checked ? [...cur.roles, r] : cur.roles.filter((x) => x !== r) }); }} />{ROLE_LABEL[r].label}</label>
                        ))}
                      </fieldset>
                      <RoleImpact members={members.data} editing={editing!} policy={policy.data?.approval} />
                    </>
                  ) : m.roles.map((r: Role) => ROLE_LABEL[r].label).join(', ') || <span className="muted">역할 없음</span>}
                </td>
                {canManage && (
                  <td className="nowrap stack-full">
                    {editing?.id === m.id ? (
                      <><button className="btn btn-primary btn-sm" onClick={() => save.mutate()} disabled={save.isPending}>저장</button> <button className="btn btn-sm" onClick={() => { setEditing(null); save.reset(); }}>취소</button></>
                    ) : <button className="btn btn-sm" onClick={() => { save.reset(); setSaved(null); setEditing({ id: m.id, name: m.name, roles: m.roles, rolesVersion: m.rolesVersion }); }}>역할 변경</button>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {saved && (
        <div ref={savedRef} tabIndex={-1} className="rc-focus-target">
          <Notice tone="success" role="status">{saved}님의 역할을 저장했습니다. 바로 적용되었고 감사 기록에 남았습니다.</Notice>
        </div>
      )}
      <ApiErrorNotice error={save.error} />
      {canManage && <p className="muted small">역할 변경은 즉시 적용되고 감사 기록에 남습니다. 구성원 초대·비활성화는 운영 인증(SSO) 연동 후 제공합니다.</p>}
      {policy.data && (
        <section className="card">
          <h2>승인 정책</h2>
          <Notice tone="info">아래 값은 개발용 설계 가정입니다. 실제 KODA 승인 정책·한도는 확인되지 않았습니다.</Notice>
          <ul>
            <li>출금 요청: 기본 {policy.data.approval.defaultRequiredApprovals}명 승인, 원화 평가액 {krwShort(policy.data.approval.highValueThresholdKrw)} 이상은 서로 다른 {policy.data.approval.highValueRequiredApprovals}명 승인</li>
            <li>주소 등록: {policy.data.addressBook.requireSecondPersonReview ? '등록자가 아닌 승인자의 확인 필요' : '확인 없이 사용'} · 등록할 때와 확인할 때 원본을 보고 주소 끝 {policy.data.addressBook.confirmTailLength}자리와 가운데 {CONFIRM_MIDDLE_LENGTH}자리를 다시 입력</li>
          </ul>
        </section>
      )}
    </div>
  );
}