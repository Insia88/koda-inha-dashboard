import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, newIdemKey } from '../api.ts';
import { ApiErrorNotice, PageHeader } from '../components/ui.tsx';
import { RequestForm, type RequestFormValue } from '../components/RequestForm.tsx';
import { useFocusFirstError } from '../lib/forms.ts';
import { useUnsavedGuard } from '../lib/unsaved.tsx';

const EMPTY: RequestFormValue = { assetCode: '', networkCode: '', addressId: '', amount: '', purpose: '' };

export function RequestNewPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [v, setV] = useState<RequestFormValue>(EMPTY);
  const formRef = useRef<HTMLFormElement>(null);
  // 같은 작성 화면에서 다시 누르거나 응답이 끊겨 재시도해도 요청이 하나만 만들어지도록 키를 유지한다.
  const idem = useRef(newIdemKey());
  const dirty = JSON.stringify(v) !== JSON.stringify(EMPTY);
  const guard = useUnsavedGuard(dirty);
  const m = useMutation({
    mutationFn: () => api('/api/requests', { method: 'POST', body: v, idempotencyKey: idem.current }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['requests'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      guard.allowNavigation();
      nav(`/requests/${r.id}`, { replace: true, state: { created: true } });
    },
  });
  useFocusFirstError(formRef, m.error);
  return (
    <div className="page page-narrow">
      <PageHeader title="출금 요청 작성" eyebrow={<Link to="/requests">← 결재 및 요청</Link>} description="먼저 초안으로 저장합니다. 다음 화면에서 내용을 검토하고 승인 요청을 보냅니다." />
      <form ref={formRef} className="form" noValidate onSubmit={(e) => { e.preventDefault(); if (!m.isPending) m.mutate(); }}>
        <RequestForm value={v} onChange={(nv) => { setV(nv); idem.current = newIdemKey(); }} error={m.error} />
        <ApiErrorNotice error={m.error} />
        <div className="form-actions">
          <Link to="/requests" className="btn">취소</Link>
          <button className="btn btn-primary" type="submit" disabled={m.isPending}>{m.isPending ? '저장 중…' : '초안 저장 후 검토하기'}</button>
        </div>
      </form>
      {guard.guardDialog}
    </div>
  );
}
