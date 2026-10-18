import { useEffect, type RefObject } from 'react';
import { ApiError } from '../api.ts';

/** 서버가 필드 오류를 돌려주면 첫 오류 입력(aria-invalid=true)으로 포커스·스크롤한다. */
export function useFocusFirstError(container: RefObject<HTMLElement | null>, error: unknown) {
  useEffect(() => {
    if (!(error instanceof ApiError) || !error.body.fields?.length) return;
    const id = requestAnimationFrame(() => {
      const el = container.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])');
      if (el) { el.focus(); el.scrollIntoView({ block: 'center' }); }
    });
    return () => cancelAnimationFrame(id);
  }, [error, container]);
}
