import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { Badge, Empty, ErrorState, Loading, Notice, PageHeader, Term } from '../components/ui.tsx';
import { amount, date } from '../format.ts';
import { GLOSSARY, GLOSSARY_LABEL } from '../../shared/terms.ts';

export function StakingPage() {
  const q = useQuery({ queryKey: ['staking'], queryFn: () => api('/api/staking') });
  return (
    <div className="page">
      <PageHeader title="스테이킹 현황" description={<><Term label={GLOSSARY_LABEL.staking}>{GLOSSARY.staking}</Term>에 맡긴 자산과 최근 30일 보상입니다.</>} />
      <Notice tone="info">스테이킹 신청·해제 절차와 권한은 확인된 자료가 없어 이 화면은 조회만 제공합니다. 맡긴 자산은 해제 기간 동안 출금할 수 없습니다. 이 화면의 수량은 잔고의 총 평가액에 따로 더하지 않습니다.</Notice>
      {q.isPending ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : q.data.length === 0 ? (
        <Empty title="스테이킹 중인 자산이 없습니다">스테이킹 이용은 KODA 담당자와 협의합니다.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">스테이킹 현황</caption>
            <thead><tr><th scope="col">자산 / 네트워크</th><th scope="col"><Term label={GLOSSARY_LABEL.validator}>{GLOSSARY.validator}</Term></th><th scope="col" className="num">맡긴 수량</th><th scope="col" className="num">최근 30일 보상</th><th scope="col">상태</th><th scope="col">시작일</th></tr></thead>
            <tbody>
              {q.data.map((s: any) => (
                <tr key={s.id}>
                  <th scope="row"><span className="asset-code">{s.assetCode}</span> / {s.networkName}</th>
                  <td>{s.validatorLabel}</td>
                  <td className="num">{amount(s.staked, s.assetCode)}</td>
                  <td className="num">+{amount(s.reward30d, s.assetCode)}</td>
                  <td>{s.status === 'active' ? <Badge tone="success">스테이킹 중</Badge> : <Badge tone="warning"><Term label={GLOSSARY_LABEL.unbonding}>{GLOSSARY.unbonding}</Term></Badge>}</td>
                  <td>{date(s.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">모든 수량은 모의 데이터입니다. 보상률은 표시하지 않습니다(근거 자료 없음).</p>
    </div>
  );
}
