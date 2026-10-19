-- 요청 번호(ref_no)를 조직마다 따로 매긴다. 006 이후에 실행된다(파일 이름 순서).
-- 이전에는 전체 요청 수 + 1로 번호를 매기고 ref_no 하나에 고유 제약이 있어, 다른 조직의 요청량이 번호 간격으로 드러났다
-- (예: 조직 B의 첫 요청이 WR-000007). 새 번호는 server/domain/requests.ts nextRefNo가 조직 안에서 매기고, 고유 제약은 (org_id, ref_no)로 바꾼다.
-- 이미 매긴 번호는 바꾸지 않는다. 시드는 모의법인 A에만 요청이 있어 A의 번호는 그대로다.
--
-- 표의 고유 제약은 ALTER로 바꿀 수 없어 withdrawal_requests를 다시 만든다. 열 이름·순서·기본값·제약은 001·002와 같고, ref_no의 고유 제약만 바뀐다.
-- approvals·transactions·request_intents가 이 표를 참조하므로 005와 같이 외래 키 검사를 이 트랜잭션 끝(COMMIT)까지 미룬다.
-- 표를 지울 때 생긴 참조 위반은 같은 id로 행을 다시 넣으면서 사라지므로 COMMIT 때 위반이 남지 않는다.
-- withdrawal_requests에는 트리거·뷰가 없다(approvals_no_self 트리거는 approvals 표에 있고 이 표를 이름으로 읽으므로 그대로 동작한다). 인덱스는 다시 만든다.
PRAGMA defer_foreign_keys = ON;

CREATE TEMP TABLE withdrawal_requests_007_copy AS SELECT * FROM withdrawal_requests;
DROP TABLE withdrawal_requests;

CREATE TABLE withdrawal_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ref_no TEXT NOT NULL,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  asset_code TEXT NOT NULL REFERENCES assets(code),
  network_code TEXT NOT NULL REFERENCES networks(code),
  amount_units TEXT NOT NULL,
  address_id TEXT NOT NULL REFERENCES address_book(id),
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','REVIEW','PENDING_APPROVAL','PROCESSING','COMPLETED','REJECTED','CANCELLED','FAILED')),
  required_approvals INTEGER NOT NULL DEFAULT 1,
  krw_value_at_submit TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  processing_started_at TEXT,
  completed_at TEXT,
  reject_reason TEXT,
  failure_reason TEXT,
  custody_ref TEXT,
  idempotency_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  approval_basis TEXT,
  price_as_of_at_submit TEXT,
  counted_approver_ids TEXT,
  UNIQUE (org_id, ref_no)
);

INSERT INTO withdrawal_requests (id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, required_approvals, krw_value_at_submit,
    created_by, created_at, updated_at, submitted_at, processing_started_at, completed_at, reject_reason, failure_reason, custody_ref, idempotency_key, version,
    approval_basis, price_as_of_at_submit, counted_approver_ids)
  SELECT id, org_id, ref_no, wallet_id, asset_code, network_code, amount_units, address_id, purpose, status, required_approvals, krw_value_at_submit,
    created_by, created_at, updated_at, submitted_at, processing_started_at, completed_at, reject_reason, failure_reason, custody_ref, idempotency_key, version,
    approval_basis, price_as_of_at_submit, counted_approver_ids
    FROM withdrawal_requests_007_copy;
DROP TABLE withdrawal_requests_007_copy;

CREATE UNIQUE INDEX withdrawal_idem ON withdrawal_requests(org_id, created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX withdrawal_org_status ON withdrawal_requests(org_id, status);
