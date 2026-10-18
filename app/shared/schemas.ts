import { z } from 'zod';

const trimmed = (max: number, label: string) =>
  z.string().trim().min(1, `${label}을(를) 입력하세요.`).max(max, `${label}은(는) ${max}자 이내로 입력하세요.`);

export const addressCheckSchema = z.object({
  assetCode: z.string().min(1, '자산을 선택하세요.').max(16),
  networkCode: z.string().min(1, '네트워크를 선택하세요.').max(32),
  address: z.string().max(200, '주소가 너무 깁니다.'),
  memo: z.string().max(64).optional().default(''),
});

export const addressCreateSchema = addressCheckSchema.extend({
  label: trimmed(60, '주소 이름'),
  counterparty: trimmed(80, '받는 곳'),
  confirmTail: z.string().trim().min(1, '주소 끝자리를 다시 입력하세요.').max(20),
  ackNotVerified: z.literal(true, { message: '형식 점검이 주소의 안전성을 보증하지 않는다는 점을 확인하세요.' }),
  ackOutOfBandConfirmed: z.literal(true, { message: '받는 곳과 별도 연락 수단으로 주소를 대조했는지 확인하세요.' }),
});

export const addressReviewSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(500).optional().default(''),
  version: z.number().int().positive(),
  confirmTail: z.string().trim().max(20).optional().default(''),
});

export const versionSchema = z.object({ version: z.number().int().positive() });

export const requestDraftSchema = z.object({
  assetCode: z.string().min(1, '자산을 선택하세요.').max(16),
  networkCode: z.string().min(1, '네트워크를 선택하세요.').max(32),
  addressId: z.string().min(1, '받는 주소를 선택하세요.').max(64),
  amount: z.string().trim().min(1, '수량을 입력하세요.').max(60),
  purpose: trimmed(200, '요청 목적'),
});

export const requestUpdateSchema = requestDraftSchema.extend({ version: z.number().int().positive() });

export const requestSubmitSchema = z.object({
  version: z.number().int().positive(),
  confirmTail: z.string().trim().min(1, '받는 주소 끝자리를 입력하세요.').max(20),
  ackIrreversible: z.literal(true, { message: '전송 후에는 되돌릴 수 없다는 점을 확인하세요.' }),
});

export const requestRejectSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(5, '반려 사유를 5자 이상 입력하세요.').max(500, '반려 사유는 500자 이내로 입력하세요.'),
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
  url: z.string().trim().url('원문 주소(URL)를 입력하세요.').max(500).refine((u) => u.startsWith('https://'), 'https:// 로 시작하는 주소만 허용합니다.'),
  assetTags: z.array(z.string().max(16)).max(8).optional().default([]),
});

export const insightStatusSchema = z.object({ status: z.enum(['published', 'hidden']) });

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 25, 50, 100].includes(n), '페이지 크기는 10·25·50·100 중 하나입니다.').default(25),
});
