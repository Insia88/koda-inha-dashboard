import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { DataStamp, Empty, ErrorState, Loading, PageHeader, Term } from '../components/ui.tsx';
import { AllocationBar } from '../components/AllocationBar.tsx';
import { amount, dateTime, krw, krwShort } from '../format.ts';
import { GLOSSARY } from '../../shared/terms.ts';

export function BalancesPage() {
  const q = useQuery({ queryKey: ['balances'], queryFn: () => api('/api/balances'), refetchInterval: 30_000 });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const h = q.data;
  return (
    <div className="page">
      <PageHeader title="잔고" description="자산별 보유 수량과, 승인 대기 요청에 묶인 예약 수량을 지갑·네트워크별로 보여 줍니다." />
      <section className="card">
        <div className="total total-row">
          <div><div className="total-label"><Term label="총 평가액">{GLOSSARY.valuation}</Term></div><div className="total-value">{krwShort(h.totalKrw)}</div><div className="muted">{krw(h.totalKrw)}</div></div>
          <div className="stamps"><DataStamp asOf={h.price.asOf} state={h.price.state} source={h.price.source} label="시세 기준" /><span className="stamp">잔고 기준 {dateTime(h.balanceAsOf)} KST</span></div>
        </div>
        {h.assets.length > 0 && <AllocationBar items={h.assets.map((a: any) => ({ key: a.assetCode, label: a.assetCode, value: a.krwValue ?? '0' }))} caption="자산별 평가액 비중 (모의 시세 기준)" />}
      </section>
      {h.assets.length === 0 ? <Empty title="보유 자산이 없습니다">입금 주소는 지갑 관리에서 확인할 수 있습니다.</Empty> : (
        <>
          {/* 넓은 화면: 자산·지갑 표. 좁은 화면(≤560px)에서는 숨기고 아래 자산별 덩어리를 보인다. */}
          <div className="table-wrap bal-wide">
            <table className="table">
              <caption className="sr-only">자산·지갑별 잔고</caption>
              <thead><tr><th scope="col">자산</th><th scope="col">지갑 / 네트워크</th><th scope="col" className="num">보유 수량</th><th scope="col" className="num"><Term label="예약">{GLOSSARY.reserved}</Term></th><th scope="col" className="num"><Term label="사용 가능">{GLOSSARY.available}</Term></th><th scope="col" className="num">모의 시세 (원)</th><th scope="col" className="num">평가액</th></tr></thead>
              <tbody>
                {h.assets.flatMap((a: any) => a.byWallet.map((w: any, i: number) => (
                  <tr key={a.assetCode + w.walletId} className={i === 0 ? 'group-start' : ''}>
                    {i === 0 && <th scope="rowgroup" rowSpan={a.byWallet.length}><span className="asset-code">{a.assetCode}</span><div className="muted small">{a.name}</div></th>}
                    <td>{w.walletName}<div className="muted small">{w.networkName}</div></td>
                    <td className="num">{amount(w.total, a.assetCode)}</td>
                    <td className={`num ${w.reserved === '0' ? 'muted' : ''}`}>{amount(w.reserved, a.assetCode)}</td>
                    <td className="num strong">{amount(w.available, a.assetCode)}</td>
                    {i === 0 && <td className="num" rowSpan={a.byWallet.length}>{krw(a.krwPrice)}</td>}
                    {i === 0 && <td className="num" rowSpan={a.byWallet.length}>{krwShort(a.krwValue)}<div className="muted small">{krw(a.krwValue)}</div></td>}
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          <div className="bal-blocks">
            {h.assets.map((a: any) => (
              <section key={a.assetCode} className="card" aria-labelledby={`bal-${a.assetCode}`}>
                <div className="bal-head">
                  <h2 id={`bal-${a.assetCode}`}><span className="asset-code">{a.assetCode}</span><span className="muted small">{a.name}</span></h2>
                  <div className="bal-value"><strong>{krwShort(a.krwValue)}</strong><div className="muted small">{krw(a.krwValue)}</div></div>
                </div>
                <p className="muted small bal-price">모의 시세 1 {a.assetCode} = {krw(a.krwPrice)}</p>
                <table className="table table-compact table-stack">
                  <caption className="sr-only">{a.assetCode} 지갑별 잔고</caption>
                  <thead><tr><th scope="col">지갑 / 네트워크</th><th scope="col" className="num">보유 수량</th><th scope="col" className="num">사용 가능</th><th scope="col" className="num">예약</th></tr></thead>
                  <tbody>
                    {a.byWallet.map((w: any) => (
                      <tr key={w.walletId}>
                        <th scope="row">{w.walletName}<div className="muted small">{w.networkName}</div></th>
                        <td className="num" data-label="보유 수량">{amount(w.total, a.assetCode)}</td>
                        <td className="num strong" data-label="사용 가능">{amount(w.available, a.assetCode)}</td>
                        <td className={`num ${w.reserved === '0' ? 'muted' : ''}`} data-label="예약">{amount(w.reserved, a.assetCode)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        </>
      )}
      <p className="muted small">평가액은 모의 시세 × 보유 수량을 원 단위로 내림한 참고값입니다. 수량은 자산별 최소 단위까지 정확하게 표시합니다.</p>
    </div>
  );
}