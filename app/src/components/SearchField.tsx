import { useEffect, useId, useRef, useState } from 'react';
import { IconSearch, IconX } from '@tabler/icons-react';

/** 검색 입력 확정 지연(ms). 화면별로 바꾸지 않는다. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * 공통 검색 입력(owner).
 * - 입력은 즉시 화면에 반영, 원격 조회용 값은 300ms 뒤 확정
 * - 한국어 IME 조합 중에는 확정하지 않음(조합 완료 후 지연 확정), 조합 중 Enter는 무시
 * - Enter·지우기는 즉시 확정. 지우기 후 입력에 포커스 복귀. Escape도 지우기
 * - URL 등 외부 값이 바뀌면(뒤로 가기·필터 초기화) 입력도 맞춘다
 * 이전 조회의 결과가 늦게 와도 화면은 TanStack Query 키(현재 검색어)의 데이터만 표시하고, 관찰자가 없어진 조회는 AbortSignal로 취소된다.
 */
export function SearchField({ value, onCommit, label, placeholder, maxLength = 100, icon = true, className = '', clearLabel = '검색어 지우기' }: {
  value: string; onCommit: (v: string) => void; label: string; placeholder?: string; maxLength?: number; icon?: boolean; className?: string; clearLabel?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const committed = useRef(value);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (value !== committed.current) { committed.current = value; setText(value); clearTimeout(timer.current); }
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const commit = (raw: string) => {
    clearTimeout(timer.current);
    const v = raw.trim();
    if (v === committed.current) return;
    committed.current = v;
    onCommit(v);
  };
  const schedule = (raw: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(raw), SEARCH_DEBOUNCE_MS);
  };
  const clear = () => { setText(''); commit(''); input.current?.focus(); };

  return (
    <div className={`search ${icon ? '' : 'search-noicon'} ${className}`}>
      {icon && <IconSearch size={16} aria-hidden="true" />}
      <label htmlFor={id} className="sr-only">{label}</label>
      <input
        ref={input}
        id={id}
        type="search"
        value={text}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete="off"
        enterKeyHint="search"
        onChange={(e) => {
          setText(e.target.value);
          if (composing.current || (e.nativeEvent as InputEvent).isComposing) { clearTimeout(timer.current); return; }
          schedule(e.target.value);
        }}
        onCompositionStart={() => { composing.current = true; clearTimeout(timer.current); }}
        onCompositionEnd={(e) => { composing.current = false; schedule(e.currentTarget.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
            commit(e.currentTarget.value);
          } else if (e.key === 'Escape' && text) {
            e.preventDefault();
            clear();
          }
        }}
      />
      {text && (
        <button type="button" className="search-clear" aria-label={clearLabel} onClick={clear}>
          <IconX size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
