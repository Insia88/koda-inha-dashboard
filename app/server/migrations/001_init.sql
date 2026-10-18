-- KODA 법인 대시보드 개발용 스키마. 금액·수량은 자산 최소 단위의 정수를 TEXT로 저장한다.

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('customer','operator')),
  is_mock INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  roles_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE user_roles (
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin','requester','approver','auditor','operator')),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE assets (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  precision INTEGER NOT NULL CHECK (precision BETWEEN 0 AND 18)
);

CREATE TABLE networks (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  memo_required INTEGER NOT NULL DEFAULT 0,
  memo_label TEXT
);

CREATE TABLE asset_networks (
  asset_code TEXT NOT NULL REFERENCES assets(code),
  network_code TEXT NOT NULL REFERENCES networks(code),
  PRIMARY KEY (asset_code, network_code)
);

CREATE TABLE prices (
  asset_code TEXT PRIMARY KEY REFERENCES assets(code),
  krw_price TEXT NOT NULL,
  as_of TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  network_code TEXT NOT NULL REFERENCES networks(code),
  deposit_address TEXT NOT NULL,
  deposit_memo TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE balances (
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  asset_code TEXT NOT NULL REFERENCES assets(code),
  total_units TEXT NOT NULL,
  reserved_units TEXT NOT NULL DEFAULT '0',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (wallet_id, asset_code)
);

CREATE TABLE address_book (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  label TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  asset_code TEXT NOT NULL REFERENCES assets(code),
  network_code TEXT NOT NULL REFERENCES networks(code),
  address TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('PENDING_REVIEW','ACTIVE','REJECTED','DISABLED')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  review_note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (reviewed_by IS NULL OR reviewed_by <> created_by)
);
CREATE UNIQUE INDEX address_book_unique_live ON address_book(org_id, asset_code, network_code, address, memo)
  WHERE status IN ('PENDING_REVIEW','ACTIVE');

CREATE TABLE withdrawal_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  ref_no TEXT NOT NULL UNIQUE,
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
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX withdrawal_idem ON withdrawal_requests(org_id, created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX withdrawal_org_status ON withdrawal_requests(org_id, status);

CREATE TABLE approvals (
  request_id TEXT NOT NULL REFERENCES withdrawal_requests(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (request_id, user_id)
);
-- 저장 계층에서도 자기 요청 승인을 막는다.
CREATE TRIGGER approvals_no_self BEFORE INSERT ON approvals
WHEN NEW.user_id = (SELECT created_by FROM withdrawal_requests WHERE id = NEW.request_id)
BEGIN SELECT RAISE(ABORT, 'SELF_APPROVAL_FORBIDDEN'); END;
CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, 'APPROVALS_IMMUTABLE'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT, 'APPROVALS_IMMUTABLE'); END;

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  type TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','staking_reward')),
  asset_code TEXT NOT NULL REFERENCES assets(code),
  network_code TEXT NOT NULL REFERENCES networks(code),
  amount_units TEXT NOT NULL,
  counterparty TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','processing','failed')),
  occurred_at TEXT NOT NULL,
  request_id TEXT REFERENCES withdrawal_requests(id),
  tx_ref TEXT NOT NULL
);
CREATE INDEX transactions_org_time ON transactions(org_id, occurred_at DESC);

CREATE TABLE staking_positions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  asset_code TEXT NOT NULL REFERENCES assets(code),
  network_code TEXT NOT NULL REFERENCES networks(code),
  validator_label TEXT NOT NULL,
  staked_units TEXT NOT NULL,
  reward_units_30d TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','unbonding')),
  started_at TEXT NOT NULL
);

CREATE TABLE insight_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_whitelisted INTEGER NOT NULL,
  homepage TEXT NOT NULL
);

CREATE TABLE insights (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES insight_providers(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('ko','en')),
  published_at TEXT NOT NULL,
  url TEXT NOT NULL,
  asset_tags TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('published','hidden')),
  curated_by TEXT REFERENCES users(id),
  curated_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL,
  route TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, route, key)
);

-- 감사 기록: 추가만 가능. 조직별 해시 체인으로 변조를 감지한다.
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX audit_org_seq ON audit_log(org_id, seq DESC);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_APPEND_ONLY'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'AUDIT_LOG_APPEND_ONLY'); END;