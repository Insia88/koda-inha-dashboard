-- 주소 수명 주기 보호 (WP-10). 003 이후에 실행된다(파일 이름 순서).
-- 1) 사용 대기(COOLING_DOWN): 두 번째 사람이 확인한 주소는 active_from이 지나야 사용 가능(ACTIVE)이 된다.
--    대기 시간은 policy.addressBook.cooldownHours(설계 가정). 0이면 예전처럼 확인 즉시 사용 가능이다.
-- 2) 다른 경로 확인 기록: received_via(주소를 받은 경로) / verified_via(다시 확인한 경로) / verified_with(확인한 상대·연락처).
--    이 규칙 도입 전 등록분은 NULL로 남는다.
-- 3) 정지 기록: disabled_by·disabled_at·disabled_reason. 사용 대기 중 정지는 사유를 남긴다.
-- 4) 주소 오염(0원·소액 입금) 점검: transactions.counterparty_address(입금을 보낸 주소, 없으면 NULL).
--
-- status의 CHECK 제약은 ALTER로 바꿀 수 없어 address_book을 다시 만든다.
-- withdrawal_requests.address_id가 이 표를 참조하므로, 외래 키 검사를 이 트랜잭션 끝(COMMIT)까지 미룬다.
-- 표를 지울 때 생긴 참조 위반은 같은 id로 행을 다시 넣으면서 사라지므로 COMMIT 때 위반이 남지 않는다.
-- (defer_foreign_keys는 COMMIT·ROLLBACK 때 자동으로 꺼진다. 마이그레이션은 트랜잭션 안에서 실행된다: server/db.ts migrate)
-- address_book에는 트리거·뷰가 없다. 고유 인덱스는 다시 만들고, 쓰는 중인 주소(확인 대기·사용 대기·사용 가능)를 같은 기준으로 묶는다.
PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE address_book_005_copy AS SELECT * FROM address_book;
DROP TABLE address_book;

CREATE TABLE address_book (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  label TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  asset_code TEXT NOT NULL REFERENCES assets(code),
  network_code TEXT NOT NULL REFERENCES networks(code),
  address TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('PENDING_REVIEW','COOLING_DOWN','ACTIVE','REJECTED','DISABLED')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  check_findings TEXT,
  lookalike_reason TEXT,
  active_from TEXT,
  received_via TEXT CHECK (received_via IS NULL OR received_via IN ('email','messenger','document','phone','in_person','other')),
  verified_via TEXT CHECK (verified_via IS NULL OR verified_via IN ('registered_phone','in_person','video_call','signed_document','other')),
  verified_with TEXT,
  disabled_by TEXT REFERENCES users(id),
  disabled_at TEXT,
  disabled_reason TEXT,
  CHECK (reviewed_by IS NULL OR reviewed_by <> created_by),
  -- 사용 대기는 두 번째 사람의 확인과 사용 가능 시각이 있어야 한다.
  CHECK (status <> 'COOLING_DOWN' OR (reviewed_by IS NOT NULL AND active_from IS NOT NULL)),
  -- 같은 경로로 받고 확인한 기록은 남기지 않는다.
  CHECK (received_via IS NULL OR verified_via IS NULL OR received_via <> verified_via)
);

INSERT INTO address_book (id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at, reviewed_by, reviewed_at, review_note, version, check_findings, lookalike_reason)
  SELECT id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at, reviewed_by, reviewed_at, review_note, version, check_findings, lookalike_reason
    FROM address_book_005_copy;
DROP TABLE address_book_005_copy;

CREATE UNIQUE INDEX address_book_unique_live ON address_book(org_id, asset_code, network_code, address, memo)
  WHERE status IN ('PENDING_REVIEW','COOLING_DOWN','ACTIVE');
CREATE INDEX address_book_cooling ON address_book(active_from) WHERE status = 'COOLING_DOWN';

ALTER TABLE transactions ADD COLUMN counterparty_address TEXT;
CREATE INDEX transactions_counterparty_address ON transactions(org_id, occurred_at) WHERE counterparty_address IS NOT NULL;
