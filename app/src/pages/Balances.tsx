import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { AmountText, DataStamp, Empty, ErrorState, Loading, PageHeader, Term } from '../components/ui.tsx';
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
      <PageHeader title="잔고" description="자산별 보유 수량과, 승인 대기·처리 중인 출금 요청에 묶인 수량(예약)을 지갑·네트워크별로 보여 줍니다." />
      <section className="card">
        <div className="total total-row">
          <div>
            <div className="total-label"><Term label="총 평가액">{GLOSSARY.valuation}</Term></div><div className="total-value"><AmountText text={krwShort(h.totalKrw)} /></div><div className="total-exact muted">{krw(h.totalKrw)}</div>
            {/* 합계를 보는 자리에서 스테이킹이 들어가는지 묻게 되므로 바로 아래에 짧게 쓴다(긴 설명은 화면 아래 그대로). */}
            <p className="muted small total-staking-note">스테이킹 현황의 맡긴 수량·보상은 이 합계에 넣지 않았습니다(모의 데이터).</p>
          </div>
          <div className="stamps"><DataStamp asOf={h.price.asOf} state={h.price.state} source={h.price.source} label="시세 기준" /><span className="stamp">잔고 기준 {dateTime(h.balanceAsOf)} KST</span></div>
        </div>
        {h.assets.length > 0 && <AllocationBar items={h.assets.map((a: any) => ({ key: a.assetCode, label: a.assetCode, value: a.krwValue ?? '0' }))} caption="자산별 평가액 비중 (모의 시세 기준)" />}
      </section>
      {h.assets.length === 0 ? <Empty title="보유 자산이 없습니다">입금 주소는 우리 회사 입금 주소 화면에서 확인할 수 있습니다.</Empty> : (
        <>
          {/* 넓은 화면: 자산·지갑 표. 좁은 화면(≤560px)에서는 숨기고 아래 자산별 덩어리를 보인다. */}
          <div className="table-wrap bal-wide">
            <table className="table">
              <caption className="sr-only">자산·지갑별 잔고</caption>
              <thead><tr><th scope="col">자산</th><th scope="col">지갑 / 네트워크</th><th scope="col" className="num">보유 수량</th><th scope="col" className="num"><Term label="묶인 수량(예약)">{GLOSSARY.reserved}</Term></th><th scope="col" className="num"><Term label="사용 가능">{GLOSSARY.available}</Term></th><th scope="col" className="num">모의 시세 (원)</th><th scope="col" className="num">평가액</th></tr></thead>
              <tbody>
                {h.assets.flatMap((a: any) => a.byWallet.map((w: any, i: number) => (
                  <tr key={a.assetCode + w.walletId} className={i === 0 ? 'group-start' : ''}>
                    {i === 0 && <th scope="rowgroup" rowSpan={a.byWallet.length}><span className="asset-code">{a.assetCode}</span><div className="muted small">{a.name}</div></th>}
                    <td>{w.walletName}<div className="muted small">{w.networkName}</div></td>
                    <td className="num qty"><AmountText text={amount(w.total, a.assetCode)} /></td>
                    <td className={`num qty ${w.reserved === '0' ? 'muted' : ''}`}><AmountText text={amount(w.reserved, a.assetCode)} /></td>
                    <td className="num qty strong"><AmountText text={amount(w.available, a.assetCode)} /></td>
                    {i === 0 && <td className="num" rowSpan={a.byWallet.length}>{krw(a.krwPrice)}</td>}
                    {i === 0 && <td className="num" rowSpan={a.byWallet.length}>{krwShort(a.krwValue)}<div className="muted small">{krw(a.krwValue)}</div></td>}
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          <div className="bal-blocks">
            {/* 좁은 화면에서는 넓은 표의 머리글 용어 설명(Term)이 보이지 않으므로, 같은 설명을 덩어리 위에 펼쳐 둔다. */}
            <dl className="bal-legend small">
              <div><dt>사용 가능</dt><dd>{GLOSSARY.available}</dd></div>
              <div><dt>묶인 수량(예약)</dt><dd>{GLOSSARY.reserved}</dd></div>
            </dl>
            {h.assets.map((a: any) => (
              <section key={a.assetCode} className="card" aria-labelledby={`bal-${a.assetCode}`}>
                <div className="bal-head">
                  <h2 id={`bal-${a.assetCode}`}><span className="asset-code">{a.assetCode}</span><span className="muted small">{a.name}</span></h2>
                  <div className="bal-value"><strong><AmountText text={krwShort(a.krwValue)} /></strong><div className="muted small">{krw(a.krwValue)}</div></div>
                </div>
                <p className="muted small bal-price">모의 시세 1 {a.assetCode} = {krw(a.krwPrice)}</p>
                <table className="table table-compact table-stack">
                  <caption className="sr-only">{a.assetCode} 지갑별 잔고</caption>
                  <thead><tr><th scope="col">지갑 / 네트워크</th><th scope="col" className="num">보유 수량</th><th scope="col" className="num">사용 가능</th><th scope="col" className="num">묶인 수량(예약)</th></tr></thead>
                  <tbody>
                    {a.byWallet.map((w: any) => (
                      <tr key={w.walletId}>
                        <th scope="row">{w.walletName}<div className="muted small">{w.networkName}</div></th>
                        <td className="num qty" data-label="보유 수량"><AmountText text={amount(w.total, a.assetCode)} /></td>
                        <td className="num qty strong" data-label="사용 가능"><AmountText text={amount(w.available, a.assetCode)} /></td>
                        <td className={`num qty ${w.reserved === '0' ? 'muted' : ''}`} data-label="묶인 수량(예약)"><AmountText text={amount(w.reserved, a.assetCode)} /></td>
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
      {/* 스테이킹과 총 평가액의 관계(A1): 스테이킹 현황의 수량을 여기에 더하지 않는다는 점을 숨기지 않는다. */}
      <p className="muted small bal-staking-note">총 평가액은 지갑 보유 수량으로만 계산하며, 스테이킹 현황의 맡긴 수량과 보상은 따로 더하지 않습니다. 맡긴 자산이 지갑 보유 수량에 들어 있는지는 KODA 자료로 확인해야 합니다(모의 데이터).</p>
    </div>
  );
}