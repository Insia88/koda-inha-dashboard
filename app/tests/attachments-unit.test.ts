// A2b 지급 근거 공용 규칙(shared/attachments.ts): 내용 앞부분으로만 정하는 형식, 파일 이름 정리, 내려받기 머리글, 크기 표시.
import { describe, expect, it } from 'vitest';
import { fc } from '@fast-check/vitest';
import {
  ATTACHMENT_NAME_MAX_LENGTH, contentDisposition, fileSizeLabel, sanitizeAttachmentName, shortSha, sniffAttachmentType, type AttachmentContentType,
} from '../shared/attachments.ts';

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)));
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SHA = '3f9a1c0b7d2e44aa'.padEnd(64, '0');
const RUNS = { numRuns: 1000, ...(process.env.FC_SEED ? { seed: Number(process.env.FC_SEED) } : {}) };

describe('sniffAttachmentType', () => {
  it.each([
    ['PDF', bytes('%PDF-1.7\n'), 'application/pdf'],
    ['PDF(5바이트)', bytes('%PDF-'), 'application/pdf'],
    ['PNG', bytes(PNG_SIG, [0, 0, 0, 13], 'IHDR', [0, 0, 0, 1]), 'image/png'],
    ['JPEG', bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16]), 'image/jpeg'],
    ['JPEG(3바이트)', bytes([0xff, 0xd8, 0xff]), 'image/jpeg'],
  ])('accepts %s', (_n, b, type) => expect(sniffAttachmentType(b)).toBe(type));

  it.each([
    ['HTML', bytes('<!doctype html><html>')],
    ['SVG', bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['XML', bytes('<?xml version="1.0"?><svg/>')],
    ['GIF89a', bytes('GIF89a', [1, 0, 1, 0])],
    ['RIFF/WEBP', bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ')],
    ['BOM + %PDF', bytes([0xef, 0xbb, 0xbf], '%PDF-1.4')],
    ['공백 + %PDF', bytes(' %PDF-1.4')],
    ['%PDF(대시 없음)', bytes('%PDF')],
    ['IHDR 없는 PNG 서명', bytes(PNG_SIG, [0, 0, 0, 13], 'IDAT')],
    ['PNG 서명만', bytes(PNG_SIG)],
    ['FF D8만', bytes([0xff, 0xd8])],
    ['빈 값', new Uint8Array(0)],
  ])('rejects %s', (_n, b) => expect(sniffAttachmentType(b)).toBeNull());
});

describe('sanitizeAttachmentName', () => {
  const pdf = (s: string) => sanitizeAttachmentName(s, 'application/pdf', SHA);
  it('keeps only the base name and drops path parts', () => {
    expect(pdf('../../a/b/invoice.pdf')).toBe('invoice.pdf');
    expect(pdf('C:\\Users\\me\\invoice.pdf')).toBe('invoice.pdf');
    expect(pdf('..\\..\\x.pdf')).toBe('x.pdf');
  });
  it('strips RLO, zero-width, BOM and control characters (CR/LF/NUL) and replaces reserved characters', () => {
    expect(pdf('inv\u202eoice\u200b.pdf')).toBe('invoice.pdf');
    expect(pdf('\ufeffa\r\nb\u0000c\u0085.pdf')).toBe('abc.pdf');
    expect(pdf('a<b>c:d"e|f?g*h.pdf')).toBe('a_b_c_d_e_f_g_h.pdf');
    expect(pdf('  a   \t b  .pdf  ')).toBe('a b .pdf');
    expect(pdf('...hidden.pdf...')).toBe('hidden.pdf');
  });
  it('appends the extension of the sniffed type when the name does not already end with it', () => {
    expect(sanitizeAttachmentName('evil.html', 'image/png', SHA)).toBe('evil.html.png');
    expect(sanitizeAttachmentName('photo.JPEG', 'image/jpeg', SHA)).toBe('photo.JPEG');
    expect(sanitizeAttachmentName('photo.jpg', 'image/jpeg', SHA)).toBe('photo.jpg');
    expect(sanitizeAttachmentName('scan.png', 'image/jpeg', SHA)).toBe('scan.png.jpg');
    expect(pdf('INVOICE.PDF')).toBe('INVOICE.PDF');
    expect(pdf('report')).toBe('report.pdf');
  });
  it('truncates to 100 code points keeping the extension, and names an empty result from the SHA-256', () => {
    const long = pdf(`${'가'.repeat(300)}.pdf`)!;
    expect([...long]).toHaveLength(ATTACHMENT_NAME_MAX_LENGTH);
    expect(long.endsWith('.pdf')).toBe(true);
    const emoji = pdf(`${'😀'.repeat(150)}.pdf`)!;
    expect([...emoji]).toHaveLength(ATTACHMENT_NAME_MAX_LENGTH);
    expect(emoji.endsWith('😀.pdf')).toBe(true);
    expect(pdf('')).toBe('지급근거-3f9a1c0b.pdf');
    expect(pdf('\u200b\u202e  ...')).toBe('지급근거-3f9a1c0b.pdf');
    expect(pdf('/')).toBe('지급근거-3f9a1c0b.pdf');
  });
  it('refuses broken text (lone surrogates) with null and normalizes to NFC', () => {
    expect(pdf('a\ud800.pdf')).toBeNull();
    expect(pdf('\u1100\u1161.pdf')).toBe('\uac00.pdf');
  });
});

describe('contentDisposition', () => {
  it('builds an attachment header with an ASCII fallback and an RFC 5987 filename*', () => {
    expect(contentDisposition('invoice.pdf', 'application/pdf')).toBe(`attachment; filename="invoice.pdf"; filename*=UTF-8''invoice.pdf`);
    expect(contentDisposition('인보이스.pdf', 'application/pdf')).toBe(`attachment; filename="attachment.pdf"; filename*=UTF-8''%EC%9D%B8%EB%B3%B4%EC%9D%B4%EC%8A%A4.pdf`);
    expect(contentDisposition('영수증 2026.png', 'image/png')).toBe(`attachment; filename="_ 2026.png"; filename*=UTF-8''%EC%98%81%EC%88%98%EC%A6%9D%202026.png`);
    expect(contentDisposition("a'(b)*;%.jpg", 'image/jpeg')).toBe(`attachment; filename="a'(b)*_.jpg"; filename*=UTF-8''a%27%28b%29%2A%3B%25.jpg`);
  });

  it('never puts CR, LF or NUL in the header; the fallback is printable ASCII without quotes or backslashes; filename* decodes back', () => {
    const unit = fc.oneof(
      fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c)),
      fc.constantFrom('"', '\\', ';', '%', '\r', '\n', '\u0000', '\u202e', '\u200b', '/', '.', ' ', '가', '😀', "'", '*'),
    );
    const types: AttachmentContentType[] = ['application/pdf', 'image/png', 'image/jpeg'];
    fc.assert(fc.property(fc.string({ unit, maxLength: 140 }), fc.constantFrom(...types), (raw, type) => {
      const name = sanitizeAttachmentName(raw, type, SHA);
      if (name === null) return;
      expect([...name].length).toBeLessThanOrEqual(ATTACHMENT_NAME_MAX_LENGTH);
      expect(name).not.toMatch(/[\u0000-\u001f\u007f-\u009f/\\<>:"|?*]/);
      const cd = contentDisposition(name, type);
      expect(cd).not.toMatch(/[\r\n\u0000]/);
      const m = /^attachment; filename="([^"]*)"; filename\*=UTF-8''([A-Za-z0-9%!._~-]+)$/.exec(cd);
      expect(m, cd).not.toBeNull();
      expect(m![1]).toMatch(/^[\x20-\x7e]+$/);
      expect(m![1]).not.toMatch(/["\\]/);
      expect(decodeURIComponent(m![2]!)).toBe(name);
    }), RUNS);
  });
});

describe('fileSizeLabel·shortSha', () => {
  it('formats bytes, KB and MB and shows 12 hex digits', () => {
    expect(fileSizeLabel(67)).toBe('67B');
    expect(fileSizeLabel(1023)).toBe('1023B');
    expect(fileSizeLabel(1024)).toBe('1KB');
    expect(fileSizeLabel(186_368)).toBe('182KB');
    expect(fileSizeLabel(2 * 1024 * 1024)).toBe('2.0MB');
    expect(fileSizeLabel(1_572_864)).toBe('1.5MB');
    expect(shortSha(SHA)).toBe('3f9a1c0b7d2e');
  });
});
