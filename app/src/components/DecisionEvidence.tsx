import { Fragment } from 'react';
import { decisionEvidenceParts, EVIDENCE_HASH_PATTERN, type DecisionEvidenceView } from '../../shared/terms.ts';

/** 조각 글 안의 승인 대상 지문(4자 네 묶음)만 고정폭·한 줄로 감싼다. 결정 카드의 지문과 같은 모양으로 맞춰 보게 한다(글자는 CSV와 같다). */
function withHash(text: string) {
  return text.split(EVIDENCE_HASH_PATTERN).map((s, i) => (i % 2 === 1 ? <span key={i} className="mono nowrap">{s}</span> : s));
}

/**
 * 승인·반려 기록 아래의 결정 근거 한 줄(A2-3). 감사 CSV와 같은 문구(shared/terms.ts decisionEvidenceParts)를 쓴다.
 * 흐린 글자로 두고, 지금 요청의 지문과 다르면 위험 색, 역할 변경 기록상 승인 권한이 없으면 경고 줄을 따로 보인다.
 * showRoles: 결정 당시 역할을 쓸지(감사 기록 조회 권한이 있는 조회자). 서버도 그 권한이 없으면 역할을 보내지 않는다.
 */
export function DecisionEvidenceLine({ evidence, showRoles }: { evidence: DecisionEvidenceView; showRoles: boolean }) {
  const parts = decisionEvidenceParts(evidence, { showRoles });
  const line = parts.filter((p) => p.tone !== 'warning');
  const warn = parts.filter((p) => p.tone === 'warning');
  return (
    <div className="evidence">
      <span className="evidence-line">
        {line.map((p, i) => (
          <Fragment key={i}>{i > 0 && ' · '}<span className={p.tone === 'danger' ? 'evidence-danger' : undefined}>{withHash(p.text)}</span></Fragment>
        ))}
      </span>
      {warn.map((p, i) => <span key={i} className="evidence-warn">{p.text}</span>)}
    </div>
  );
}
