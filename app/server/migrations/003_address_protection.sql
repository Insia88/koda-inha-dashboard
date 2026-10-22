-- 주소 오염(앞·뒤만 같은 가짜 주소) 대응: 등록·확인 때의 점검 결과와 유사 주소 등록 사유를 남긴다.
-- check_findings: 등록 시 서버 점검 결과(JSON 배열, 유사 주소 일치 목록 포함). 확인(승인) 때 다시 점검한 결과를 합친다.
-- lookalike_reason: 비슷한 기존 주소가 있는데도 등록한 사유. 유사 주소가 없으면 NULL.
-- 기존 행은 NULL로 남는다(이 규칙 도입 전 등록분).
ALTER TABLE address_book ADD COLUMN check_findings TEXT;
ALTER TABLE address_book ADD COLUMN lookalike_reason TEXT;
