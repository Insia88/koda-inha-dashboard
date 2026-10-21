import { z } from 'zod';
import { RECEIVED_VIA_VALUES, VERIFIED_VIA_VALUES } from './terms.ts';
import { cleanText, isWellFormedText, reasonError } from './text.ts';

// 사유·메모·이름의 보이지 않는 문자 제거와 필수 사유 점검은 화면도 같이 쓰므로 zod를 쓰지 않는 shared/text.ts에 둔다.
// 깨진 문자 판정(isWellFormedText)은 화면도 쓰므로(지급 근거 파일 이름 정리, shared/attachments.ts) 같은 파일에 두고 여기서 다시 내보낸다.
export { cleanText, isWellFormedText, letterDigitCount, REASON_MIN_LETTERS, reasonError, stripFormatChars } from './text.ts';

/** 깨진 문자(짝 없는 서로게이트)가 든 입력에 붙이는 항목 오류 문구 */
export const brokenTextMessage = (label: string) => `${label}에 깨진 문자(잘린 이모지 등)가 들어 있습니다. 그 부분을 지우고 다시 입력하세요.`;

/** 자유 입력 문자열: 기존 길이·공백 규칙은 그대로 두고, 깨진 문자가 있으면 항목 오류로 거절한다. */
const text = (schema: z.ZodString, label: string) => schema.refine(isWellFormedText, brokenTextMessage(label));

const trimmed = (max: number, label: string) =>
  text(z.string().trim().min(1, `${label}을(를) 입력하세요.`).max(max, `${label}은(는) ${max}자 이내로 입력하세요.`), label);

/**
 * 깨진 문자를 먼저 거절하고, 보이지 않는 서식 문자를 지운 값(cleanText)으로 길이 규칙을 본다. 결과 값도 지운 값이다.
 * 깨진 문자가 있으면 그 오류 하나만 낸다(뒤 규칙은 보지 않는다).
 */
const cleaned = (label: string, rest: z.ZodType<string, string>) =>
  z.string().refine(isWellFormedText, brokenTextMessage(label)).transform(cleanText).pipe(rest);

/** 필수 이름·연락처 등: 서식 문자를 지운 뒤 비어 있으면 거절한다. */
const cleanedRequired = (max: number, label: string) =>
  cleaned(label, z.string().min(1, `${label}을(를) 입력하세요.`).max(max, `${label}은(는) ${max}자 이내로 입력하세요.`));

/** 선택 사유·메모: 서식 문자를 지운 값만 남긴다. 필요한 경우(유사 주소·거절)의 최소 글자 수는 처리 단계가 reasonError로 본다. */
const cleanedOptional = (max: number, label: string, maxMessage: string) =>
  cleaned(label, z.string().max(max, maxMessage)).optional().default('');

/**
 * 필수 사유(정지·반려): 서식 문자를 지운 값이 min자 이상이고 글자·숫자도 min자 이상이어야 한다.
 * 출금 전 점검의 진행 사유(server/domain/checks.ts attachCheckReasons)와 같은 기준이다.
 */
const reasonText = (o: { label: string; short: string; max: number; maxMessage: string }) =>
  cleaned(o.label, z.string().max(o.max, o.maxMessage).superRefine((s, ctx) => {
    const message = reasonError(s, { label: o.label, short: o.short });
    if (message) ctx.addIssue({ code: 'custom', message });
  }));

export const addressCheckSchema = z.object({
  assetCode: z.string().min(1, '자산을 선택하세요.').max(16),
  networkCode: z.string().min(1, '네트워크를 선택하세요.').max(32),
  address: z.string().max(200, '주소가 너무 깁니다.'),
  memo: text(z.string().max(64), '메모').optional().default(''),
});

export const addressCreateSchema = addressCheckSchema.extend({
  label: cleanedRequired(60, '주소 이름'),
  counterparty: cleanedRequired(80, '받는 곳'),
  confirmTail: z.string().trim().min(1, '주소 끝자리를 다시 입력하세요.').max(20),
  confirmMiddle: z.string().trim().min(1, '주소 가운데 8자리를 다시 입력하세요.').max(20),
  // 비슷한 주소가 있을 때만 필요하다(글자·숫자 5자 이상). 그 판단은 등록 처리(createAddress)가 한다.
  lookalikeReason: cleanedOptional(300, '등록 사유', '등록 사유는 300자 이내로 입력하세요.'),
  ackNotVerified: z.literal(true, { message: '형식 점검이 주소의 안전성을 보증하지 않는다는 점을 확인하세요.' }),
  ackOutOfBandConfirmed: z.literal(true, { message: '받는 곳과 별도 연락 수단으로 주소를 대조했는지 확인하세요.' }),
  // 다른 경로 확인 기록: 어느 경로로 주소를 받았고, 그와 다른 어느 경로로 누구와 다시 확인했는지 남긴다.
  // 두 경로가 같은지는 등록 처리(createAddress)가 OUT_OF_BAND_SAME_CHANNEL로 거절한다.
  receivedVia: z.enum(RECEIVED_VIA_VALUES, { message: '주소를 받은 경로를 고르세요.' }),
  verifiedVia: z.enum(VERIFIED_VIA_VALUES, { message: '주소를 다시 확인한 경로를 고르세요.' }),
  verifiedWith: cleanedRequired(100, '확인한 상대·연락처'),
});

/** 사용 대기 중 정지: 위험을 줄이는 행동이라 바로 적용하되, 왜 멈췄는지 남긴다(글자·숫자 5자 이상). */
export const addressStopSchema = z.object({
  version: z.number().int().positive(),
  reason: reasonText({ label: '정지 사유', short: '정지 사유를 5자 이상 입력하세요.', max: 300, maxMessage: '정지 사유는 300자 이내로 입력하세요.' }),
});

export const addressReviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  // 거절할 때와 비슷한 기존 주소가 있을 때만 필요하다(글자·숫자 5자 이상). 그 판단은 확인 처리(reviewAddress)가 한다.
  note: cleanedOptional(500, '메모', '메모는 500자 이내로 입력하세요.'),
  version: z.number().int().positive(),
  confirmTail: z.string().trim().max(20).optional().default(''),
  confirmMiddle: z.string().trim().max(20).optional().default(''),
});

export const versionSchema = z.object({ version: z.number().int().positive() });

export const requestDraftSchema = z.object({
  assetCode: z.string().min(1, '자산을 선택하세요.').max(16),
  networkCode: z.string().min(1, '네트워크를 선택하세요.').max(32),
  addressId: z.string().min(1, '받는 주소를 선택하세요.').max(64),
  amount: z.string().trim().min(1, '수량을 입력하세요.').max(60),
  purpose: cleanedRequired(200, '요청 목적'),
});

export const requestUpdateSchema = requestDraftSchema.extend({ version: z.number().int().positive() });

/** 출금 전 점검 항목 id(server/domain/checks.ts). 진행 사유는 이 id를 키로 보낸다. */
export const CHECK_IDS = ['first_use', 'amount_history', 'balance_share', 'recent_burst', 'price'] as const;

export const requestSubmitSchema = z.object({
  version: z.number().int().positive(),
  confirmTail: z.string().trim().min(1, '받는 주소 끝자리를 입력하세요.').max(20),
  ackIrreversible: z.literal(true, { message: '전송 후에는 되돌릴 수 없다는 점을 확인하세요.' }),
  // 사유가 필요한 주의 항목마다 진행 사유(보이지 않는 서식 문자를 뺀 글자·숫자 5자 이상, server/domain/checks.ts attachCheckReasons).
  // 빠지거나 모자라면 서버가 422 CHECK_REASON_REQUIRED(항목별 필드 checkReasons.<id>)로 거부한다.
  checkReasons: z.partialRecord(z.enum(CHECK_IDS), text(z.string().trim().max(300, '진행 사유는 300자 이내로 입력하세요.'), '진행 사유')).optional().default({}),
});

/**
 * 승인·반려 본문의 승인 대상 지문: 요청 응답의 intentHash를 그대로 보낸다.
 * 형식만 여기서 받고, 없거나 다르면 서버가 요청 상태를 확인한 뒤 거부한다(없음 422, 다름 409 INTENT_CHANGED).
 * null은 지문이 없는 이전 요청을 반려할 때만 받는다.
 */
const intentHashField = z.string().trim().max(128, '승인 대상 지문 형식이 올바르지 않습니다.').nullable().optional();

export const requestApproveSchema = z.object({
  version: z.number().int().positive(),
  intentHash: intentHashField,
});

export const requestRejectSchema = z.object({
  version: z.number().int().positive(),
  // 서식 문자를 지운 값으로 넘긴다(rejectRequest가 이 값을 저장한다). 글자·숫자 5자 이상.
  reason: reasonText({ label: '반려 사유', short: '반려 사유를 5자 이상 입력하세요.', max: 500, maxMessage: '반려 사유는 500자 이내로 입력하세요.' }),
  intentHash: intentHashField,
});

/** 작성 화면의 출금 전 점검 미리 보기(저장하지 않음). requestId는 고치는 중인 초안 id. */
export const requestChecksPreviewSchema = z.object({
  assetCode: z.string().min(1, '자산을 선택하세요.').max(16),
  networkCode: z.string().min(1, '네트워크를 선택하세요.').max(32),
  addressId: z.string().min(1, '받는 주소를 선택하세요.').max(64),
  amount: z.string().trim().min(1, '수량을 입력하세요.').max(60),
  requestId: z.string().min(1).max(64).optional(),
});

export const roleUpdateSchema = z.object({
  roles: z.array(z.enum(['admin', 'requester', 'approver', 'auditor'])).max(4),
  rolesVersion: z.number().int().positive(),
});

export const insightCreateSchema = z.object({
  providerId: z.string().min(1).max(64),
  title: trimmed(160, '제목'),
  summary: trimmed(400, '요약'),
  language: z.enum(['ko', 'en']),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '발행일은 YYYY-MM-DD 형식으로 입력하세요.'),
  url: text(z.string().trim().url('원문 주소(URL)를 입력하세요.').max(500), '원문 주소(URL)').refine((u) => u.startsWith('https://'), 'https:// 로 시작하는 주소만 허용합니다.'),
  assetTags: z.array(text(z.string().max(16), '자산 태그')).max(8).optional().default([]),
});

export const insightStatusSchema = z.object({ status: z.enum(['published', 'hidden']) });

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 25, 50, 100].includes(n), '페이지 크기는 10·25·50·100 중 하나입니다.').default(25),
});

/**
 * 지급 근거 메모(A2b, 설계 가정 A-38): 문서 번호·정산 건처럼 승인자가 근거를 찾을 수 있는 짧은 글. 작성 중·검토 중에만 고칠 수 있다.
 * 깨진 문자는 거절하고, 보이지 않는 서식 문자를 지운 값(앞뒤 공백 제거)을 저장한다. 빈 값은 메모를 지운다.
 */
export const evidenceNoteSchema = z.object({
  note: cleanedOptional(300, '지급 근거 메모', '지급 근거 메모는 300자 이내로 입력하세요.'),
});
