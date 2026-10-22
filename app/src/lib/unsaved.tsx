import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router';
import { ConfirmDialog } from '../components/Dialog.tsx';

/**
 * 작성 중 데이터 보호(공통 owner).
 * - 인앱 이동: React Router useBlocker → 앱 확인 대화상자(계속 작성이 초기 포커스)
 * - 창 닫기·새로고침: 작성 중일 때만 표준 beforeunload
 * - 저장 성공 직후 이동은 allowNavigation()으로 경고 없이 통과
 * 입력값을 브라우저 저장소에 영구 보관하지 않는다(금융 정보 자동 보관 금지).
 */
let dirtyCount = 0;
let leavingAll = false;
export const hasDirtyForms = () => dirtyCount > 0;
/** 세션 만료 후 사용자가 '작성 내용 버림'을 고른 경우 등 모든 가드를 해제한다. */
export function releaseAllGuards() { leavingAll = true; setTimeout(() => { leavingAll = false; }, 0); }

export function useUnsavedGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const bypass = useRef(false);
  const [localDiscard, setLocalDiscard] = useState<null | (() => void)>(null);

  const blocker = useBlocker(useCallback(({ currentLocation, nextLocation }) =>
    dirtyRef.current && !bypass.current && !leavingAll && currentLocation.pathname !== nextLocation.pathname, []));

  useEffect(() => {
    if (!dirty) return;
    dirtyCount += 1;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => { dirtyCount -= 1; window.removeEventListener('beforeunload', onBeforeUnload); };
  }, [dirty]);

  const open = blocker.state === 'blocked' || localDiscard !== null;
  const dialog = (
    <ConfirmDialog
      open={open}
      intent="caution"
      title="작성 중인 내용이 있습니다"
      confirmLabel="작성 내용 버리기"
      cancelLabel="계속 작성"
      onCancel={() => { if (blocker.state === 'blocked') blocker.reset(); setLocalDiscard(null); }}
      onConfirm={() => {
        if (blocker.state === 'blocked') blocker.proceed();
        if (localDiscard) { const fn = localDiscard; setLocalDiscard(null); fn(); }
      }}
    >
      저장하지 않은 입력은 사라집니다. 이 화면에 머물려면 「계속 작성」을 누르세요.
    </ConfirmDialog>
  );

  return {
    guardDialog: dialog,
    /** 저장 성공 직후 이동 등 경고가 필요 없는 이동 직전에 호출 */
    allowNavigation: () => { bypass.current = true; },
    /** 같은 화면 안의 '수정 취소' 같은 명시적 버림: 작성 중이면 확인 후 실행 */
    confirmDiscard: (fn: () => void) => { if (dirtyRef.current) setLocalDiscard(() => fn); else fn(); },
  };
}
