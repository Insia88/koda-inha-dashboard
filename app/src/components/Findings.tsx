import { Notice } from './ui.tsx';
import type { Finding } from '../../shared/address-rules.ts';

const TONE = { error: 'danger', warning: 'warning', info: 'info' } as const;

export function Findings({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null;
  return (
    <div className="findings" aria-live="polite">
      {findings.map((f) => (
        <Notice key={f.code} tone={TONE[f.level]} title={f.message}>{f.action}</Notice>
      ))}
    </div>
  );
}