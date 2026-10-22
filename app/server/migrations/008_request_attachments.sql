-- 지급 근거(A2b, DEC-005): 출금 요청에 붙이는 근거 파일(PDF·PNG·JPEG)과 근거 메모. 007 이후에 실행된다(파일 이름 순서).
-- 기존 표(withdrawal_requests·request_intents·approvals·transactions·audit_log)에는 열을 더하지 않고 짝 표 두 개만 새로 만든다(006과 같은 방식).
-- 이전 마이그레이션 검사(tests/migration-007.test.ts 등)가 기존 표의 SELECT * 결과 전체를 비교하므로 기존 표의 모양은 그대로여야 한다.
-- 지급 근거는 승인 대상 지문(request_intents.intent_hash, A-29·A-30)에 넣지 않는다. 승인자가 같은 근거를 보고 결정하게 하는 것은
-- 지문이 아니라 아래 잠금(승인 요청 뒤 추가·삭제·수정 금지)과 승인 요청 감사 기록(request.submitted)의 근거 목록이다.
--
-- 1) request_attachments: 근거 파일 한 개에 한 행. 파일 내용(content)은 이 DB에 그대로 둔다(공개 데모는 인스턴스 메모리라 재시작 때 사라진다).
--    content_type은 서버가 파일 앞부분(매직 바이트)으로 판정한 형식이다(shared/attachments.ts sniffAttachmentType). 보낸 쪽의 형식·파일 이름은 믿지 않는다.
--    file_name은 서버가 정리한 이름이다(경로·제어 문자·방향 제어 문자 제거, 형식에 맞는 확장자). 내려받을 때 머리글에만 쓰고 경로로 쓰지 않는다.
--    content는 맨 끝 열이다. 목록·합계(SUM(size_bytes)) 조회는 앞쪽 열만 읽으므로 큰 파일의 넘침 페이지를 읽지 않는다. content를 고르는 조회는 내려받기 하나뿐이다.
--    같은 요청에 같은 내용(sha256)을 두 번 붙일 수 없다(UNIQUE). 다시 보내기(재시도)가 두 행을 만들지 않는다.
-- 2) request_evidence_notes: 요청 한 건에 한 행. 문서 번호·정산 건처럼 승인자가 근거를 찾을 수 있는 짧은 메모(설계 가정 A-38). 빈 값은 행을 지운다.
--
-- 트리거(앱 코드가 잘못되어도 저장 계층에서 같은 규칙을 지킨다):
--  · 요청 상태가 작성 중(DRAFT)·검토 중(REVIEW)이 아니면 파일·메모를 넣거나 지우거나 고칠 수 없다(REQUEST_EVIDENCE_LOCKED). 승인 요청 뒤에는 근거 묶음이 고정된다.
--  · 파일 행은 고칠 수 없다(REQUEST_ATTACHMENT_IMMUTABLE). 제출 전에 지우는 것은 행 삭제이며, 무엇을 지웠는지(이름·크기·SHA-256)는 감사 기록에 남는다.
--  · 파일의 조직은 요청의 조직과 같아야 하고(REQUEST_ATTACHMENT_ORG_MISMATCH), 파일·메모를 남긴 사람은 요청 작성자여야 한다(REQUEST_EVIDENCE_NOT_OWNER).
--  · 메모의 요청 id는 바꿀 수 없다(REQUEST_EVIDENCE_NOTE_KEY_IMMUTABLE).
-- 요청이 없는 id로 넣으면 트리거는 지나가고 외래 키 검사가 거부한다.
CREATE TABLE request_attachments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES withdrawal_requests(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  file_name TEXT NOT NULL CHECK (length(file_name) BETWEEN 1 AND 120),
  content_type TEXT NOT NULL CHECK (content_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  added_by TEXT NOT NULL REFERENCES users(id),
  added_at TEXT NOT NULL,
  content BLOB NOT NULL CHECK (typeof(content) = 'blob' AND length(content) = size_bytes),
  UNIQUE (request_id, sha256)
);
CREATE INDEX request_attachments_by_request ON request_attachments(request_id, added_at);

CREATE TRIGGER request_attachments_no_update BEFORE UPDATE ON request_attachments BEGIN SELECT RAISE(ABORT, 'REQUEST_ATTACHMENT_IMMUTABLE'); END;
CREATE TRIGGER request_attachments_guard_insert BEFORE INSERT ON request_attachments BEGIN
  SELECT RAISE(ABORT, 'REQUEST_EVIDENCE_LOCKED') FROM withdrawal_requests r WHERE r.id = NEW.request_id AND r.status NOT IN ('DRAFT', 'REVIEW');
  SELECT RAISE(ABORT, 'REQUEST_ATTACHMENT_ORG_MISMATCH') FROM withdrawal_requests r WHERE r.id = NEW.request_id AND NEW.org_id IS NOT r.org_id;
  SELECT RAISE(ABORT, 'REQUEST_EVIDENCE_NOT_OWNER') FROM withdrawal_requests r WHERE r.id = NEW.request_id AND NEW.added_by IS NOT r.created_by;
END;
CREATE TRIGGER request_attachments_guard_delete BEFORE DELETE ON request_attachments BEGIN
  SELECT RAISE(ABORT, 'REQUEST_EVIDENCE_LOCKED') FROM withdrawal_requests r WHERE r.id = OLD.request_id AND r.status NOT IN ('DRAFT', 'REVIEW');
END;

CREATE TABLE request_evidence_notes (
  request_id TEXT PRIMARY KEY REFERENCES withdrawal_requests(id),
  note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 300),
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE TRIGGER request_evidence_notes_guard_insert BEFORE INSERT ON request_evidence_notes BEGIN
  SELECT RAISE(ABORT, 'REQUEST_EVIDENCE_LOCKED') FROM withdrawal_requests r WHERE r.id = NEW.request_id AND r.status NOT IN ('DRAFT', 'REVIEW');
  SELECT RAISE(ABORT, 'REQUEST_EVIDENCE_NOT_OWNER') FROM withdrawal_requests r WHERE r.id = NEW.request_id AND NEW.updated_by IS NOT r.created_by;
END;
CREATE TRIGGER request_evidence_notes_guard_update BEFORE UPDATE ON request_evidence_notes BEGIN
  SELECT RAISE(ABORT, 'REQUEST_EVIDENCE_NOTE_KEY_IMMUTABLE') WHERE NEW.request_id IS NOT OLD.request_id;
  SELECT RAISE(ABORT, 'REQUEST_EVIDENCE_LOCKED') FROM withdrawal_requests r WHERE r.id = OLD.request_id AND r.status NOT IN ('DRAFT', 'REVIEW');
  SELECT RAISE(ABORT, 'REQUEST_EVIDENCE_NOT_OWNER') FROM withdrawal_requests r WHERE r.id = OLD.request_id AND NEW.updated_by IS NOT r.created_by;
END;
CREATE TRIGGER request_evidence_notes_guard_delete BEFORE DELETE ON request_evidence_notes BEGIN
  SELECT RAISE(ABORT, 'REQUEST_EVIDENCE_LOCKED') FROM withdrawal_requests r WHERE r.id = OLD.request_id AND r.status NOT IN ('DRAFT', 'REVIEW');
END;
