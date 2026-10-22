export interface FieldError { field: string; message: string }

/** 사용자에게 보여 줄 수 있는 오류. message는 원인, action은 복구 행동. 민감 정보를 넣지 않는다. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public action?: string,
    public fields?: FieldError[],
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const Errors = {
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', '로그인이 필요하거나 세션이 만료되었습니다.', '다시 로그인하세요.'),
  forbidden: (what = '이 작업') => new AppError(403, 'FORBIDDEN', `${what}을(를) 수행할 권한이 없습니다.`, '권한이 필요하면 조직 관리자에게 역할 변경을 요청하세요.'),
  notFound: (what = '항목') => new AppError(404, 'NOT_FOUND', `${what}을(를) 찾을 수 없습니다.`, '목록으로 돌아가 다시 선택하세요. 다른 조직의 항목은 조회할 수 없습니다.'),
  conflict: (message: string, action = '화면을 새로 고쳐 최신 상태를 확인하세요.') => new AppError(409, 'CONFLICT', message, action),
  csrf: () => new AppError(403, 'CSRF_REJECTED', '요청 확인 값이 맞지 않아 처리하지 않았습니다.', '페이지를 새로 고친 뒤 다시 시도하세요.'),
};
