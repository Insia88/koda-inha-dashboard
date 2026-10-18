import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';

/** 목록 필터·페이지 상태를 URL에 보관해 새로고침·상세 화면 복귀 후에도 유지한다. */
export function useUrlState<T extends Record<string, string>>(defaults: T) {
  const [sp, setSp] = useSearchParams();
  const state = Object.fromEntries(Object.keys(defaults).map((k) => [k, sp.get(k) ?? defaults[k]])) as T;
  const set = (patch: Partial<T>, opts: { resetPage?: boolean } = { resetPage: true }) => {
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