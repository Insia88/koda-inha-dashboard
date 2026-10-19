import { randomUUID } from 'node:crypto';

/**
 * 커스터디 처리 어댑터. 운영 연동은 제공되지 않았으므로 개발용 모의 구현만 있다.
 * 모의 구현은 실제 블록체인 전송·서명·키 접근을 하지 않는다.
 *
 * 멱등 계약: 같은 idempotencyKey로 다시 호출하면 새 출금을 만들지 않고 처음 접수한 참조를 돌려줘야 한다.
 * 호출 측은 요청 id를 키로 넘긴다. 승인 트랜잭션이 커스터디 호출 뒤에 실패해 되돌려지고 다시 시도되어도
 * 같은 출금이 두 번 접수되지 않게 하기 위함이다. 운영 연동에는 아웃박스와 KODA 측 멱등 처리가 따로 필요하다.
 */
export interface WithdrawalSubmission {
  requestId: string;
  /** 필수. 같은 출금을 다시 보낼 때 같은 값을 쓴다(요청 id). */
  idempotencyKey: string;
  assetCode: string;
  networkCode: string;
  amountUnits: string;
  address: string;
  memo: string;
}

export interface CustodyAdapter {
  readonly name: string;
  readonly isMock: boolean;
  submitWithdrawal(input: WithdrawalSubmission): { ref: string };
  getStatus(ref: string, startedAt: string): 'processing' | 'completed' | 'failed';
}

export class MockCustodyAdapter implements CustodyAdapter {
  readonly name = '모의 커스터디(개발용)';
  readonly isMock = true;
  /** 멱등 키 → 접수 참조. 같은 키로 다시 오면 같은 참조를 돌려준다. */
  private readonly accepted = new Map<string, string>();
  constructor(private processingMs: number) {}
  submitWithdrawal(input: WithdrawalSubmission) {
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || key.length === 0) throw new Error('CUSTODY_IDEMPOTENCY_KEY_REQUIRED');
    const prev = this.accepted.get(key);
    if (prev) return { ref: prev };
    const ref = `MOCK-CUSTODY-${randomUUID().slice(0, 8).toUpperCase()}`;
    this.accepted.set(key, ref);
    return { ref };
  }
  /** 서로 다른 멱등 키로 접수된 출금 수 (테스트 확인용, 읽기 전용) */
  get submissions(): number {
    return this.accepted.size;
  }
  getStatus(_ref: string, startedAt: string) {
    return Date.now() - Date.parse(startedAt) >= this.processingMs ? 'completed' : 'processing';
  }
}
