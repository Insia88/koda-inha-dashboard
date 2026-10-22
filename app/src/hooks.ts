import { useLocation, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';

/** 경로 비교용. 주소창의 경로는 한글 등이 퍼센트 인코딩되어 있을 수 있어 풀어서 비교한다(풀 수 없으면 그대로). */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try { return decodeURI(a) === decodeURI(b); } catch { return false; }
}

/** 목록 필터·페이지 상태를 URL에 보관해 새로고침·상세 화면 복귀 후에도 유지한다. */
export function useUrlState<T extends Record<string, string>>(defaults: T) {
  const [sp, setSp] = useSearchParams();
  // 이 화면을 그린 경로. 다른 화면으로 이동하는 중에는 주소창(window.location)이 이미 다음 경로로 바뀌어 있다.
  const renderedPath = useLocation().pathname;
  const state = Object.fromEntries(Object.keys(defaults).map((k) => [k, sp.get(k) ?? defaults[k]])) as T;
  const set = (patch: Partial<T>, opts: { resetPage?: boolean } = { resetPage: true }) => {
    // 화면 전환은 transition으로 그려지므로, 링크를 누른 직후 주소창은 이미 다음 화면인데 떠나는 화면(목록)은 잠시 남아 입력을 받는다.
    // 그 사이의 필터·검색 변경은 버린다. 그대로 쓰면 다음 화면 주소에 붙어(예: /addresses/new?assetCode=USDC) 다음 화면이 엉뚱한 값을 받는다.
    if (!samePath(window.location.pathname, renderedPath)) return;
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '' || v === defaults[k]) next.delete(k); else next.set(k, String(v));
    }
    if (opts.resetPage && !('page' in patch)) next.delete('page');
    setSp(next, { replace: true });
  };
  const qs = sp.toString();
  return { state, set, qs };
}

export interface Catalog {
  assets: { code: string; name: string; precision: number }[];
  networks: { code: string; name: string; family: string; memoRequired: boolean; memoLabel: string | null; memoHint: string | null }[];
  pairs: { assetCode: string; networkCode: string }[];
}

export function useCatalog() {
  return useQuery({ queryKey: ['catalog'], queryFn: () => api<Catalog>('/api/catalog'), staleTime: 5 * 60_000 });
}