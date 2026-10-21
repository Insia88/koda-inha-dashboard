import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { AddressStrip, Empty, ErrorState, Loading, Notice, PageHeader } from '../components/ui.tsx';
import { amount } from '../format.ts';

export function WalletsPage() {
  const q = useQuery({ queryKey: ['wallets'], queryFn: () => api('/api/wallets') });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="page">
      <PageHeader title="우리 회사 입금 주소" description="다른 곳에서 우리 회사로 입금받을 때 알려 줄 주소입니다(KODA가 보관하는 조직 지갑). 네트워크가 맞는 지갑의 주소를 알려 주세요." />
      <Notice tone="warning" title="입금 주소를 알려 줄 때 네트워크도 함께 알려 주세요">
        지갑마다 받을 수 있는 자산과 네트워크가 정해져 있습니다. 다른 네트워크로 보내면 입금이 확인되지 않거나 회수가 어려울 수 있습니다. 화면의 주소는 모의 주소입니다.
      </Notice>
      {q.data.length === 0 ? <Empty title="조직 지갑이 없습니다">지갑 생성은 KODA 담당자와 협의합니다. 이 개발 환경에서는 지갑 생성 기능을 제공하지 않습니다.</Empty> : (
        <div className="wallet-grid">
          {q.data.map((w: any) => (
            <section key={w.id} className="card wallet" aria-labelledby={`w-${w.id}`}>
              <h2 id={`w-${w.id}`}>{w.name}</h2>
              <p className="muted small">네트워크 <b>{w.networkName}</b> · 받을 수 있는 자산: {w.acceptedAssets.join(', ')}</p>
              <div className="verify-box">
                <div className="verify-label">입금 주소 (모의)</div>
                <AddressStrip address={w.depositAddress} memo={w.depositMemo} memoLabel={w.memoLabel} />
                {w.depositMemo && <p className="warn-text small">이 지갑으로 입금할 때는 {w.memoLabel} {w.depositMemo}를 꼭 함께 입력하도록 안내하세요.</p>}
              </div>
              <table className="table table-compact">
                <caption className="sr-only">{w.name} 잔고</caption>
                <thead><tr><th scope="col">자산</th><th scope="col" className="num">보유</th><th scope="col" className="num">사용 가능</th></tr></thead>
                <tbody>{w.balances.map((b: any) => <tr key={b.assetCode}><th scope="row">{b.assetCode}</th><td className="num">{amount(b.total, b.assetCode)}</td><td className="num">{amount(b.available, b.assetCode)}</td></tr>)}</tbody>
              </table>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}