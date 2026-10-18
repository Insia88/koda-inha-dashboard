import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { IconArrowRight, IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useMe } from '../auth.tsx';
import { Badge, DataStamp, Empty, ErrorState, Loading, PageHeader, StatusRail, Term } from '../components/ui.tsx';
import { AllocationBar } from '../components/AllocationBar.tsx';
import { amount, dateTime, krw, krwShort, relative } from '../format.ts';
import { GLOSSARY, REQUEST_STATUS, TX_STATUS, TX_TYPE, type RequestStatus } from '../../shared/terms.ts';

export function HomePage() {
  const me = useMe();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/api/dashboard'), refetchInterval: 15_000 });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const h = d.holdings;
  const open = d.tasks.filter((t: any) => t.count > 0);
  const can = (p: string) => me.permissions.includes(p);

  return (
    <div className="page home">
      <PageHeader
        title={`${me.org.name} 자산 현황`}
        description={<>현재 보유 자산, 처리할 업무, 진행 중인 요청을 한 화면에서 확인합니다.</>}
        actions={can('request.create') ? <Link className="btn btn-primary" to="/requests/new"><IconPlus size={16} aria-hidden="true" />출금 요청 작성</Link> : undefined}
      />

      <div className="home-grid">
        <div className="home-col">
        <section className="card card-tasks" aria-labelledby="tasks-h">
          <div className="card-head">
            <h2 id="tasks-h">지금 처리할 일</h2>
            <span className="muted small">{me.roleLabels.join(' · ')} 기준</span>
          </div>
          {open.length === 0 ? (
            <Empty title="지금 처리할 일이 없습니다">
              {can('request.create') ? '출금이 필요하면 요청을 작성하세요. 새 받는 곳은 주소록에 먼저 등록해야 합니다.' : '새 요청이 오면 여기에 표시됩니다.'}
            </Empty>
          ) : (
            <ul className="task-list">
              {open.map((t: any) => (
                <li key={t.kind}>
                  <Link to={t.href} className={`task task-${t.tone}`}>
                    <span className="task-count" aria-hidden="true">{t.count}</span>
                    <span className="task-body">
                      <span className="task-title">{t.title} <span className="sr-only">{t.count}건</span></span>
                      <span className="task-desc">{t.description}</span>
                    </span>
                    <IconArrowRight size={18} aria-hidden="true" className="task-go" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card card-progress" aria-labelledby="prog-h">
          <div className="card-head">
            <h2 id="prog-h">진행 중인 요청 <span className="muted">{d.inProgressCount}건</span></h2>
            <Link to="/requests?status=REVIEW,PENDING_APPROVAL,PROCESSING" className="link-more">전체 보기 <IconArrowRight size={14} aria-hidden="true" /></Link>
          </div>
          {d.inProgress.length === 0 ? <Empty title="진행 중인 요청이 없습니다">검토·승인 대기·처리 중인 요청이 생기면 단계와 함께 표시됩니다.</Empty> : (
            <ul className="progress-list">
              {d.inProgress.map((r: any) => {
                const st = REQUEST_STATUS[r.status as RequestStatus];
                return (
                  <li key={r.id}>
                    <Link to={`/requests/${r.id}`} className="progress-item">
                      <div className="progress-top">
                        <span className="ref">{r.refNo}</span>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        <span className="progress-amt">{amount(r.amount, r.assetCode)}</span>
                      </div>
                      <div className="progress-meta muted small">{r.creatorName} → {r.addressLabel} · {relative(r.updatedAt)}{r.status === 'PENDING_APPROVAL' && ` · 승인 ${r.approved}/${r.requiredApprovals}`}</div>
                      <StatusRail step={st.step} status={r.status} compact />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        </div>
        <div className="home-col">
        <section className="card card-holdings" aria-labelledby="hold-h">
          <div className="card-head">
            <h2 id="hold-h">보유 자산</h2>
            <Link to="/balances" className="link-more">잔고 상세 <IconArrowRight size={14} aria-hidden="true" /></Link>
          </div>
          <div className="total">
            <div className="total-label"><Term label="총 평가액">{GLOSSARY.valuation}</Term></div>
            <div className="total-value">{krwShort(h.totalKrw)}</div>
            <div className="total-exact muted">{krw(h.totalKrw)}</div>
            <DataStamp asOf={h.price.asOf} state={h.price.state} source={h.price.source} label="시세 기준" />
            {h.price.state === 'stale' && <p className="warn-text">시세가 {h.price.staleAfterMinutes}분 넘게 갱신되지 않았습니다. 평가액이 실제와 다를 수 있습니다. 수량은 영향을 받지 않습니다.</p>}
          </div>
          {h.assets.length === 0 ? <Empty title="보유 자산이 없습니다">입금이 확인되면 여기에 표시됩니다. 입금 주소는 지갑 관리에서 확인하세요.</Empty> : (
            <>
              <AllocationBar items={h.assets.map((a: any) => ({ key: a.assetCode, label: a.assetCode, value: a.krwValue ?? '0' }))} caption="자산별 평가액 비중 (모의 시세 기준)" />
              <table className="table table-compact table-stack">
                <caption className="sr-only">자산별 보유 수량과 평가액</caption>
                <thead><tr><th scope="col">자산</th><th scope="col" className="num">보유 수량</th><th scope="col" className="num"><Term label="사용 가능">{GLOSSARY.available}</Term></th><th scope="col" className="num">평가액</th></tr></thead>
                <tbody>
                  {h.assets.map((a: any) => (
                    <tr key={a.assetCode}>
                      <th scope="row"><span className="asset-code">{a.assetCode}</span> <span className="muted small">{a.name}</span></th>
                      <td className="num" data-label="보유 수량">{amount(a.total, a.assetCode)}</td>
                      <td className="num" data-label="사용 가능">{amount(a.available, a.assetCode)}{a.reserved !== '0' && <div className="muted small">예약 {amount(a.reserved)}</div>}</td>
                      <td className="num" data-label="평가액">{krwShort(a.krwValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">잔고 기준 {dateTime(h.balanceAsOf)} KST · 수량은 모의 데이터입니다.</p>
            </>
          )}
        </section>

        <section className="card card-recent" aria-labelledby="recent-h">
          <div className="card-head">
            <h2 id="recent-h">최근 자산 활동</h2>
            <Link to="/activity" className="link-more">활동 내역 <IconArrowRight size={14} aria-hidden="true" /></Link>
          </div>
          {d.recentActivity.length === 0 ? <Empty title="아직 자산 활동이 없습니다" /> : (
            <ul className="recent-list">
              {d.recentActivity.map((t: any) => (
                <li key={t.id}>
                  <span className={`dir dir-${t.type}`}>{TX_TYPE[t.type]}</span>
                  <span className="recent-cp" title={t.counterparty}>{t.counterparty}</span>
                  <span className="num">{t.type === 'withdrawal' ? '−' : '+'}{amount(t.amount, t.assetCode)}</span>
                  <Badge tone={TX_STATUS[t.status]!.tone}>{TX_STATUS[t.status]!.label}</Badge>
                  <span className="muted small">{dateTime(t.occurredAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        </div>
      </div>
    </div>
  );
}