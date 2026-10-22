import { useEffect, type RefObject } from 'react';
import { ApiError } from '../api.ts';

/**
 * 서버가 필드 오류를 돌려주면 첫 오류 입력(aria-invalid=true)으로 포커스·스크롤한다.
 * 오류 응답 뒤 다시 불러온 내용으로 입력칸이 새로 생기는 경우(예: 제출 때 새로 나온 점검 항목의 사유 칸)가 있어,
 * 바로 찾지 못하면 짧은 시간(약 1초) 동안 프레임마다 다시 찾는다.
 */
export function useFocusFirstError(container: RefObject<HTMLElement | null>, error: unknown) {
  useEffect(() => {
    if (!(error instanceof ApiError) || !error.body.fields?.length) return;
    let frame = 0;
    let id = 0;
    const tryFocus = () => {
      const el = container.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])');
      if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); return; }
      if (++frame < 60) id = requestAnimationFrame(tryFocus);
    };
    id = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(id);
  }, [error, container]);
}
