import { randomUUID } from 'node:crypto';

/**
 * 커스터디 처리 어댑터. 운영 연동은 제공되지 않았으므로 개발용 모의 구현만 있다.
 * 모의 구현은 실제 블록체인 전송·서명·키 접근을 하지 않는다.
 */
export interface CustodyAdapter {
  readonly name: string;
  readonly isMock: boolean;
  submitWithdrawal(input: { requestId: string; assetCode: string; networkCode: string; amountUnits: string; address: string; memo: string }): { ref: string };
  getStatus(ref: string, startedAt: string): 'processing' | 'completed' | 'failed';
}

export class MockCustodyAdapter implements CustodyAdapter {
  readonly name = '모의 커스터디(개발용)';
  readonly isMock = true;
  constructor(private processingMs: number) {}
  submitWithdrawal() {
    return { ref: `MOCK-CUSTODY-${randomUUID().slice(0, 8).toUpperCase()}` };
  }
  getStatus(_ref: string, startedAt: string) {
    return Date.now() - Date.parse(startedAt) >= this.processingMs ? 'completed' : 'processing';
  }
}
