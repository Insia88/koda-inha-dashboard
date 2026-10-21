import { useId, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { IconArrowRight } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useMe } from '../auth.tsx';
import { AmountText, Badge, DataStamp, Empty, ErrorState, Loading, PageHeader, StatusRail, Term, WaitedTime } from '../components/ui.tsx';
import { AllocationBar } from '../components/AllocationBar.tsx';
import { amount, dateTime, krw, krwShort, relative } from '../format.ts';
import { APPROVAL_WAIT_TEXT, approverNames, GLOSSARY, REQUEST_STATUS, TX_STATUS, TX_TYPE, type ApproverRef, type RequestStatus } from '../../shared/terms.ts';
import '../components/address-lifecycle.css';

/** 홈 '진행 중인 요청'의 상태 묶음. 결재 및 요청 화면의 '진행 중' 칩과 같다. */
const IN_PROGRESS_STATUSES = 'REVIEW,PENDING_APPROVAL,PROCESSING';

/**
 * '지금 처리할 일'의 화면 문구(A1). 서버가 정한 순서·이동 경로·색·건수는 그대로 쓰고, 제목과 설명만 누가·무엇을·어떻게 하는지 쉬운 문장으로 바꾼다.
 * 모르는 종류는 서버 문구를 그대로 쓴다. 사용 대기 주소 경고는 이 영역에 경고 색으로 남는다(A-31, DEC-003). 문구는 짧아졌을 뿐 옮기지 않는다.
 * 링크 이름에 메뉴 이름('홈'·'결재 및 요청')을 넣지 않는다(메뉴 링크와 헷갈리지 않게).
 */
const TASK_COPY: Record<string, { title: string; description: string }> = {
  approve_requests: { title: '승인할 출금 요청', description: '다른 담당자가 보낸 요청입니다. 받는 곳·주소·수량을 대조하고 한 건씩 승인하거나 반려하세요.' },
  blocked_requests: { title: '받는 주소가 사용 중지되어 승인할 수 없는 요청', description: '사유와 함께 반려하면 예약 수량이 풀립니다.' },
  review_addresses: { title: '확인할 새 주소', description: '등록자가 보낸 자료가 아니라, 미리 알고 있던 연락처로 받는 곳에 연락해 주소를 대조한 뒤 확인하세요.' },
  // 제목이 첫 정지 사유(모르는 등록)와 '정지하세요'를 맡고, 설명은 서버 문구의 둘째 정지 사유(받는 곳에서 확인되지 않음)와 정지 방법을 쓴다(같은 지시를 두 번 쓰지 않는다).
  cooling_addresses: { title: '사용 대기 중인 새 주소 — 모르는 등록이면 정지하세요', description: '확인을 마친 주소도 대기 시간이 지나야 출금에 쓸 수 있습니다. 받는 곳에서 확인되지 않은 주소도 정지하세요. 정지는 주소를 열어 「사용 대기 중 정지」로 합니다.' },
  my_drafts: { title: '제출 전 내 요청', description: '승인 요청을 보내야 승인자에게 보입니다.' },
  my_rejected: { title: '반려·실패한 내 요청 (최근 14일)', description: '사유를 확인하고 필요하면 새 요청을 작성하세요.' },
  my_blocked_requests: { title: '받는 주소가 사용 중지된 내 요청', description: '승인될 수 없는 요청입니다. 취소하면 예약 수량이 풀립니다.' },
  my_pending_addresses: { title: '동료 확인을 기다리는 내 주소', description: '등록자가 아닌 승인자가 확인해야 합니다. 이 대시보드는 알림을 보내지 않으니 승인자에게 직접 알려 주세요.' },
  audit_recent: { title: '최근 24시간 업무 기록', description: '요청·승인·주소·역할 변경 기록입니다. 감사 기록에서 내용과 무결성을 확인하세요.' },
};

/** 할 일 아래 한 줄 목록은 3건까지 보이고, 나머지는 '외 n건'으로 줄인다(전체는 할 일 링크의 목록에서 본다). */
const SUB_MAX = 3;

/** 진행 중인 요청 둘째 줄에 쓰는 승인 후보 이름 수. 넘으면 '외 n명'. */
const WAIT_NAMES_MAX = 3;

/**
 * 홈 진행 중 요청(승인 대기)의 누구 차례 문구(A2-1). 내가 후보에 들면 '승인할 수 있는 사람: 나·…'(첫 줄 '내 승인 차례' 배지는 그대로),
 * 아니면 '다른 사람 차례: …'. 후보가 없으면 '승인할 수 있는 사람 없음'. 서버가 후보를 주지 않으면(승인할 수 없는 요청 등) A1 차례 문구를 쓴다.
 */
function waitingText(cands: ApproverRef[], meId: string): string {
  if (cands.length === 0) return APPROVAL_WAIT_TEXT.nobody;
  const head = cands.some((c) => c.id === meId) ? APPROVAL_WAIT_TEXT.candidates : APPROVAL_WAIT_TEXT.othersTurn;
  return `${head}: ${approverNames(cands, meId, '·', WAIT_NAMES_MAX)}`;
}

/**
 * 남은 승인보다 승인할 수 있는 사람이 적은지(홈 '승인할 사람 부족', 요청 상세 경고와 같은 판정). 홈의 approved는 정족수에 든 승인 수(validApprovals)라
 * 서버 approvalWait.shortfall과 같은 값이다. 후보 0명은 머리 문구가 이미 '승인할 수 있는 사람 없음'이라 붙이지 않는다.
 */
function shortOf(r: { waitingFor: ApproverRef[]; requiredApprovals: number; approved: number }): boolean {
  return r.waitingFor.length > 0 && r.waitingFor.length < Number(r.requiredApprovals) - Number(r.approved);
}

type SubLine = { key: string; to: string; text: ReactNode };
type SubList = { items: SubLine[]; more: number };

function subList(lines: SubLine[], total: number): SubList {
  const items = lines.slice(0, SUB_MAX);
  return { items, more: Math.max(0, total - items.length) };
}

export function HomePage() {
  const me = useMe();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/api/dashboard'), refetchInterval: 15_000 });
  const countOf = (kind: string): number => q.data?.tasks.find((t: any) => t.kind === kind)?.count ?? 0;
  const approveN = countOf('approve_requests');
  const reviewN = countOf('review_addresses');
  const coolingN = countOf('cooling_addresses');
  // 할 일 아래 한 줄 목록: 이미 있는 조회 API를 건수가 있을 때만 부른다. 건수가 바뀌면 바로, 그 밖에는 홈과 같은 주기로 다시 불러온다.
  // 실패하면 한 줄 목록 없이 할 일 링크만 보인다. 승인·확인은 상세 화면에서 한 건씩 한다(A-34, 여기에는 선택·일괄 처리가 없다).
  const toApprove = useQuery({
    queryKey: ['requests', 'home-to-approve', approveN],
    queryFn: () => api('/api/requests?view=to_approve&order=asc&pageSize=10'),
    enabled: approveN > 0, refetchInterval: 15_000,
  });
  const toReview = useQuery({
    queryKey: ['addresses', 'home-to-review', reviewN],
    queryFn: () => api('/api/addresses?status=PENDING_REVIEW'),
    enabled: reviewN > 0, refetchInterval: 15_000,
  });
  const cooling = useQuery({
    queryKey: ['addresses', 'home-cooling', coolingN],
    queryFn: () => api('/api/addresses?status=COOLING_DOWN'),
    enabled: coolingN > 0, refetchInterval: 15_000,
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const h = d.holdings;
  const open = d.tasks.filter((t: any) => t.count > 0);
  const can = (p: string) => me.permissions.includes(p);

  const subs: Record<string, SubList | undefined> = {};
  if (approveN > 0 && toApprove.data) {
    const items: any[] = toApprove.data.items;
    subs.approve_requests = subList(items.map((r) => ({
      key: r.id, to: `/requests/${r.id}`,
      // 기다린 시간은 아래 진행 중인 요청·요청 상세와 같은 '승인 요청 n시간째'(내림)로 쓴다. 같은 요청이 두 카드에서 다른 숫자로 보이지 않게 한다.
      text: <>{r.createdBy.name}님 · {amount(r.amount, r.assetCode)} → {r.address.label} · <span className="nowrap">승인 요청 <WaitedTime iso={r.submittedAt} /></span></>,
    })), toApprove.data.total);
  }
  if (reviewN > 0 && toReview.data) {
    const items: any[] = toReview.data.items.filter((a: any) => a.allowedActions?.includes('review'));
    subs.review_addresses = subList(items.map((a) => ({
      key: a.id, to: `/addresses/${a.id}`,
      text: <>{a.createdBy.name}님 등록 · {a.label} ({a.assetCode}/{a.networkName}) · {relative(a.createdAt)}</>,
    })), items.length);
  }
  if (coolingN > 0 && cooling.data) {
    const items: any[] = cooling.data.items;
    subs.cooling_addresses = subList(items.map((a) => ({
      key: a.id, to: `/addresses/${a.id}`,
      text: (
        <>
          <span>{a.label} · {a.createdBy.name} 등록 · {a.reviewedBy?.name ?? '확인자 미상'} 확인 · {a.activeFrom ? `${dateTime(a.activeFrom).slice(5)}부터 사용 가능` : '사용 대기 중'}</span>
          {a.createdBy.id === me.user.id && <span className="task-sub-note">내가 등록한 주소 — 내가 요청한 등록이 맞는지 확인하세요</span>}
          {a.reviewedBy?.id === me.user.id && <span className="task-sub-note">내가 확인한 주소</span>}
        </>
      ),
    })), items.length);
  }
  // 진행 중인 요청 가운데 지금 내가 승인할 차례인 요청(위 승인할 요청 목록과 같은 기준)
  const myTurn = new Set<string>(approveN > 0 ? (toApprove.data?.items ?? []).map((r: any) => r.id) : []);

  return (
    <div className="page home">
      <PageHeader
        title={`${me.org.name} 자산 현황`}
        description={<>현재 보유 자산, 처리할 업무, 진행 중인 요청을 한 화면에서 확인합니다.</>}
      />

      {/* A7(신뢰·직관): 첫 화면에서 주소 확인·사용 대기·내 승인 차례·진행 중 요청을 한눈에. 모두 0이면 지금 확인할 항목이 없습니다. */}
      <section className="safety-strip" aria-labelledby="safety-h">
        <div className="safety-head">
          <h2 id="safety-h">확인 상태</h2>
          <p className="muted small">주소·승인·진행 상황을 한눈에 확인합니다. 모두 0이면 지금 확인할 항목이 없습니다.</p>
        </div>
        <ul className="safety-list">
          {([
            ['review_addresses', '주소 확인 대기', reviewN, reviewN > 0 ? '확인이 필요합니다' : '없음', '/addresses'],
            ['cooling_addresses', '사용 대기 주소', coolingN, coolingN > 0 ? '대기 중 · 모르는 등록이면 정지' : '없음', '/addresses'],
            ['approve_requests', '내 승인 차례', approveN, approveN > 0 ? '내가 승인할 수 있습니다' : '없음', '/requests?status=PENDING_APPROVAL'],
          ] as const).map(([kind, label, count, hint, fallback]) => {
            const href = (q.data?.tasks ?? []).find((t: any) => t.kind === kind)?.href ?? fallback;
            return (
              <li key={kind}>
                <Link to={href} className="safety-item">
                  <span className="safety-label">{label}</span>
                  <span className="safety-value">{count}<span className="safety-unit">건</span></span>
                  <span className={`safety-hint${count > 0 ? ' is-warn' : ''}`}>{hint}</span>
                </Link>
              </li>
            );
          })}
          <li>
            <Link to={`/requests?status=${IN_PROGRESS_STATUSES}`} className="safety-item">
              <span className="safety-label">진행 중 요청</span>
              <span className="safety-value">{q.data?.inProgressCount ?? 0}<span className="safety-unit">건</span></span>
              <span className="safety-hint">처리 결과를 기다리는 요청</span>
            </Link>
          </li>
        </ul>
      </section>

      <div className="home-grid">
        <div className="home-col">
        <section className="card card-tasks" aria-labelledby="tasks-h">
          <div className="card-head">
            <h2 id="tasks-h">지금 처리할 일</h2>
            <span className="muted small">{me.roleLabels.join(' · ')} 기준</span>
          </div>
          {open.length === 0 ? (
            <Empty title="지금 처리할 일이 없습니다">
              {can('request.create') ? '출금이 필요하면 요청을 작성하세요. 새 받는 곳은 보낼 곳 주소록에 먼저 등록해야 합니다.' : can('request.approve') ? '승인이나 확인을 기다리는 항목이 생기면 여기에 표시됩니다.' : '이 역할에 배정된 처리 항목이 없습니다. 아래에서 자산과 진행 상황을 확인하세요.'}
            </Empty>
          ) : (
            <ul className="task-list">
              {open.map((t: any) => {
                const copy = TASK_COPY[t.kind] ?? { title: t.title, description: t.description };
                const sub = subs[t.kind];
                return (
                  <li key={t.kind} className="task-item">
                    <Link to={t.href} className={`task task-${t.tone}`}>
                      <span className="task-count" aria-hidden="true">{t.count}</span>
                      <span className="task-body">
                        <span className="task-title">{copy.title} <span className="sr-only">{t.count}건</span></span>
                        <span className="task-desc">{copy.description}</span>
                      </span>
                      <IconArrowRight size={18} aria-hidden="true" className="task-go" />
                    </Link>
                    {sub && sub.items.length > 0 && (
                      <ul className="task-sub">
                        {sub.items.map((s) => (
                          <li key={s.key}><Link to={s.to} className="task-sub-link">{s.text}</Link></li>
                        ))}
                        {sub.more > 0 && <li className="task-sub-more">외 {sub.more}건</li>}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <HoldingsCard h={h} className="only-narrow" />

        <section className="card card-progress" aria-labelledby="prog-h">
          <div className="card-head">
            <h2 id="prog-h">진행 중인 요청 <span className="muted">{d.inProgressCount}건</span></h2>
            {/* 결재 및 요청의 '진행 중' 칩과 같은 상태 묶음이라 건수가 같다. */}
            <Link to={`/requests?status=${IN_PROGRESS_STATUSES}`} className="link-more">전체 보기 <IconArrowRight size={14} aria-hidden="true" /></Link>
          </div>
          {d.inProgress.length === 0 ? <Empty title="진행 중인 요청이 없습니다">검토·승인 대기·처리 중인 요청이 생기면 단계와 함께 표시됩니다.</Empty> : (
            <ul className="progress-list">
              {d.inProgress.map((r: any) => {
                const st = REQUEST_STATUS[r.status as RequestStatus];
                const waiting = r.status === 'PENDING_APPROVAL' && Array.isArray(r.waitingFor);
                return (
                  <li key={r.id}>
                    <Link to={`/requests/${r.id}`} className="progress-item">
                      {/* 첫 줄은 번호·상태·'내 승인 차례'·수량만 둬서 수량이 줄마다 같은 자리에 오게 한다. 누구 차례인지는 둘째 줄 맨 앞에 쓴다(표시용, 상태 이름은 그대로). */}
                      <div className="progress-top">
                        <span className="ref">{r.refNo}</span>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        {myTurn.has(r.id) && <span className="badge badge-turn">내 승인 차례</span>}
                        <span className="progress-amt">{amount(r.amount, r.assetCode)}</span>
                      </div>
                      <div className="progress-meta small" style={{ color: 'var(--ink-2)' }}>
                        {/* 승인 대기: 지금 승인할 수 있는 사람과 '승인 요청 n시간째'(A2-1, 요청 상세와 같은 이름, 지연 색 없음). 서버가 후보를 주지 않으면 A1 차례 문구.
                            남은 승인보다 후보가 적으면 끝에 '승인할 사람 부족'(글자가 뜻을 전하고 색은 보조). */}
                        {waiting
                          ? <><span className="turn-text turn-wait">{waitingText(r.waitingFor, me.user.id)} · <span className="nowrap">승인 요청 <WaitedTime iso={r.submittedAt} /></span>{shortOf(r) && <> · <span className="warn-text turn-short">{APPROVAL_WAIT_TEXT.short}</span></>}</span> · </>
                          : st.turn && <><span className="turn-text">{st.turn}</span> · </>}
                        {/* 이름 줄을 보인 행은 같은 줄에 상대 시간이 두 번 오지 않게 절대 시각만 둔다(기다린 시간은 앞의 '승인 요청 n시간째'). */}
                        {r.creatorName} → {r.addressLabel} · <time className="nowrap" dateTime={r.updatedAt}>{dateTime(r.updatedAt)}</time>{!waiting && <> <span className="muted nowrap">({relative(r.updatedAt)})</span></>}
                        {r.status === 'PENDING_APPROVAL' && <span className="nowrap"> · 승인 {r.approved}/{r.requiredApprovals}</span>}
                      </div>
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
        <HoldingsCard h={h} className="only-wide" />

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
                  {t.poison && <span className="lc-poison-flag">주소 오염 의심 · 보낸 주소를 복사하지 마세요</span>}
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

/** 보유 자산 카드. 넓은 화면은 오른쪽 열, 좁은 화면(≤1100px)은 '지금 처리할 일' 바로 아래에 한 번만 보인다(다른 쪽은 display:none). */
function HoldingsCard({ h, className }: { h: any; className: string }) {
  const hid = useId();
  return (
      <section className={`card card-holdings ${className}`} aria-labelledby={hid}>
        <div className="card-head">
          <h2 id={hid}>보유 자산</h2>
          <Link to="/balances" className="link-more">잔고 상세 <IconArrowRight size={14} aria-hidden="true" /></Link>
        </div>
        <div className="total">
          <div className="total-label"><Term label="총 평가액">{GLOSSARY.valuation}</Term></div>
          <div className="total-value"><AmountText text={krwShort(h.totalKrw)} /></div>
          <div className="total-exact muted">{krw(h.totalKrw)}</div>
          {/* 총 평가액을 보는 자리에서 스테이킹이 들어가는지 묻게 되므로 합계 바로 아래에 짧게 쓴다(긴 설명은 잔고 화면 아래). */}
          <p className="muted small total-staking-note">스테이킹 현황의 맡긴 수량·보상은 이 합계에 넣지 않았습니다(모의 데이터).</p>
          <DataStamp asOf={h.price.asOf} state={h.price.state} source={h.price.source} label="시세 기준" />
          {h.price.state === 'stale' && <p className="warn-text">시세가 {h.price.staleAfterMinutes}분 넘게 갱신되지 않았습니다. 평가액이 실제와 다를 수 있습니다. 수량은 영향을 받지 않습니다.</p>}
        </div>
        {h.assets.length === 0 ? <Empty title="보유 자산이 없습니다">입금이 확인되면 여기에 표시됩니다. 입금 주소는 우리 회사 입금 주소 화면에서 확인하세요.</Empty> : (
          <>
            <AllocationBar items={h.assets.map((a: any) => ({ key: a.assetCode, label: a.assetCode, value: a.krwValue ?? '0' }))} caption="자산별 평가액 비중 (모의 시세 기준)" />
            <table className="table table-compact table-stack">
              <caption className="sr-only">자산별 보유 수량과 평가액</caption>
              <thead><tr><th scope="col">자산</th><th scope="col" className="num">보유 수량</th><th scope="col" className="num"><Term label="사용 가능">{GLOSSARY.available}</Term></th><th scope="col" className="num">평가액</th></tr></thead>
              <tbody>
                {h.assets.map((a: any) => (
                  <tr key={a.assetCode}>
                    <th scope="row"><span className="asset-code">{a.assetCode}</span> <span className="muted small">{a.name}</span></th>
                    <td className="num qty" data-label="보유 수량"><AmountText text={amount(a.total, a.assetCode)} /></td>
                    {/* '예약'은 예약 이체로 읽히기 쉬워 무엇에 묶였는지 쓴다(A1). 승인 대기와 처리 중 모두 묶여 있으므로(처리가 끝날 때 풀림) 두 경우에 맞는 말을 쓴다. 뜻은 잔고 화면의 '묶인 수량(예약)' 설명과 같다. */}
                    <td className="num qty" data-label="사용 가능"><AmountText text={amount(a.available, a.assetCode)} />{a.reserved !== '0' && <div className="muted small">출금 요청에 묶임 {amount(a.reserved)}</div>}</td>
                    <td className="num" data-label="평가액">{krwShort(a.krwValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">잔고 기준 {dateTime(h.balanceAsOf)} KST · 수량은 모의 데이터입니다.</p>
          </>
        )}
      </section>
  );
}
