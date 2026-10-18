// 화면·서버 오류 메시지에서 같은 용어를 쓰기 위한 단일 출처.

export type RequestStatus =
  | 'DRAFT' | 'REVIEW' | 'PENDING_APPROVAL' | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'FAILED';

export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

export const REQUEST_STATUS: Record<RequestStatus, { label: string; tone: Tone; description: string; step: number }> = {
  DRAFT: { label: '작성 중', tone: 'neutral', step: 0, description: '요청자가 내용을 작성하고 있습니다. 아직 승인자에게 전달되지 않았습니다.' },
  REVIEW: { label: '검토 중', tone: 'info', step: 1, description: '요청자가 받는 주소와 수량을 최종 대조하는 단계입니다. 확인을 마치면 승인 요청을 보냅니다.' },
  PENDING_APPROVAL: { label: '승인 대기', tone: 'warning', step: 2, description: '요청자가 아닌 승인자의 승인을 기다립니다. 출금 수량은 예약되어 다른 요청에 쓸 수 없습니다.' },
  PROCESSING: { label: '처리 중', tone: 'info', step: 3, description: '승인이 끝나 커스터디 처리 중입니다. 이 단계부터는 취소할 수 없습니다.' },
  COMPLETED: { label: '처리 완료', tone: 'success', step: 3, description: '처리가 끝났습니다. 블록체인 전송은 되돌릴 수 없습니다.' },
  REJECTED: { label: '반려', tone: 'danger', step: 3, description: '승인자가 반려했습니다. 반려 사유를 확인하고 필요하면 새 요청을 작성하세요.' },
  CANCELLED: { label: '취소', tone: 'neutral', step: 3, description: '요청자가 취소했습니다. 예약된 수량은 해제되었습니다.' },
  FAILED: { label: '처리 실패', tone: 'danger', step: 3, description: '처리 중 문제가 생겨 완료되지 않았습니다. 예약 수량은 해제되었습니다. 실패 사유를 확인하세요.' },
};

export const REQUEST_STEPS = ['작성', '검토', '승인 대기', '처리 결과'] as const;

export type AddressStatus = 'PENDING_REVIEW' | 'ACTIVE' | 'REJECTED' | 'DISABLED';
export const ADDRESS_STATUS: Record<AddressStatus, { label: string; tone: Tone; description: string }> = {
  PENDING_REVIEW: { label: '확인 대기', tone: 'warning', description: '등록자가 아닌 다른 담당자의 확인을 기다립니다. 확인 전에는 출금 요청에 쓸 수 없습니다.' },
  ACTIVE: { label: '사용 가능', tone: 'success', description: '두 사람이 입력 내용을 확인했습니다. 주소의 소유자나 안전성을 보증하는 표시는 아닙니다.' },
  REJECTED: { label: '등록 거절', tone: 'danger', description: '확인 담당자가 등록을 거절했습니다. 사유를 확인하고 다시 등록하세요.' },
  DISABLED: { label: '사용 중지', tone: 'neutral', description: '더 이상 출금 요청에 쓸 수 없는 주소입니다.' },
};

export type Role = 'admin' | 'requester' | 'approver' | 'auditor' | 'operator';
export const ROLE_LABEL: Record<Role, { label: string; description: string }> = {
  requester: { label: '자산 담당자', description: '주소 등록과 출금 요청을 작성합니다.' },
  approver: { label: '승인자', description: '다른 사람이 만든 요청과 주소를 확인하고 승인하거나 반려합니다.' },
  auditor: { label: '감사 담당자', description: '모든 기록을 조회하고 감사 기록을 내보냅니다. 변경 권한은 없습니다.' },
  admin: { label: '조직 관리자', description: '구성원과 역할을 관리합니다.' },
  operator: { label: 'KODA 운영자', description: 'Market Insight 자료를 선별해 게시합니다.' },
};

export const TX_TYPE: Record<string, string> = {
  deposit: '입금',
  withdrawal: '출금',
  staking_reward: '스테이킹 보상',
};

export const TX_STATUS: Record<string, { label: string; tone: Tone }> = {
  completed: { label: '완료', tone: 'success' },
  processing: { label: '처리 중', tone: 'info' },
  failed: { label: '실패', tone: 'danger' },
};

export const GLOSSARY: Record<string, string> = {
  network: '자산이 오가는 블록체인입니다. 같은 자산이라도 네트워크가 다르면 받는 쪽에서 찾지 못해 회수가 어려울 수 있습니다.',
  memo: '거래소 등 하나의 주소를 여러 고객이 함께 쓰는 곳에서 받는 사람을 구분하는 값입니다. 요구하는 곳에 빠뜨리면 입금이 확인되지 않을 수 있습니다.',
  reserved: '승인 대기 중인 출금 요청에 묶여 있는 수량입니다. 요청이 반려·취소되면 다시 사용할 수 있습니다.',
  available: '보유 수량에서 예약 수량을 뺀, 새 요청에 쓸 수 있는 수량입니다.',
  valuation: '모의 시세로 계산한 참고용 원화 평가액입니다. 실제 매도 가능 금액이 아닙니다.',
};
