import { ErrorState, Loading, PageHeader, Term } from '../components/ui.tsx';
import { useCatalog } from '../hooks.ts';
import { GLOSSARY } from '../../shared/terms.ts';

export function TokensPage() {
  const cat = useCatalog();
  if (cat.isPending) return <Loading />;
  if (cat.error) return <ErrorState error={cat.error} onRetry={() => cat.refetch()} />;
  const { assets, networks, pairs } = cat.data;
  return (
    <div className="page">
      <PageHeader title="지원 자산·네트워크" description="이 환경에서 다룰 수 있는 자산과 네트워크 조합입니다. 같은 자산이 여러 네트워크에 있으면 주소 등록과 출금 때 네트워크를 꼭 맞춰야 합니다." />
      <p className="page-desc">{GLOSSARY.token}</p>
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">지원 자산과 네트워크</caption>
          <thead><tr><th scope="col">자산</th><th scope="col"><Term label="네트워크">{GLOSSARY.network}</Term></th><th scope="col" className="num">소수점 자릿수</th><th scope="col"><Term label="메모/태그">{GLOSSARY.memo}</Term></th><th scope="col">주소 형식 (개발용)</th></tr></thead>
          <tbody>
            {assets.map((a) => {
              const nets = pairs.filter((p) => p.assetCode === a.code).map((p) => networks.find((n) => n.code === p.networkCode)!);
              return nets.map((n, i) => (
                <tr key={a.code + n.code} className={i === 0 ? 'group-start' : ''}>
                  {i === 0 && <th scope="rowgroup" rowSpan={nets.length}><span className="asset-code">{a.code}</span><div className="muted small">{a.name}{nets.length > 1 && ` · ${nets.length}개 네트워크`}</div></th>}
                  <td>{n.name}</td>
                  {i === 0 && <td className="num" rowSpan={nets.length}>{a.precision}</td>}
                  <td>{n.memoRequired ? <b>{n.memoLabel} 필요</b> : <span className="muted">쓰지 않음</span>}</td>
                  <td className="small">{n.family === 'MOCK_EVM' ? 'EVM 계열 — Ethereum·Kaia가 같은 형식' : n.family === 'MOCK_BTC' ? 'Bitcoin 형식' : 'XRP Ledger 형식'}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">목록은 모의 설정입니다. 실제 KODA 지원 자산·네트워크 목록이 아닙니다.</p>
    </div>
  );
}