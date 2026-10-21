// 지급 근거(A2b, DEC-005, 설계 가정 A-38·A-39): 출금 요청 작성자가 작성 중·검토 중에만 근거 파일을 붙이고 지우고 메모를 고친다.
// 승인 요청 뒤에는 고정된다(이 모듈의 상태 검사 + migrations/008 트리거). 감사 기록에는 메타데이터(이름·형식·크기·SHA-256)만 남긴다.
import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';
import { now, tx } from '../db.ts';
import { AppError, Errors } from '../errors.ts';
import type { AuthContext } from '../auth.ts';
import type { AppConfig } from '../config.ts';
import { PAYMENT_EVIDENCE_TEXT, REQUEST_STATUS, type RequestStatus } from '../../shared/terms.ts';
import { brokenTextMessage } from '../../shared/schemas.ts';
import {
  ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_FILES, ATTACHMENT_TYPE_LABELS, ATTACHMENT_TYPES, fileSizeLabel, isEvidenceEditable, sanitizeAttachmentName, sniffAttachmentType,
  type AttachmentContentType,
} from '../../shared/attachments.ts';
import { attachmentCount, duplicateAttachmentId, evidenceNoteOf, findAttachmentMeta, noteDigest, paymentEvidenceOf, type AttachmentMeta } from './attachment-store.ts';
import { audit, bump, getRequest, getRow, requireCreator } from './requests.ts';

/** 공개 데모의 인스턴스 한도(app.ts). 로컬에서는 아무것도 하지 않는다. */
export interface AttachmentDemoCaps {
  /** 올리기 건수(DEMO_LIMIT, 지운 파일도 센다) */
  assertCount(): void;
  /** 이 인스턴스의 파일 총 바이트에 incoming을 더해도 되는지(DEMO_LIMIT) */
  assertBytes(incoming: number): void;
}
export const NO_DEMO_CAPS: AttachmentDemoCaps = { assertCount: () => undefined, assertBytes: () => undefined };

const UPLOAD_FORMAT_ACTION = '화면의 「파일 추가」로 다시 올리세요.';
/** 화면의 보내기 전 검사와 같은 문장 짝(shared/terms.ts PAYMENT_EVIDENCE_TEXT.upload) */
const UP = PAYMENT_EVIDENCE_TEXT.upload;
export const tooLarge = () => new AppError(413, 'ATTACHMENT_TOO_LARGE', UP.tooLarge.message, UP.tooLarge.action);
export const uploadFormat = () => new AppError(415, 'ATTACHMENT_UPLOAD_FORMAT', '파일을 올리는 형식이 올바르지 않습니다.', UPLOAD_FORMAT_ACTION);

/** 요청 조회 권한이 없으면(운영 조직 등) 요청이 있는지도 보기 전에 거부한다(다른 요청 경로와 같은 순서). */
function requireRead(auth: AuthContext, what: string) {
  if (!auth.perms.has('request.read')) throw Errors.forbidden(what);
}

/** 작성 중·검토 중이 아니면 409 EVIDENCE_LOCKED(추가 필드 status). */
function assertEditable(r: any) {
  if (isEvidenceEditable(r.status)) return;
  const label = REQUEST_STATUS[r.status as RequestStatus]?.label ?? r.status;
  throw new AppError(409, 'EVIDENCE_LOCKED', `'${label}' 상태라 지급 근거를 바꿀 수 없습니다.`, '지급 근거는 작성 중·검토 중에만 바꿀 수 있고, 승인 요청 때 고정됩니다.', undefined, { status: r.status });
}

function assertCountRoom(db: DB, requestId: string) {
  if (attachmentCount(db, requestId) >= ATTACHMENT_MAX_FILES) {
    throw new AppError(422, 'ATTACHMENT_LIMIT', UP.limit.message, UP.limit.action, undefined, { maxFiles: ATTACHMENT_MAX_FILES });
  }
}

const mediaType = (raw: unknown) => (typeof raw === 'string' ? raw.split(';')[0]!.trim().toLowerCase() : '');

/**
 * 올리기 사전 검사(본문을 읽기 전, 업로드 경로의 preParsing: 경로 요청 한도 훅 뒤라 여기서 거부된 시도도 한도에 센다).
 * 순서: (로그인, app.ts) → 기능 켜짐 → 요청 조회 권한 → 요청(다른 조직 404) → 작성자 → 상태
 * → 본문 형식(application/octet-stream만) → 선언한 크기 → 파일 수 → 공개 데모 한도. 같은 검사를 저장 트랜잭션 안에서 다시 한다.
 */
export function preflightAttachmentUpload(db: DB, cfg: AppConfig, auth: AuthContext, id: string, h: { contentType: unknown; contentLength: unknown }, demo: AttachmentDemoCaps) {
  if (!cfg.attachmentsEnabled) {
    throw new AppError(403, 'ATTACHMENTS_DISABLED', '이 환경에서는 지급 근거 파일 올리기를 꺼 두었습니다.', '지급 근거 메모에 문서 번호를 적어 두세요. 이미 붙은 파일은 그대로 볼 수 있습니다.');
  }
  requireRead(auth, '지급 근거 파일 올리기');
  const r = getRow(db, auth.org.id, id);
  requireCreator(r, auth);
  assertEditable(r);
  if (mediaType(h.contentType) !== 'application/octet-stream') throw uploadFormat();
  const declared = Number(h.contentLength);
  if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_FILE_BYTES) throw tooLarge();
  assertCountRoom(db, r.id);
  demo.assertCount();
  demo.assertBytes(Number.isFinite(declared) && declared > 0 ? declared : 0);
}

const fileNameError = (message: string) => new AppError(422, 'VALIDATION', message, '파일 이름을 바꾼 뒤 다시 올리세요.', [{ field: 'fileName', message }]);

/** X-Attachment-Name 머리글(encodeURIComponent한 UTF-8 이름). 없으면 빈 이름(→ '지급근거-<SHA 앞 8자>'). */
function decodeNameHeader(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  if (typeof raw !== 'string') throw fileNameError('파일 이름을 읽을 수 없습니다.');
  try { return decodeURIComponent(raw); } catch { throw fileNameError('파일 이름을 읽을 수 없습니다.'); }
}

const describe = (m: { fileName: string; contentType: AttachmentContentType; sizeBytes: number }) => `${m.fileName} (${ATTACHMENT_TYPES[m.contentType].label}, ${fileSizeLabel(m.sizeBytes)})`;
const metaDetail = (m: Pick<AttachmentMeta, 'id' | 'fileName' | 'contentType' | 'sizeBytes' | 'sha256'>) => ({ attachmentId: m.id, fileName: m.fileName, contentType: m.contentType, sizeBytes: m.sizeBytes, sha256: m.sha256 });

/**
 * 근거 파일 한 개 붙이기. 형식은 내용 앞부분으로만 정하고(PDF·PNG·JPEG), 이름은 정리해 저장한다.
 * 저장 트랜잭션(BEGIN IMMEDIATE) 안에서 작성자·상태·파일 수·같은 내용·데모 한도를 다시 본다(승인 요청과 직렬화).
 * 요청 버전을 올리고 감사 기록(request.attachment_added, 메타데이터만)을 하나 남긴다.
 */
export function addAttachment(db: DB, cfg: AppConfig, auth: AuthContext, id: string, bytes: Buffer, nameHeader: unknown, demo: AttachmentDemoCaps) {
  if (bytes.length === 0) throw new AppError(422, 'ATTACHMENT_EMPTY', UP.empty.message, UP.empty.action);
  if (bytes.length > ATTACHMENT_MAX_FILE_BYTES) throw tooLarge();
  const type = sniffAttachmentType(bytes);
  if (!type) {
    throw new AppError(422, 'ATTACHMENT_TYPE_NOT_ALLOWED', UP.type.message, UP.type.action, undefined, { allowed: [...ATTACHMENT_TYPE_LABELS] });
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fileName = sanitizeAttachmentName(decodeNameHeader(nameHeader), type, sha256);
  if (fileName === null) throw fileNameError(brokenTextMessage('파일 이름'));
  return tx(db, () => {
    requireRead(auth, '지급 근거 파일 올리기');
    const r = getRow(db, auth.org.id, id);
    requireCreator(r, auth);
    assertEditable(r);
    assertCountRoom(db, r.id);
    const dup = duplicateAttachmentId(db, r.id, sha256);
    if (dup) throw new AppError(409, 'ATTACHMENT_DUPLICATE', '같은 내용의 파일이 이미 이 요청의 지급 근거에 있습니다.', '이미 붙은 파일을 확인하세요.', undefined, { attachmentId: dup });
    demo.assertCount();
    demo.assertBytes(bytes.length);
    const aid = randomUUID();
    db.prepare('INSERT INTO request_attachments (id, request_id, org_id, file_name, content_type, size_bytes, sha256, added_by, added_at, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(aid, r.id, r.org_id, fileName, type, bytes.length, sha256, auth.user.id, now(), bytes);
    bump(db, r.id, r.version, {});
    const m = { id: aid, fileName, contentType: type, sizeBytes: bytes.length, sha256 };
    audit(db, auth, r, 'request.attachment_added', `지급 근거 파일 첨부: ${describe(m)}`, metaDetail(m));
    return getRequest(db, cfg, auth, r.id);
  });
}

/** 근거 파일 한 개 지우기(작성 중·검토 중만). 행은 지우고, 무엇을 지웠는지는 감사 기록(request.attachment_removed)에 남는다. */
export function removeAttachment(db: DB, cfg: AppConfig, auth: AuthContext, id: string, attachmentId: string) {
  return tx(db, () => {
    requireRead(auth, '지급 근거 파일 삭제');
    const r = getRow(db, auth.org.id, id);
    requireCreator(r, auth);
    assertEditable(r);
    const m = findAttachmentMeta(db, r.id, attachmentId);
    if (!m) throw Errors.notFound('지급 근거 파일');
    db.prepare('DELETE FROM request_attachments WHERE id = ? AND request_id = ?').run(m.id, r.id);
    bump(db, r.id, r.version, {});
    audit(db, auth, r, 'request.attachment_removed', `지급 근거 파일 삭제: ${describe(m)}`, metaDetail(m));
    return getRequest(db, cfg, auth, r.id);
  });
}

/**
 * 지급 근거 메모 저장(설계 가정 A-38). note는 입력 검증(evidenceNoteSchema)을 거친 값이다. 빈 값은 메모를 지운다.
 * 바뀐 것이 없으면 아무것도 쓰지 않는다(버전·감사 기록 그대로). 감사 기록에는 글 대신 길이·SHA-256만 남긴다.
 */
export function saveEvidenceNote(db: DB, cfg: AppConfig, auth: AuthContext, id: string, input: { note: string }) {
  return tx(db, () => {
    requireRead(auth, '지급 근거 메모 수정');
    const r = getRow(db, auth.org.id, id);
    requireCreator(r, auth);
    assertEditable(r);
    const before = evidenceNoteOf(db, r.id);
    const next = input.note;
    if ((before?.text ?? '') === next) return getRequest(db, cfg, auth, r.id);
    if (next === '') {
      db.prepare('DELETE FROM request_evidence_notes WHERE request_id = ?').run(r.id);
    } else {
      db.prepare(`INSERT INTO request_evidence_notes (request_id, note, updated_by, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(r.id, next, auth.user.id, now());
    }
    bump(db, r.id, r.version, {});
    audit(db, auth, r, 'request.evidence_note_updated', next ? '지급 근거 메모 저장' : '지급 근거 메모 지움', { before: noteDigest(before?.text), after: noteDigest(next) });
    return getRequest(db, cfg, auth, r.id);
  });
}

/** 요청의 지급 근거(목록). 다른 조직 요청은 404. */
export function listPaymentEvidence(db: DB, cfg: AppConfig, auth: AuthContext, id: string) {
  const r = getRow(db, auth.org.id, id);
  return paymentEvidenceOf(db, cfg, r, auth);
}

/** 파일 내용을 읽는 유일한 조회. 요청·조직이 모두 맞아야 하며, 아니면 404(다른 조직·다른 요청의 파일 id). */
export function readAttachmentContent(db: DB, auth: AuthContext, id: string, attachmentId: string): { fileName: string; contentType: AttachmentContentType; sizeBytes: number; content: Uint8Array } {
  const row = db.prepare('SELECT a.file_name, a.content_type, a.size_bytes, a.content FROM request_attachments a WHERE a.id = ? AND a.request_id = ? AND a.org_id = ?')
    .get(attachmentId, id, auth.org.id) as { file_name: string; content_type: AttachmentContentType; size_bytes: number; content: Uint8Array } | undefined;
  if (!row) throw Errors.notFound('지급 근거 파일');
  return { fileName: row.file_name, contentType: row.content_type, sizeBytes: Number(row.size_bytes), content: row.content };
}
