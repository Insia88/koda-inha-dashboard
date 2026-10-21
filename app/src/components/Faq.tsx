import type { ReactNode } from 'react';

/**
 * 짧은 자주 묻는 질문(A1). 네이티브 <details>라 처음에는 한 줄로 접혀 있고 Enter·Space로 펼친다.
 * 기존 규칙을 다시 설명하는 보조 글이다. 중요 고지(DESIGN.md '고지·환경 표시')는 여기로 옮기지 않고 본문에 그대로 둔다.
 * 답에는 링크를 두지 않는다(메뉴 이름과 같은 링크가 생기지 않게).
 */
export function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  return (
    <details className="faq">
      <summary>자주 묻는 질문</summary>
      <dl className="faq-list">
        {items.map((it) => (
          <div key={it.q} className="faq-item">
            <dt>{it.q}</dt>
            <dd>{it.a}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
