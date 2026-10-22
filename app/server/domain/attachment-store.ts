// 지급 근거(A2b) 조회. 이 모듈은 저장소와 shared만 가져온다(requests.ts가 이 모듈을 가져오므로 반대 방향 가져오기를 두지 않는다).
// 여기 있는 조회는 모두 메타데이터만 읽고 파일 내용(content 열)은 고르지 않는다. 내용은 attachments.ts readAttachmentContent 하나만 읽는다.
import { createHash } from 'node:crypto';
import type { DB } from '../db.ts';
import type { AppConfig } from '../config.ts';
import type { AuthContext } from '../auth.ts';
import {
  ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_FILES, ATTACHMENT_TYPE_LABELS, ATTACHMENT_TYPES, EVIDENCE_NOTE_MAX_LENGTH, isEvidenceEditable,
  type AttachmentContentType, type AttachmentView, type PaymentEvidence,
} from '../../shared/attachments.ts';

export interface AttachmentMeta {
  id: string;
  requestId: string;
  orgId: string;
  fileName: string;
  contentType: AttachmentContentType;
  sizeBytes: number;
  sha256: string;
  addedBy: { id: string; name: string };
  addedAt: string;
}

// content 열을 고르지 않는다(넘침 페이지를 읽지 않는다, migrations/008).
const META = `SELECT a.id, a.request_id, a.org_id, a.file_name, a.content_type, a.size_bytes, a.sha256, a.added_by, a.added_at, u.name added_by_name
  FROM request_attachments a JOIN users u ON u.id = a.added_by`;

function toMeta(row: any): AttachmentMeta {
  return {
    id: row.id, requestId: row.request_id, orgId: row.org_id, fileName: row.file_name, contentType: row.content_type as AttachmentContentType,
    sizeBytes: Number(row.size_bytes), sha256: row.sha256, addedBy: { id: row.added_by, name: row.added_by_name }, addedAt: row.added_at,
  };
}

/** 요청의 지급 근거 파일(붙인 순서). */
export function listAttachmentMeta(db: DB, requestId: string): AttachmentMeta[] {
  return (db.prepare(`${META} WHERE a.request_id = ? ORDER BY a.added_at, a.id`).all(requestId) as any[]).map(toMeta);
}

/** 요청 안의 파일 하나(없으면 null). 다른 요청의 파일 id는 찾지 않는다. */
export function findAttachmentMeta(db: DB, requestId: string, attachmentId: string): AttachmentMeta | null {
  const row = db.prepare(`${META} WHERE a.request_id = ? AND a.id = ?`).get(requestId, attachmentId);
  return row ? toMeta(row) : null;
}

export function attachmentCount(db: DB, requestId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM request_attachments WHERE request_id = ?').get(requestId) as { c: number }).c;
}

/** 같은 내용(SHA-256)의 파일이 이미 있으면 그 id. */
export function duplicateAttachmentId(db: DB, requestId: string, sha256: string): string | null {
  const row = db.prepare('SELECT id FROM request_attachments WHERE request_id = ? AND sha256 = ?').get(requestId, sha256) as { id: string } | undefined;
  return row?.id ?? null;
}

/** 이 인스턴스(DB)에 저장된 지급 근거 파일의 총 바이트(공개 데모 용량 한도, A-39). size_bytes만 더한다. */
export function totalAttachmentBytes(db: DB): number {
  return Number((db.prepare('SELECT COALESCE(SUM(size_bytes), 0) n FROM request_attachments').get() as { n: number }).n);
}

export interface EvidenceNote { text: string; updatedBy: { id: string; name: string }; updatedAt: string }

export function evidenceNoteOf(db: DB, requestId: string): EvidenceNote | null {
  const row = db.prepare('SELECT n.note, n.updated_by, n.updated_at, u.name FROM request_evidence_notes n JOIN users u ON u.id = n.updated_by WHERE n.request_id = ?').get(requestId) as any;
  return row ? { text: row.note, updatedBy: { id: row.updated_by, name: row.name }, updatedAt: row.updated_at } : null;
}

/** 감사 기록에 남기는 메모 요약: 글은 남기지 않고 길이(코드 포인트)와 SHA-256(UTF-8)만. */
export function noteDigest(text: string | null | undefined): { length: number; sha256: string } | null {
  if (!text) return null;
  return { length: [...text].length, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

export function toAttachmentView(m: AttachmentMeta): AttachmentView {
  return {
    id: m.id, fileName: m.fileName, contentType: m.contentType, typeLabel: ATTACHMENT_TYPES[m.contentType].label, sizeBytes: m.sizeBytes, sha256: m.sha256,
    addedBy: { name: m.addedBy.name }, addedAt: m.addedAt, previewable: m.contentType !== 'application/pdf',
    contentUrl: `/api/requests/${encodeURIComponent(m.requestId)}/attachments/${encodeURIComponent(m.id)}/content`,
  };
}

/**
 * 요청 상세·행동 응답의 지급 근거(설계 가정 A-38). r은 요청 행(created_by·status·id).
 * 같은 조직의 요청 조회 권한이 있는 사람은 모두 같은 목록을 본다. 고칠 수 있는지(canEdit)만 조회자마다 다르다.
 */
export function paymentEvidenceOf(db: DB, cfg: AppConfig, r: { id: string; status: string; created_by: string }, auth: AuthContext): PaymentEvidence {
  const attachments = listAttachmentMeta(db, r.id).map(toAttachmentView);
  const note = evidenceNoteOf(db, r.id);
  const locked = !isEvidenceEditable(r.status);
  return {
    note: note ? { text: note.text, updatedBy: { name: note.updatedBy.name }, updatedAt: note.updatedAt } : null,
    attachments,
    hasAny: attachments.length > 0 || !!note,
    locked,
    canEdit: !locked && r.created_by === auth.user.id && auth.perms.has('request.create'),
    uploadsEnabled: cfg.attachmentsEnabled,
    limits: { maxFiles: ATTACHMENT_MAX_FILES, maxFileBytes: ATTACHMENT_MAX_FILE_BYTES, noteMaxLength: EVIDENCE_NOTE_MAX_LENGTH, types: [...ATTACHMENT_TYPE_LABELS] },
    isDesignAssumption: true,
  };
}

/**
 * 승인 요청 감사 기록(request.submitted)에 남기는 그때의 지급 근거 목록. 파일 내용·메모 글은 넣지 않는다.
 * 저장 계층에서 근거가 바뀌었는지는 이 목록과 지금 목록을 비교해야 알 수 있다(자동 비교는 없음, DEC-005 남는 위험).
 */
export function evidenceSnapshot(db: DB, requestId: string) {
  const note = evidenceNoteOf(db, requestId);
  return {
    note: noteDigest(note?.text),
    attachments: listAttachmentMeta(db, requestId).map((m) => ({ id: m.id, fileName: m.fileName, contentType: m.contentType, sizeBytes: m.sizeBytes, sha256: m.sha256 })),
  };
}
