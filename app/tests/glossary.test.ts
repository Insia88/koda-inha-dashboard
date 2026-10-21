import { describe, expect, it } from 'vitest';
import { ACTION_LABEL, actionLabel, ADDRESS_STATUS, GLOSSARY, GLOSSARY_LABEL, REQUEST_STATUS, ROLE_LABEL, type GlossaryKey } from '../shared/terms.ts';

// 용어·상태 설명의 단일 출처(shared/terms.ts)가 DASH-002 기준과 프로젝트 문구 규칙을 지키는지 확인한다.
// 사람이 이해하는지는 이 테스트로 알 수 없다(사용자 검증 아님).

/** WP-07에서 추가한 용어와 기존 용어. 화면 Term 버튼과 문서가 이 키를 쓴다. */
const REQUIRED_KEYS: GlossaryKey[] = [
  'network', 'memo', 'reserved', 'available', 'valuation',
  'custody', 'whitelist', 'staking', 'validator', 'unbonding', 'destinationTag', 'irreversible', 'approvalCount', 'token',
];
const REQUIRED_LABELS = ['커스터디 처리', '화이트리스트', '스테이킹', '검증인', '해제 대기', '데스티네이션 태그', '되돌릴 수 없는 전송', '승인 x/y'];

/** 검증할 수 없는 안전을 보장하는 표현. '보증하는 표시는 아닙니다' 같은 부정 표현은 걸리지 않는다. */
const POSITIVE_SAFETY_CLAIM = /안전합니다|안전한 주소|검증됨|보장합니다/;

const statusTexts = [
  ...Object.entries(REQUEST_STATUS).map(([k, v]) => [`REQUEST_STATUS.${k}`, v.description] as const),
  ...Object.entries(ADDRESS_STATUS).map(([k, v]) => [`ADDRESS_STATUS.${k}`, v.description] as const),
];
const glossaryTexts = Object.entries(GLOSSARY).map(([k, v]) => [`GLOSSARY.${k}`, v] as const);
const roleTexts = Object.entries(ROLE_LABEL).map(([k, v]) => [`ROLE_LABEL.${k}`, v.description] as const);
const allTexts = [...statusTexts, ...glossaryTexts, ...roleTexts];
const allLabels = [
  ...Object.values(REQUEST_STATUS).map((v) => v.label),
  ...Object.values(ADDRESS_STATUS).map((v) => v.label),
  ...Object.values(GLOSSARY_LABEL),
];

describe('상태 설명', () => {
  it('every request and address status has a non-empty label and description', () => {
    for (const [k, v] of Object.entries(REQUEST_STATUS)) {
      expect(v.label.trim(), k).not.toBe('');
      expect(v.description.trim().length, k).toBeGreaterThan(10);
    }
    for (const [k, v] of Object.entries(ADDRESS_STATUS)) {
      expect(v.label.trim(), k).not.toBe('');
      expect(v.description.trim().length, k).toBeGreaterThan(10);
    }
  });

  it('keeps the status labels the screens and e2e checks rely on', () => {
    expect(Object.fromEntries(Object.entries(REQUEST_STATUS).map(([k, v]) => [k, v.label]))).toEqual({
      DRAFT: '작성 중', REVIEW: '검토 중', PENDING_APPROVAL: '승인 대기', PROCESSING: '처리 중',
      COMPLETED: '처리 완료', REJECTED: '반려', CANCELLED: '취소', FAILED: '처리 실패',
    });
    expect(Object.fromEntries(Object.entries(ADDRESS_STATUS).map(([k, v]) => [k, v.label]))).toEqual({
      PENDING_REVIEW: '확인 대기', COOLING_DOWN: '사용 대기', ACTIVE: '사용 가능', REJECTED: '등록 거절', DISABLED: '사용 중지',
    });
  });

  it('says whose turn each open status is (display-only turn text, A1) and leaves it empty for finished requests', () => {
    expect(Object.fromEntries(Object.entries(REQUEST_STATUS).map(([k, v]) => [k, v.turn]))).toEqual({
      DRAFT: '요청자 작성 중', REVIEW: '요청자 최종 확인 중', PENDING_APPROVAL: '승인자 결정 대기', PROCESSING: '수탁사 처리 중',
      COMPLETED: '', REJECTED: '', CANCELLED: '', FAILED: '',
    });
    for (const [k, v] of Object.entries(REQUEST_STATUS)) expect(v.turn, k).not.toMatch(POSITIVE_SAFETY_CLAIM);
  });

  it("defines 처리 중 as the custodian's step, run here by the mock custody, after which cancelling is not possible", () => {
    const d = REQUEST_STATUS.PROCESSING.description;
    expect(d).toContain('수탁사');
    expect(d).toContain('모의 커스터디');
    expect(d).toContain('취소할 수 없습니다');
  });

  it("defines 처리 완료 as the mock custody's report, with the completion basis left to KODA", () => {
    const d = REQUEST_STATUS.COMPLETED.description;
    expect(d).toContain('모의 커스터디');
    expect(d).toContain('KODA');
    expect(d).toContain('되돌릴 수 없습니다');
  });
});

describe('용어 설명(GLOSSARY)', () => {
  it('has every required key with a label and an explanation', () => {
    for (const k of REQUIRED_KEYS) {
      expect(GLOSSARY[k]?.trim().length ?? 0, k).toBeGreaterThan(20);
      expect(GLOSSARY_LABEL[k]?.trim().length ?? 0, k).toBeGreaterThan(0);
    }
    expect(Object.values(GLOSSARY_LABEL)).toEqual(expect.arrayContaining(REQUIRED_LABELS));
    expect(Object.keys(GLOSSARY).sort()).toEqual(Object.keys(GLOSSARY_LABEL).sort());
  });

  it('carries no unverified regulatory dates', () => {
    for (const [k, t] of glossaryTexts) {
      expect(t, k).not.toMatch(/(?:19|20)\d{2}\s*(?:[-./]|년)/);
    }
  });
});

describe('감사 기록 행동 이름(ACTION_LABEL)', () => {
  it('names every security-relevant request record, including a decision refused for a different fingerprint', () => {
    for (const a of ['request.intent_tampered', 'request.intent_mismatch']) {
      expect(ACTION_LABEL[a]?.trim().length ?? 0, a).toBeGreaterThan(0);
      expect(actionLabel(a), a).not.toBe(a); // 화면과 CSV가 코드 대신 이름을 보인다
    }
    expect(ACTION_LABEL['request.intent_mismatch']).not.toBe(ACTION_LABEL['request.intent_tampered']);
  });

  it('makes no safety claim and uses no implementation terms in any action label', () => {
    for (const [k, l] of Object.entries(ACTION_LABEL)) {
      expect(l.trim(), k).not.toBe('');
      expect(l, k).not.toMatch(POSITIVE_SAFETY_CLAIM);
      expect(l, k).not.toMatch(/서버|config|\.json|API|hash|intent/i);
    }
  });
});

describe('문구 규칙', () => {
  it('makes no positive safety claim in any status, glossary or role text', () => {
    for (const [k, t] of allTexts) expect(t, k).not.toMatch(POSITIVE_SAFETY_CLAIM);
    for (const l of allLabels) expect(l).not.toMatch(POSITIVE_SAFETY_CLAIM);
    for (const [k, v] of Object.entries(REQUEST_STATUS)) expect(v.turn, `REQUEST_STATUS.${k}.turn`).not.toMatch(POSITIVE_SAFETY_CLAIM);
  });

  it("allows the word '안전' only in a negated sentence", () => {
    for (const [k, t] of allTexts) {
      for (const sentence of t.split(/(?<=[다요]\.)\s*/)) {
        if (sentence.includes('안전')) expect(sentence, k).toMatch(/아닙니다|않습니다|없습니다/);
      }
    }
    // 기존 부정 표현은 그대로 허용된다.
    expect(ADDRESS_STATUS.ACTIVE.description).toContain('보증하는 표시는 아닙니다');
  });

  it('uses the formal tone (-니다, or -세요 for an instruction) and no implementation details', () => {
    for (const [k, t] of allTexts) {
      expect(t.trim(), k).toMatch(/(?:니다|세요)\.$/);
      expect(t, k).not.toMatch(/서버|config|\.json|\.tsx?\b|API|DB_|localhost/i);
    }
  });
});
