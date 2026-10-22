-- 승인 대상 지문(F10)과 출금 전 점검(F8·F13·F14) (WP-11). 005 이후에 실행된다(파일 이름 순서).
-- 기존 표(withdrawal_requests·approvals)에는 열을 더하지 않고, 추가만 가능한 짝 표 두 개를 둔다.
-- 기존 표의 모양이 그대로여야 하는 저장(열 이름 없이 값만 넣는 승인 기록, 이전 마이그레이션 검사의 전체 열 비교)이 깨지지 않고,
-- 지문·점검 기록은 한 번 쓰면 바꿀 수 없다(아래 트리거).
--
-- 1) request_intents: 승인 요청(제출) 때 한 번 남기는 기록. 요청 한 건에 한 행.
--    intent_hash: 승인 대상 지문(16진수 64자, SHA-256). 정규화 JSON
--      {v, requestId, orgId, assetCode, networkCode, amountUnits, addressId, address, memo, requiredApprovals}의 해시
--      (server/domain/checks.ts intentHashOf). intent_version은 그 계산 방식 버전(v).
--    pre_checks: 제출 때의 출금 전 점검 결과와 요청자 진행 사유(JSON {version, evaluatedAt, items}).
--    reserved_wallet_id·reserved_asset_code·reserved_units: 제출 때 실제로 예약한 지갑·자산·수량(최소 단위 정수 문자열).
--      반려·취소·처리 결과 반영은 지금 요청 행의 값이 아니라 이 값으로 예약을 푼다. 승인 요청 뒤 저장 계층에서 수량이 바뀐 요청
--      (INTENT_TAMPERED)도 반려·취소할 수 있고, 다른 요청의 예약 수량이 함께 풀리거나 남지 않게 하기 위함이다.
--    이 기능 도입 전에 제출된 요청은 행이 없다. 그런 승인 대기 요청은 대조할 지문이 없어 승인할 수 없고(fail closed) 반려·취소만 된다.
-- 2) approval_intents: 승인·반려 표마다 그 사람이 결정할 때 본 지문. 승인 기록 한 건에 한 행.
--    지문이 없는 이전 요청의 반려 표는 intent_hash가 NULL이다.
CREATE TABLE request_intents (
  request_id TEXT PRIMARY KEY REFERENCES withdrawal_requests(id),
  intent_version INTEGER NOT NULL,
  intent_hash TEXT NOT NULL CHECK (length(intent_hash) = 64),
  pre_checks TEXT,
  reserved_wallet_id TEXT NOT NULL,
  reserved_asset_code TEXT NOT NULL,
  reserved_units TEXT NOT NULL CHECK (length(reserved_units) > 0 AND reserved_units NOT GLOB '*[^0-9]*'),
  created_at TEXT NOT NULL
);
CREATE TRIGGER request_intents_no_update BEFORE UPDATE ON request_intents BEGIN SELECT RAISE(ABORT, 'REQUEST_INTENT_IMMUTABLE'); END;
CREATE TRIGGER request_intents_no_delete BEFORE DELETE ON request_intents BEGIN SELECT RAISE(ABORT, 'REQUEST_INTENT_IMMUTABLE'); END;

CREATE TABLE approval_intents (
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  intent_hash TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, user_id),
  FOREIGN KEY (request_id, user_id) REFERENCES approvals(request_id, user_id)
);
CREATE TRIGGER approval_intents_no_update BEFORE UPDATE ON approval_intents BEGIN SELECT RAISE(ABORT, 'APPROVALS_IMMUTABLE'); END;
CREATE TRIGGER approval_intents_no_delete BEFORE DELETE ON approval_intents BEGIN SELECT RAISE(ABORT, 'APPROVALS_IMMUTABLE'); END;
