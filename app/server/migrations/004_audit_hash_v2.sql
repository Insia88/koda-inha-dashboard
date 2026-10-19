-- 감사 기록 해시 v2: 행마다 해시 방식을 남긴다.
-- 기존 행은 1(구분자 연결 방식, 수행자 이름 제외)로 남고 다시 계산하지 않는다.
-- 새 행은 writeAudit이 2(수행자 이름 포함, JSON 배열 인코딩)로 기록한다.
-- DDL만 바꾼다. 추가 전용 트리거(audit_no_update, audit_no_delete)는 그대로 둔다.
ALTER TABLE audit_log ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1;
