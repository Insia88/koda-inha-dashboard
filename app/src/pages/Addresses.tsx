import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useMe } from '../auth.tsx';
import { useCatalog, useUrlState } from '../hooks.ts';
import { AddressStrip, Badge, Empty, ErrorState, Loading, Notice, PageHeader } from '../components/ui.tsx';
import { SearchField } from '../components/SearchField.tsx';
import { Faq } from '../components/Faq.tsx';
import { date, dateTime } from '../format.ts';
import { ADDRESS_STATUS, type AddressStatus } from '../../shared/terms.ts';
import { CONFIRM_MIDDLE_LENGTH, type Finding } from '../../shared/address-rules.ts';
import { cooldownText, timeLeft, useAddressPolicy, useNow } from './AddressDetail.tsx';
import '../components/address-lifecycle.css';

/**
 * 보낼 곳 주소록의 짧은 자주 묻는 질문(A1). 사용 대기 시간은 조직 정책(/api/org/policy, 설계 가정)에서, 끝자리 길이는 로그인 정보에서 가져온다.
 * 대기 시간이 0이면 사용 대기 단계를 빼고 설명한다. 주소가 안전하다는 표현을 쓰지 않는다(DASH-003).
 * '사용 가능'의 뜻은 위의 중요 고지(본문 크기, 접지 않음)가 그대로 맡고, 여기서는 다시 풀어 쓸 뿐이다.
 */
function addressFaq(cooldownHours: number | undefined, tail: number) {
  const steps = cooldownHours === 0
    ? '등록 → 등록자가 아닌 승인자의 확인 → 사용 가능 순서입니다.'
    : `등록 → 등록자가 아닌 승인자의 확인 → 사용 대기 ${cooldownText(cooldownHours)}(설계 가정) → 사용 가능 순서입니다.`;
  return [
    { q: '보낼 곳 주소록과 우리 회사 입금 주소는 무엇이 다른가요?', a: '주소록은 우리 회사가 출금할 때 받는 곳의 주소입니다. 우리 회사가 입금받을 주소는 참고 메뉴의 우리 회사 입금 주소 화면에 있습니다.' },
    { q: '새 주소는 언제부터 출금에 쓸 수 있나요?', a: `${steps} 사용 가능이 되어야 출금 요청의 받는 주소로 고를 수 있습니다.` },
    { q: '주소 일부를 왜 다시 입력하나요?', a: `앞·뒤만 같게 만든 가짜 주소를 가려내기 위해서입니다. 받는 곳이 보낸 원본을 보고 끝 ${tail}자리와 가운데 ${CONFIRM_MIDDLE_LENGTH}자리를 직접 입력하세요. 화면의 글자를 옮겨 치면 이 확인이 소용없습니다.` },
    { q: "'사용 가능'이면 확인이 다 끝난 주소인가요?", a: '두 사람이 입력 내용을 대조했다는 기록일 뿐, 주소의 주인을 확인한 것은 아닙니다. 보내기 전에 받는 곳과 다른 연락 수단으로 주소를 대조하세요.' },
    { q: '모르는 주소가 사용 대기 중이면요?', a: '주소를 열어 「사용 대기 중 정지」로 바로 정지하세요. 주소 등록·확인 담당자와 조직 관리자가 정지할 수 있고, 사유는 감사 기록에 남습니다.' },
    { q: '확인을 부탁하면 승인자에게 알림이 가나요?', a: '아니요. 이 대시보드는 알림을 보내지 않습니다. 확인할 승인자에게 직접 알려 주세요.' },
  ];
}

/** 목록 조회가 한 번에 돌려주는 최대 건수(서버와 같은 값). 넘으면 잘린 사실을 알린다. */
const ADDRESS_LIST_LIMIT = 500;

/**
 * 목록의 '비슷한 주소 있음' 표시 설명. 등록·확인 때 서버가 저장한 점검 결과에 유사 주소(주소록) 또는
 * 최근 0원·소액 입금을 보낸 주소와 비슷하다는 결과가 있으면, 무엇과 비슷한지 한 문장씩 돌려준다. 없으면 null.
 * 목록의 주소는 앞·뒤 묶음만 보이므로(가운데 생략) 흉내 낸 주소와 원래 주소가 똑같아 보인다. 이 표시로 구별하게 한다.
 */
export function lookalikeNote(findings: Finding[] | undefined): string | null {
  const parts: string[] = [];
  const top = (findings ?? []).find((f) => f.code === 'ADDRESS_LOOKALIKE')?.data?.matches?.[0];
  if (top) parts.push(`기존 주소 '${top.label}'와 앞 ${top.prefix}자·뒤 ${top.suffix}자가 같고 가운데가 다릅니다.`);
  if ((findings ?? []).some((f) => f.code === 'ADDRESS_POISON_LOOKALIKE')) parts.push('최근 0원·소액 입금을 보낸 주소와 앞·뒤가 같고 가운데가 다릅니다.');
  return parts.length ? `${parts.join(' ')} 주소를 열어 가운데를 포함한 전체 글자를 비교하세요.` : null;
}

/**
 * 목록의 '0원·소액 입금 주소와 같음' 표시 설명. 저장된 점검 결과에 최근 0원·소액 입금을 보낸 주소와 같다는 결과
 * (ADDRESS_POISON_SUSPECTED, 확인 때 찾아 저장한 결과)가 있으면 한 문장을 돌려준다. 없으면 null.
 * 유사 주소 표시보다 강한 신호라 그 앞에 둔다. 서버가 확인할 때마다 다시 점검해 거부하므로 이 주소는 거절만 할 수 있다.
 */
export function poisonNote(findings: Finding[] | undefined): string | null {
  return (findings ?? []).some((f) => f.code === 'ADDRESS_POISON_SUSPECTED')
    ? '최근 0원·소액 입금을 보낸 주소와 같습니다. 주소 오염 공격에서 자주 보이는 패턴이라 이 주소는 확인할 수 없습니다.'
    : null;
}

export function AddressesPage() {
  const me = useMe();
  const cat = useCatalog();
  const { state, set, qs } = useUrlState({ q: '', status: '', assetCode: '', networkCode: '', sort: 'status' });
  const q = useQuery({ queryKey: ['addresses', qs], queryFn: ({ signal }) => api(`/api/addresses?${new URLSearchParams(Object.entries(state).filter(([, v]) => v)).toString()}`, { signal }), placeholderData: (p) => p });
  const filtered = !!(state.q || state.status || state.assetCode || state.networkCode);
  const now = useNow();
  const policy = useAddressPolicy();

  return (
    <div className="page">
      <PageHeader
        title="보낼 곳 주소록"
        description="우리 회사가 출금할 때 받는 곳의 주소입니다. 등록자와 다른 담당자가 확인해야 출금 요청에 쓸 수 있습니다."
        actions={me.permissions.includes('address.create') && <Link className="btn btn-primary" to="/addresses/new"><IconPlus size={16} aria-hidden="true" />주소 등록</Link>}
      />
      <Notice tone="info" title="주소록의 '사용 가능'은 주소가 안전하다는 뜻이 아닙니다">
        두 사람이 입력 내용을 확인했다는 기록입니다. 블록체인 전송은 되돌릴 수 없으니 받는 곳과 별도 연락 수단으로 주소를 대조하세요.
      </Notice>
      {state.status === 'COOLING_DOWN' && (
        <Notice tone="warning" title="사용 대기 중인 주소입니다">
          두 사람의 확인을 마쳤지만 대기 시간이 지나야 출금 요청에 쓸 수 있습니다. 등록을 요청한 적이 없거나 받는 곳에서 확인되지 않은 주소가 있으면 주소를 열어 대기 중에 정지하세요.
        </Notice>
      )}
      {/* 정책을 아직 못 받았으면 '기본 24시간'(설계 가정)으로 설명한다(주소 등록·상세 화면과 같은 표기). */}
      <Faq items={addressFaq(policy.data?.addressBook?.cooldownHours, me.policy.confirmTailLength)} />
      <form className="toolbar" role="search" noValidate onSubmit={(e) => e.preventDefault()}>
        <SearchField label="주소 검색" placeholder="이름·받는 곳·주소 일부로 검색" value={state.q} onCommit={(v) => set({ q: v })} />
        <label><span className="sr-only">상태</span>
          <select value={state.status} onChange={(e) => set({ status: e.target.value })}>
            <option value="">모든 상태</option>
            {Object.entries(ADDRESS_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label><span className="sr-only">자산</span>
          <select value={state.assetCode} onChange={(e) => set({ assetCode: e.target.value })}>
            <option value="">모든 자산</option>
            {cat.data?.assets.map((a) => <option key={a.code} value={a.code}>{a.code}</option>)}
          </select>
        </label>
        <label><span className="sr-only">네트워크</span>
          <select value={state.networkCode} onChange={(e) => set({ networkCode: e.target.value })}>
            <option value="">모든 네트워크</option>
            {cat.data?.networks.map((n) => <option key={n.code} value={n.code}>{n.name}</option>)}
          </select>
        </label>
        <label><span className="sr-only">정렬</span>
          <select value={state.sort} onChange={(e) => set({ sort: e.target.value })}>
            <option value="status">확인 필요 먼저</option>
            <option value="recent">최근 등록순</option>
            <option value="label">이름순</option>
          </select>
        </label>
        {filtered && <button type="button" className="btn btn-ghost" onClick={() => set({ q: '', status: '', assetCode: '', networkCode: '' })}>필터 초기화</button>}
      </form>

      {q.isPending ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <p className="result-count" aria-live="polite">{filtered ? `조건에 맞는 주소 ${q.data.items.length}개 (전체 ${q.data.totalInOrg}개)` : `전체 ${q.data.totalInOrg}개`}</p>
          {q.data.items.length >= ADDRESS_LIST_LIMIT && q.data.totalInOrg > ADDRESS_LIST_LIMIT && (
            <Notice tone="warning" title={`주소를 ${ADDRESS_LIST_LIMIT}개까지만 표시합니다`}>
              선택한 정렬 순서로 처음 {ADDRESS_LIST_LIMIT}개만 보입니다. 나머지 주소는 검색이나 필터로 좁혀 찾으세요.
            </Notice>
          )}
          {q.data.items.length === 0 ? (
            filtered ? <Empty title="조건에 맞는 주소가 없습니다" action={<button className="btn" onClick={() => set({ q: '', status: '', assetCode: '', networkCode: '' })}>필터 초기화</button>}>검색어나 필터를 바꿔 보세요.</Empty>
              : <Empty title="등록된 주소가 없습니다" action={me.permissions.includes('address.create') ? <Link className="btn btn-primary" to="/addresses/new">첫 주소 등록</Link> : undefined}>출금하려면 받는 곳 주소를 먼저 등록하고 다른 담당자의 확인을 받아야 합니다.</Empty>
          ) : (
            <div className="table-wrap">
              {/* 좁은 화면(≤560px)에서는 주소마다 카드로 쌓이고, 상태 배지는 이름 옆 첫 줄에 둔다. */}
              <table className="table table-stack adr-table">
                <caption className="sr-only">주소록 목록</caption>
                <thead><tr><th scope="col">이름 · 받는 곳</th><th scope="col">자산 / 네트워크</th><th scope="col">주소</th><th scope="col">상태</th><th scope="col">등록</th></tr></thead>
                <tbody>
                  {q.data.items.map((a: any) => {
                    const st = ADDRESS_STATUS[a.status as AddressStatus];
                    const look = lookalikeNote(a.findings);
                    const poison = poisonNote(a.findings);
                    return (
                      <tr key={a.id}>
                        <th scope="row" className="cell-wrap adr-name">
                          <Link to={`/addresses/${a.id}`} state={{ back: `/addresses?${qs}` }} className="row-link">{a.label}</Link>
                          <div className="muted small">{a.counterparty}</div>
                        </th>
                        <td className="adr-asset" data-label="자산 / 네트워크"><span className="asset-code">{a.assetCode}</span> / {a.networkName}</td>
                        <td className="adr-addr" data-label="주소"><AddressStrip address={a.address} memo={a.memo} compact /></td>
                        <td className="adr-status">
                          <Badge tone={st.tone} title={st.description}>{st.label}</Badge>
                          {/* 상태 배지는 행마다 하나로 둔다. 주소 오염 의심·유사 주소 표시는 '내 확인 필요'처럼 배지 아래 한 줄(위험 색)로 보인다. */}
                          {poison && (
                            <div className="small action-hint adr-poison" style={{ color: 'var(--danger)' }} title={poison}>
                              <IconAlertTriangle size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 2 }} />0원·소액 입금 주소와 같음<span className="sr-only">: {poison}</span>
                            </div>
                          )}
                          {look && (
                            <div className="small action-hint adr-lookalike" style={{ color: 'var(--danger)' }} title={look}>
                              <IconAlertTriangle size={14} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 2 }} />비슷한 주소 있음<span className="sr-only">: {look}</span>
                            </div>
                          )}
                          {a.allowedActions.includes('review') && <div className="small action-hint">내 확인 필요</div>}
                          {a.status === 'COOLING_DOWN' && a.activeFrom && (
                            <div className="small lc-list-when">
                              <span>{dateTime(a.activeFrom)}부터</span> <span>({Date.parse(a.activeFrom) <= now ? '곧 사용 가능' : `${timeLeft(a.activeFrom, now)} 남음`})</span>
                            </div>
                          )}
                        </td>
                        <td className="nowrap small adr-created" data-label="등록">{date(a.createdAt)}<div className="muted">{a.createdBy.name}</div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">주소록은 조직당 수십 개 규모를 가정해 페이지를 나누지 않고 한 화면에 보여 줍니다. 검색과 필터로 좁혀 보세요.</p>
        </>
      )}
    </div>
  );
}