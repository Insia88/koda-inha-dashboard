import type { Finding } from '../../shared/address-rules.ts';
import { ADDRESS_STATUS, type AddressStatus } from '../../shared/terms.ts';
import './address-compare.css';

/**
 * 두 주소 나란히 비교(유사 주소 경고용). 4자 묶음으로 나누고, 같은 앞·뒤 글자는 흐리게,
 * 가운데에서 다른 글자는 위험 색으로 표시한다. 비교를 돕는 표시일 뿐 어느 쪽 주소도 보증하지 않는다.
 */
function split(address: string): { prefix: string; body: string } {
  const m = address.trim().match(/^(MOCK-[A-Z]+)-(.*)$/i);
  return m ? { prefix: m[1]!, body: m[2]! } : { prefix: '', body: address.trim() };
}

/** 고유부 앞·뒤에서 같은 글자 수(대소문자 무시, 앞·뒤를 겹쳐 세지 않음) */
function commonEnds(x: string, y: string) {
  const a = x.toUpperCase();
  const b = y.toUpperCase();
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

type Mark = 'same' | 'mid' | 'diff';

function marks(body: string, other: string, prefix: number, suffix: number): Mark[] {
  const sameLength = body.length === other.length;
  return [...body].map((ch, i) => {
    if (i < prefix || i >= body.length - suffix) return 'same';
    if (sameLength && ch.toUpperCase() === other[i]!.toUpperCase()) return 'mid';
    return 'diff';
  });
}

function Row({ label, address, body, prefixText, mk }: { label: string; address: string; body: string; prefixText: string; mk: Mark[] }) {
  const chunks: { ch: string; m: Mark }[][] = [];
  [...body].forEach((ch, i) => {
    if (i % 4 === 0) chunks.push([]);
    chunks[chunks.length - 1]!.push({ ch, m: mk[i]! });
  });
  return (
    <div className="cmp-row">
      <div className="cmp-label">{label}</div>
      <div className="cmp-code" aria-hidden="true">
        {prefixText && <span className="cmp-prefix">{prefixText}</span>}
        {chunks.map((c, i) => (
          <span key={i} className="cmp-chunk">
            {c.map((x, j) => <span key={j} className={`cmp-${x.m}`}>{x.ch}</span>)}
          </span>
        ))}
      </div>
      <span className="sr-only">{address}</span>
    </div>
  );
}

export function AddressCompare({ candidate, existing, candidateLabel, existingLabel }: { candidate: string; existing: string; candidateLabel: string; existingLabel: string }) {
  const a = split(candidate);
  const b = split(existing);
  const { prefix, suffix } = commonEnds(a.body, b.body);
  const ma = marks(a.body, b.body, prefix, suffix);
  const mb = marks(b.body, a.body, prefix, suffix);
  const diff = ma.filter((m) => m === 'diff').length;
  const summary = `앞 ${prefix}자·뒤 ${suffix}자 같음 · 가운데 ${diff}자 다름`;
  return (
    <div className="addr-compare" role="group" aria-label={`${candidateLabel}와 ${existingLabel} 비교: ${summary}`}>
      <div className="cmp-legend">
        <span className="cmp-key cmp-key-same">같음</span>
        <span className="cmp-key cmp-key-diff">다름</span>
        <span className="cmp-summary">{summary}</span>
      </div>
      <Row label={candidateLabel} address={candidate.trim()} body={a.body} prefixText={a.prefix} mk={ma} />
      <Row label={existingLabel} address={existing.trim()} body={b.body} prefixText={b.prefix} mk={mb} />
    </div>
  );
}

/** 서버 점검 결과의 유사 주소(ADDRESS_LOOKALIKE) 일치 목록을 하나씩 비교해 보여 준다. 없으면 아무것도 그리지 않는다. */
export function LookalikeComparisons({ address, findings, candidateLabel }: { address: string; findings: Finding[]; candidateLabel: string }) {
  const matches = findings.find((f) => f.code === 'ADDRESS_LOOKALIKE')?.data?.matches ?? [];
  if (!matches.length || !address.trim()) return null;
  return (
    <div className="addr-compare-list">
      <div className="addr-compare-title">비슷한 기존 주소와 글자 비교 ({matches.length}건)</div>
      {matches.map((m) => (
        <AddressCompare
          key={m.id}
          candidate={address}
          existing={m.address}
          candidateLabel={candidateLabel}
          existingLabel={`기존 주소 '${m.label}' (${ADDRESS_STATUS[m.status as AddressStatus]?.label ?? m.status})`}
        />
      ))}
    </div>
  );
}
