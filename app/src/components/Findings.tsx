import { Notice } from './ui.tsx';
import type { Finding } from '../../shared/address-rules.ts';

const TONE = { error: 'danger', warning: 'warning', info: 'info' } as const;

/**
 * 주소 점검 결과. 알림 영역(aria-live)은 결과가 없을 때도 빈 채로 그려 두고 내용만 바꾼다(A3, WCAG 4.1.3).
 * 첫 결과와 함께 새로 생긴 알림 영역은 화면 낭독기가 첫 안내를 놓치기 쉽다. 비어 있는 동안은 자리를 차지하지 않는다(.live-slot:empty).
 */
export function Findings({ findings }: { findings: Finding[] }) {
  return (
    <div className="findings live-slot" aria-live="polite">
      {findings.map((f) => (
        <Notice key={f.code} tone={TONE[f.level]} title={f.message}>{f.action}</Notice>
      ))}
    </div>
  );
}