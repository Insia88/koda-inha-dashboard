import { createBrowserRouter, Navigate, Outlet, useRouteError } from 'react-router';
import { AuthGate, useMe } from './auth.tsx';
import { Layout } from './components/Layout.tsx';
import { Loading, Forbidden, useDocumentTitle } from './components/ui.tsx';
import { LoginPage } from './pages/Login.tsx';
import { HomePage } from './pages/Home.tsx';
import { BalancesPage } from './pages/Balances.tsx';
import { ActivityPage } from './pages/Activity.tsx';
import { RequestsPage } from './pages/Requests.tsx';
import { RequestNewPage } from './pages/RequestNew.tsx';
import { RequestDetailPage } from './pages/RequestDetail.tsx';
import { AddressesPage } from './pages/Addresses.tsx';
import { AddressNewPage } from './pages/AddressNew.tsx';
import { AddressDetailPage } from './pages/AddressDetail.tsx';
import { WalletsPage } from './pages/Wallets.tsx';
import { StakingPage } from './pages/Staking.tsx';
import { TokensPage } from './pages/Tokens.tsx';
import { OrgPage } from './pages/Org.tsx';
import { AuditPage } from './pages/Audit.tsx';
import { InsightsPage } from './pages/Insights.tsx';
import { InsightsManagePage } from './pages/InsightsManage.tsx';

function Guard({ perm, children }: { perm: string; children: React.ReactNode }) {
  const me = useMe();
  if (!me.permissions.includes(perm)) return <Forbidden />;
  return <>{children}</>;
}

function Home() {
  const me = useMe();
  if (me.org.kind === 'operator') return <Navigate to="/insights/manage" replace />;
  return <HomePage />;
}

function RouteError() {
  const err = useRouteError() as Error;
  useDocumentTitle('오류');
  return (
    <div className="center-screen" role="alert">
      <h1>화면을 표시하지 못했습니다</h1>
      <p>{err?.message ?? '알 수 없는 오류'}</p>
      <a className="btn btn-primary" href="/">홈으로</a>
    </div>
  );
}

function NotFound() {
  useDocumentTitle('페이지를 찾을 수 없음');
  return (
    <div className="state state-empty">
      <h1 id="page-title" tabIndex={-1}>페이지를 찾을 수 없습니다</h1>
      <span>주소가 바뀌었거나 없는 화면입니다.</span>
      <a className="btn" href="/">홈으로</a>
    </div>
  );
}

const g = (perm: string, el: React.ReactNode) => <Guard perm={perm}>{el}</Guard>;

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  {
    element: <AuthGate fallback={<Loading label="로그인 상태 확인 중" />}><Outlet /></AuthGate>,
    errorElement: <RouteError />,
    children: [{
      element: <Layout />,
      children: [
        { index: true, element: <Home /> },
        { path: 'balances', element: g('asset.read', <BalancesPage />) },
        { path: 'activity', element: g('activity.read', <ActivityPage />) },
        { path: 'requests', element: g('request.read', <RequestsPage />) },
        { path: 'requests/new', element: g('request.create', <RequestNewPage />) },
        { path: 'requests/:id', element: g('request.read', <RequestDetailPage />) },
        { path: 'addresses', element: g('address.read', <AddressesPage />) },
        { path: 'addresses/new', element: g('address.create', <AddressNewPage />) },
        { path: 'addresses/:id', element: g('address.read', <AddressDetailPage />) },
        { path: 'wallets', element: g('wallet.read', <WalletsPage />) },
        { path: 'staking', element: g('staking.read', <StakingPage />) },
        { path: 'tokens', element: g('catalog.read', <TokensPage />) },
        { path: 'org', element: g('org.read', <OrgPage />) },
        { path: 'audit', element: g('audit.read', <AuditPage />) },
        { path: 'insights', element: g('insight.read', <InsightsPage />) },
        { path: 'insights/manage', element: g('insight.manage', <InsightsManagePage />) },
        { path: '*', element: <NotFound /> },
      ],
    }],
  },
]);