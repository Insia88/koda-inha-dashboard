// 자산별 평가액 비중 막대. 원 단위 정수(bigint)로 비율을 계산하고, 표시만 소수 한 자리로 반올림한다.
const COLORS = ['#0B5D46', '#2E7D9A', '#7A5BA8', '#B4762B', '#5F6B66', '#A23B5A'];

export function AllocationBar({ items, caption }: { items: { key: string; label: string; value: string }[]; caption: string }) {
  const total = items.reduce((s, i) => s + BigInt(i.value), 0n);
  if (total === 0n) return null;
  const parts = items.map((i, idx) => ({ ...i, color: COLORS[idx % COLORS.length]!, pct: Number((BigInt(i.value) * 1000n) / total) / 10 }));
  return (
    <figure className="alloc">
      <div className="alloc-bar" role="img" aria-label={`${caption}: ${parts.map((p) => `${p.label} ${p.pct}%`).join(', ')}`}>
        {parts.map((p) => <span key={p.key} style={{ width: `${p.pct}%`, background: p.color }} />)}
      </div>
      <figcaption>
        <span className="sr-only">{caption}</span>
        <ul className="alloc-legend" aria-hidden="true">
          {parts.map((p) => <li key={p.key}><span className="swatch" style={{ background: p.color }} />{p.label} {p.pct}%</li>)}
        </ul>
        <span className="muted small">{caption}</span>
      </figcaption>
    </figure>
  );
}