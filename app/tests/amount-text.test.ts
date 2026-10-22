import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AmountText } from '../src/components/ui.tsx';
import { amount, krw, krwShort } from '../src/format.ts';

// A4: AmountText는 표시만 나눈다. 화면 낭독기·검사가 읽는 글자(textContent)는 원래 문자열과 한 글자도 다르지 않아야 한다.
const html = (text: string) => renderToStaticMarkup(createElement(AmountText, { text }));
const textOf = (markup: string) => markup.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

describe('AmountText (A4 금액 단위 나누기)', () => {
  const samples = [
    krwShort('5511000000'), // 약 55.11억 원
    krwShort('50000000'), // 약 5,000만 원
    krwShort('9999'), // 9,999원
    krwShort(null), // —
    krw('168000000'), // 168,000,000원
    amount('1250000', 'USDC'),
    amount('0.5', 'BTC'),
    amount('0', 'ETH'),
    amount('1234.56789'),
    amount(null, 'BTC'), // —
    '-1,000 USDC',
  ];

  it('keeps textContent byte-identical to the formatted string', () => {
    for (const s of samples) expect(textOf(html(s)), s).toBe(s);
  });

  it("splits '약', the figure and the unit; spaces stay plain text nodes", () => {
    expect(html('약 55.11억 원')).toBe('<span class="amt-u">약</span> <span class="amt-n">55.11</span><span class="amt-u">억 원</span>');
    expect(html('1,250,000 USDC')).toBe('<span class="amt-n">1,250,000</span> <span class="amt-u">USDC</span>');
    expect(html('9,999원')).toBe('<span class="amt-n">9,999</span><span class="amt-u">원</span>');
    expect(html('1,234.5')).toBe('<span class="amt-n">1,234.5</span>');
  });

  it('renders anything it does not recognise as plain text', () => {
    expect(html('—')).toBe('—');
    expect(html('시세 없음')).toBe('시세 없음');
  });
});
