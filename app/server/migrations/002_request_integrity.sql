-- 출금 승인 무결성 (WP-02). 컬럼 추가만 하며 003·004 마이그레이션과 순서가 바뀌어도 동작한다.
-- approval_basis: 제출 시 필요 승인 수를 정한 근거
--   'value_below_threshold' | 'value_at_or_above_threshold' | 'price_missing' | 'price_stale'
-- price_as_of_at_submit: 제출 시 쓴 모의 시세의 기준 시각 (시세가 없으면 NULL)
-- counted_approver_ids: 요청이 마지막으로 결정될 때(승인·반려·취소) 정족수에 들어간 승인자 id의 JSON 배열.
--   승인 대기가 끝난 요청의 승인 기록이 이후 역할 변경으로 바뀌어 보이지 않도록 남긴다.
ALTER TABLE withdrawal_requests ADD COLUMN approval_basis TEXT;
ALTER TABLE withdrawal_requests ADD COLUMN price_as_of_at_submit TEXT;
ALTER TABLE withdrawal_requests ADD COLUMN counted_approver_ids TEXT;
