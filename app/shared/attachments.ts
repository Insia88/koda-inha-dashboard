// 지급 근거(A2b, DEC-005): 출금 요청에 붙이는 근거 파일의 한도·형식 판정·이름 정리·내려받기 머리글. 서버와 화면이 같은 규칙을 쓴다.
// 화면 번들에 검증 라이브러리(zod)를 끌어오지 않도록 이 파일은 shared/text.ts(아무것도 가져오지 않음)만 가져온다.
import { isWellFormedText, stripFormatChars } from './text.ts';

/** 파일 하나의 최대 크기(2MiB). 업로드 경로의 본문 한도와 같고, Vercel 함수 본문 한도(4.5MB) 안에 든다. 설계 가정(A-39). */
export const ATTACHMENT_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 요청 한 건에 붙일 수 있는 파일 수. 설계 가정(A-39). */
export const ATTACHMENT_MAX_FILES = 5;
/** 지급 근거 메모 최대 글자 수. 설계 가정(A-38). */
export const EVIDENCE_NOTE_MAX_LENGTH = 300;
/** 정리한 파일 이름의 최대 글자 수(확장자 포함, 코드 포인트 기준). 저장 계층 CHECK는 120자로 여유를 둔다. */
export const ATTACHMENT_NAME_MAX_LENGTH = 100;
/** 지급 근거를 붙이거나 지우거나 메모를 고칠 수 있는 요청 상태(migrations/008 트리거와 같다). 승인 요청 뒤에는 고정된다. */
export const EVIDENCE_EDITABLE_STATUSES = ['DRAFT', 'REVIEW'] as const;
export const isEvidenceEditable = (status: string) => (EVIDENCE_EDITABLE_STATUSES as readonly string[]).includes(status);

export type AttachmentContentType = 'application/pdf' | 'image/png' | 'image/jpeg';
/** 받는 형식. ext는 내려받을 이름에 붙이는 확장자, alt는 그 형식으로 인정하는 다른 확장자. */
export const ATTACHMENT_TYPES: Record<AttachmentContentType, { label: string; ext: string; alt: readonly string[] }> = {
  'application/pdf': { label: 'PDF', ext: 'pdf', alt: [] },
  'image/png': { label: 'PNG', ext: 'png', alt: [] },
  'image/jpeg': { label: 'JPEG', ext: 'jpg', alt: ['jpeg'] },
};
export const ATTACHMENT_TYPE_LABELS = Object.values(ATTACHMENT_TYPES).map((t) => t.label);
/** 화면의 파일 선택 상자 accept 값. 판정은 서버가 내용으로 다시 한다. */
export const ATTACHMENT_ACCEPT = 'application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg';
/** 형식 판정에 필요한 앞부분 바이트 수(PNG 서명 8바이트 + 첫 덩어리 길이 4바이트 + 'IHDR'). */
export const ATTACHMENT_SNIFF_BYTES = 16;

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // '%PDF-'
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];
const JPEG = [0xff, 0xd8, 0xff];

/**
 * 파일 앞부분(매직 바이트)만으로 형식을 정한다. 보낸 쪽이 붙인 형식(Content-Type)이나 파일 이름은 보지 않는다.
 * PDF: 0번째부터 '%PDF-'. PNG: 8바이트 서명 + 12~15번째 'IHDR'. JPEG: FF D8 FF.
 * 그 밖(SVG·XML·HTML·GIF·WebP, 앞에 BOM·공백이 붙은 값, 잘린 서명, 빈 값)은 모두 null.
 */
export function sniffAttachmentType(bytes: Uint8Array): AttachmentContentType | null {
  if (startsWith(bytes, PDF)) return 'application/pdf';
  if (startsWith(bytes, PNG) && startsWith(bytes, IHDR, 12)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  return null;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const RESERVED_CHARS = /[<>:"|?*]/g;
const cp = (s: string) => [...s];

function extensionOf(name: string, type: AttachmentContentType): string | null {
  const t = ATTACHMENT_TYPES[type];
  const m = /\.([^.]+)$/.exec(name);
  if (!m) return null;
  const ext = m[1]!.toLowerCase();
  return ext === t.ext || t.alt.includes(ext) ? m[0] : null;
}

/**
 * 내려받을 때 머리글에 쓰는 파일 이름. 경로로는 쓰지 않는다. 깨진 문자(짝 없는 서로게이트)가 있으면 null(보낸 쪽이 고쳐 다시 보낸다).
 * NFC → 마지막 '/'·'\' 뒤 이름만 → 제어 문자(C0·C1·DEL)·보이지 않는 서식 문자(방향 제어·폭 없는 공백 등) 제거 → <>:"|?* 는 '_'
 * → 공백 묶음은 한 칸 → 앞뒤 공백 제거 → 앞의 점, 뒤의 점·공백 제거. 비면 '지급근거-<SHA-256 앞 8자>'.
 * 판정한 형식에 맞는 확장자로 끝나지 않으면 그 형식의 확장자를 붙인다('evil.html' → 'evil.html.png').
 * 확장자를 지키며 전체를 100글자(코드 포인트)까지 자른다.
 */
export function sanitizeAttachmentName(raw: string, type: AttachmentContentType, sha256: string): string | null {
  if (!isWellFormedText(raw)) return null;
  let s = raw.normalize('NFC');
  s = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
  s = stripFormatChars(s.replace(CONTROL_CHARS, ''));
  s = s.replace(RESERVED_CHARS, '_').replace(/\s+/gu, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/[.\s]+$/u, '');
  if (!s) s = `지급근거-${sha256.slice(0, 8)}`;
  let ext = extensionOf(s, type);
  let stem = ext ? s.slice(0, s.length - ext.length) : s;
  if (!ext) ext = `.${ATTACHMENT_TYPES[type].ext}`;
  const room = ATTACHMENT_NAME_MAX_LENGTH - cp(ext).length;
  if (cp(stem).length > room) stem = cp(stem).slice(0, room).join('').replace(/[.\s]+$/u, '');
  if (!stem) stem = `지급근거-${sha256.slice(0, 8)}`;
  return `${stem}${ext}`;
}

/** RFC 5987 값: encodeURIComponent가 남기는 ' ( ) * 도 인코딩한다(attr-char 밖). */
const rfc5987 = (s: string) => encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * 내려받기 Content-Disposition. 항상 attachment(브라우저가 이 출처에서 열지 않고 저장한다).
 * filename: 출력 가능한 ASCII만 남긴 대체 이름(그 밖의 글자와 " \ ; % 는 '_', '_' 묶음은 하나). 읽을 글자(영문·숫자)가 없으면 'attachment.<확장자>'.
 * filename*: UTF-8 원래 이름(RFC 5987). 줄바꿈·NUL은 어느 쪽에도 들어가지 않는다.
 */
export function contentDisposition(name: string, type: AttachmentContentType): string {
  const ext = ATTACHMENT_TYPES[type].ext;
  let fallback = name.replace(/[^\x20-\x7e]|["\\;%]/gu, '_').replace(/_+/g, '_');
  const stem = fallback.replace(/\.[^.]*$/, '');
  if (!/[A-Za-z0-9]/.test(stem)) fallback = `attachment.${ext}`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(name)}`;
}

/** 파일 크기 표시: 1KB 미만 'nB', 1MB 미만 'nKB', 그 이상 'n.nMB'(1024 단위). */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 화면 표시용 SHA-256 앞 12자리(16진수). 전체 값은 감사 기록과 응답에 그대로 있다. */
export const shortSha = (h: string) => h.slice(0, 12);

/** 지급 근거 파일 한 개(메타데이터만, 내용 없음). */
export interface AttachmentView {
  id: string;
  /** 서버가 정리한 이름(sanitizeAttachmentName) */
  fileName: string;
  /** 서버가 파일 앞부분으로 판정한 형식 */
  contentType: AttachmentContentType;
  /** 'PDF'·'PNG'·'JPEG' */
  typeLabel: string;
  sizeBytes: number;
  /** 파일 내용의 SHA-256(16진수 소문자 64자) */
  sha256: string;
  addedBy: { name: string };
  addedAt: string;
  /** 화면이 작은 미리 보기(<img>)를 보여도 되는지(PNG·JPEG만). PDF는 내려받기만 한다. */
  previewable: boolean;
  /** 로그인한 같은 조직 사용자만 받을 수 있는 내려받기 경로(항상 첨부로 내려받음) */
  contentUrl: string;
}

/**
 * 요청 상세·행동 응답의 지급 근거(A2b, 설계 가정 A-38). 목록 응답에는 없다.
 * - locked: 작성 중·검토 중이 아니다(승인 요청 뒤 고정).
 * - canEdit: 조회자가 작성자이고 요청 작성 권한이 있으며 잠기지 않았다.
 * - uploadsEnabled: 이 환경에서 파일 올리기가 켜져 있다(REQUEST_ATTACHMENTS=off이면 false. 목록·내려받기·삭제·메모는 그대로).
 */
export interface PaymentEvidence {
  note: { text: string; updatedBy: { name: string }; updatedAt: string } | null;
  attachments: AttachmentView[];
  hasAny: boolean;
  locked: boolean;
  canEdit: boolean;
  uploadsEnabled: boolean;
  limits: { maxFiles: number; maxFileBytes: number; noteMaxLength: number; types: string[] };
  isDesignAssumption: true;
}
