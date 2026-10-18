import { forwardRef, useEffect, useRef, type InputHTMLAttributes } from 'react';
import { SEARCH_DEBOUNCE_MS } from './SearchField.tsx';

/**
 * 날짜 입력(owner, native <input type="date">). 값은 `YYYY-MM-DD` 문자열(시간대 변환 없음).
 * React가 제어 값(value 속성)을 매 입력마다 다시 쓰면 Chrome의 연·월·일 칸 입력 상태가 초기화되어
 * 두 자리 일(예: 15)을 입력할 수 없으므로, DOM 값은 사용자가 소유하고 외부 값이 바뀐 때만 맞춘다.
 * commit: 'debounce'(목록 필터, 300ms 뒤 확정·blur/Enter 즉시) | 'immediate'(폼 필드).
 */
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'type'> & {
  value: string;
  onValueChange: (v: string) => void;
  commit?: 'debounce' | 'immediate';
};

export const DateInput = forwardRef<HTMLInputElement, Props>(function DateInput({ value, onValueChange, commit = 'immediate', onBlur, onKeyDown, ...rest }, fwd) {
  const el = useRef<HTMLInputElement | null>(null);
  const initial = useRef(value);
  const last = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    last.current = value;
    if (el.current && el.current.value !== value) el.current.value = value;
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const flush = () => {
    clearTimeout(timer.current);
    const v = el.current?.value ?? '';
    if (v !== last.current) { last.current = v; onValueChange(v); }
  };

  return (
    <input
      {...rest}
      ref={(node) => { el.current = node; if (typeof fwd === 'function') fwd(node); else if (fwd) fwd.current = node; }}
      type="date"
      defaultValue={initial.current}
      onChange={() => {
        if (commit === 'immediate') return flush();
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, SEARCH_DEBOUNCE_MS);
      }}
      onBlur={(e) => { flush(); onBlur?.(e); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); flush(); } onKeyDown?.(e); }}
    />
  );
});
