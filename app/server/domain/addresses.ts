import { randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';
import { now, tx } from '../db.ts';
import { AppError, Errors } from '../errors.ts';
import { writeAudit } from '../audit.ts';
import type { AuthContext } from '../auth.ts';
import {
  checkAddressFormat, CONFIRM_MIDDLE_LENGTH, isDustAmount, LOOKALIKE_MAX_MATCHES, LOOKALIKE_RULE_VERSION, lookalikeMatch, middleSegment, normalizeAddress,
  POISON_LOOKBACK_DAYS, sameAddress,
  type DustFindingMatch, type Finding, type LookalikeFindingMatch,
} from '../../shared/address-rules.ts';
import { formatUnits } from '../../shared/decimal.ts';
import { assertAssetOnNetwork, getAsset, getNetworkRule, getNetworkRules } from './catalog.ts';
import type { Policy } from '../config.ts';
import type { Permission } from '../authz.ts';
import { ADDRESS_STATUS, RECEIVED_VIA, VERIFIED_VIA, type AddressStatus, type ReceivedVia, type VerifiedVia } from '../../shared/terms.ts';
import { cleanText, reasonError } from '../../shared/schemas.ts';

/** 사용 대기가 끝난 주소를 사용 가능으로 바꾼 감사 기록의 수행자 이름(사람이 아닌 시간 경과). */
export const ACTIVATION_ACTOR = '시스템(사용 대기 종료)';

/**
 * 사용 대기 중 정지를 할 수 있는 권한: 주소 등록(자산 담당자)·주소 확인(승인자)·주소 사용 중지(조직 관리자).
 * 위험을 줄이는 행동이라 이 중 하나만 있으면 된다(설계 가정).
 */
const STOP_PERMS: Permission[] = ['address.create', 'address.review', 'address.disable'];
export const canStopCooling = (auth: AuthContext) => STOP_PERMS.some((p) => auth.perms.has(p));
export function assertCanStopCooling(auth: AuthContext) {
  if (!canStopCooling(auth)) throw Errors.forbidden('사용 대기 중인 주소 정지');
}

/**
 * 확인 뒤 사용 대기 시간(ms). policy.addressBook.cooldownHours(설계 가정, 기본 24).
 * 읽을 수 없는 값(음수·숫자가 아님)이면 짧게 줄이지 않고 기본 24시간으로 본다.
 */
export function cooldownMs(policy: Policy): number {
  const h = Number(policy.addressBook.cooldownHours);
  return Number.isFinite(h) && h >= 0 ? h * 3600_000 : 24 * 3600_000;
}

/**
 * 사용 대기(COOLING_DOWN) 중 active_from이 지난 주소를 사용 가능(ACTIVE)으로 바꾸고, 주소마다 감사 기록을 남긴다.
 * 상주 타이머(server/index.ts)·요청 시점 작업(server/runtime.ts tick)과 주소 조회(목록·상세·출금 요청 검증) 앞에서 부른다.
 * 바뀔 주소가 없으면 쓰기 잠금을 잡지 않는다. 바꾼 건수를 돌려준다.
 */
export function activateDueAddresses(db: DB, nowIso: string = now()): number {
  const pending = db.prepare("SELECT 1 x FROM address_book WHERE status = 'COOLING_DOWN' AND active_from <= ? LIMIT 1").get(nowIso);
  if (!pending) return 0;
  return tx(db, () => {
    const due = db.prepare("SELECT id, org_id, label, active_from FROM address_book WHERE status = 'COOLING_DOWN' AND active_from <= ? ORDER BY active_from, id").all(nowIso) as { id: string; org_id: string; label: string; active_from: string }[];
    let n = 0;
    for (const r of due) {
      const res = db.prepare("UPDATE address_book SET status = 'ACTIVE', version = version + 1 WHERE id = ? AND status = 'COOLING_DOWN'").run(r.id);
      if (res.changes !== 1) continue;
      writeAudit(db, {
        orgId: r.org_id, actorId: null, actorName: ACTIVATION_ACTOR, action: 'address.activated', targetType: 'address', targetId: r.id,
        summary: `사용 대기 종료, 사용 가능: ${r.label}`,
        detail: { activeFrom: r.active_from, checkedAt: nowIso },
      });
      n++;
    }
    return n;
  });
}

/** 저장된 점검 결과(JSON). 이 규칙 도입 전 등록분이나 읽을 수 없는 값은 빈 배열로 본다. */
export function parseFindings(raw: unknown): Finding[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Finding[]) : [];
  } catch {
    return [];
  }
}

export function lookalikeMatchesOf(findings: Finding[]): LookalikeFindingMatch[] {
  return findings.find((f) => f.code === 'ADDRESS_LOOKALIKE')?.data?.matches ?? [];
}

export function toAddressDto(r: any, auth?: AuthContext) {
  const mid = middleSegment(String(r.address));
  const dto = {
    id: r.id as string,
    label: r.label as string,
    counterparty: r.counterparty as string,
    assetCode: r.asset_code as string,
    networkCode: r.network_code as string,
    networkName: r.network_name as string,
    address: r.address as string,
    memo: r.memo as string,
    status: r.status as AddressStatus,
    statusLabel: ADDRESS_STATUS[r.status as AddressStatus].label,
    createdBy: { id: r.created_by as string, name: r.creator_name as string },
    createdAt: r.created_at as string,
    reviewedBy: r.reviewed_by ? { id: r.reviewed_by as string, name: r.reviewer_name as string } : null,
    reviewedAt: r.reviewed_at as string | null,
    reviewNote: r.review_note as string | null,
    version: r.version as number,
    /** 등록 시 서버 점검 결과. 확인(승인) 때 새로 찾은 유사 주소가 합쳐진다. */
    findings: parseFindings(r.check_findings),
    lookalikeReason: (r.lookalike_reason as string | null) ?? null,
    /** 원본을 보고 다시 입력할 가운데 구간(고유부 기준, 1부터 세는 위치). 글자 자체는 따로 내려 주지 않는다. */
    middle: { start: mid.start, end: mid.end },
    /** 이 주소를 쓰는 진행 중(작성 중·검토 중·승인 대기) 출금 요청 수 */
    openRequestCount: Number(r.open_request_count ?? 0),
    /** 사용 대기가 끝나 출금 요청에 쓸 수 있게 되는(된) 시각. 대기 없이 확인된 주소와 이 규칙 도입 전 주소는 null. */
    activeFrom: (r.active_from as string | null) ?? null,
    /** 등록자가 남긴 다른 경로 확인 기록. 이 기록 방식 도입 전 등록분은 null. */
    outOfBand: r.received_via
      ? {
        receivedVia: r.received_via as ReceivedVia,
        receivedViaLabel: RECEIVED_VIA[r.received_via as ReceivedVia] ?? String(r.received_via),
        verifiedVia: r.verified_via as VerifiedVia,
        verifiedViaLabel: VERIFIED_VIA[r.verified_via as VerifiedVia] ?? String(r.verified_via),
        verifiedWith: (r.verified_with as string | null) ?? '',
      }
      : null,
    /** 사용 중지·정지 기록. 사용 대기 중 정지는 사유가 함께 남는다. 이 기록 도입 전 사용 중지분은 null. */
    disabled: r.disabled_at
      ? { by: r.disabled_by ? { id: r.disabled_by as string, name: r.disabler_name as string } : null, at: r.disabled_at as string, reason: (r.disabled_reason as string | null) ?? null }
      : null,
    allowedActions: [] as string[],
  };
  if (auth) {
    if (r.status === 'PENDING_REVIEW' && auth.perms.has('address.review') && r.created_by !== auth.user.id) dto.allowedActions.push('review');
    if ((r.status === 'ACTIVE' || r.status === 'PENDING_REVIEW') && auth.perms.has('address.disable')) dto.allowedActions.push('disable');
    if (r.status === 'COOLING_DOWN' && canStopCooling(auth)) dto.allowedActions.push('stop');
  }
  return dto;
}

const SELECT = `SELECT a.*, n.name network_name, cu.name creator_name, ru.name reviewer_name, du.name disabler_name,
    (SELECT COUNT(*) FROM withdrawal_requests wr WHERE wr.address_id = a.id AND wr.org_id = a.org_id AND wr.status IN ('DRAFT','REVIEW','PENDING_APPROVAL')) open_request_count
  FROM address_book a JOIN networks n ON n.code = a.network_code
  JOIN users cu ON cu.id = a.created_by LEFT JOIN users ru ON ru.id = a.reviewed_by LEFT JOIN users du ON du.id = a.disabled_by`;

export function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
}

export function listAddresses(db: DB, auth: AuthContext, q: { status?: string; assetCode?: string; networkCode?: string; q?: string; sort?: string }) {
  // 대기 시간이 끝난 주소가 '사용 대기'로 남아 보이지 않도록 먼저 상태를 맞춘다.
  activateDueAddresses(db);
  const where = ['a.org_id = ?'];
  const args: any[] = [auth.org.id];
  if (q.status) { where.push('a.status = ?'); args.push(q.status); }
  if (q.assetCode) { where.push('a.asset_code = ?'); args.push(q.assetCode); }
  if (q.networkCode) { where.push('a.network_code = ?'); args.push(q.networkCode); }
  if (q.q) {
    where.push("(a.label LIKE ? ESCAPE '\\' OR a.counterparty LIKE ? ESCAPE '\\' OR a.address LIKE ? ESCAPE '\\')");
    const like = likePattern(q.q);
    args.push(like, like, like);
  }
  const order = q.sort === 'label' ? 'a.label COLLATE NOCASE ASC'
    // 확인 필요 먼저: 확인 대기 → 사용 대기(요청하지 않은 등록이면 정지할 수 있는 기간) → 사용 가능 → 등록 거절 → 사용 중지
    : q.sort === 'status' ? "CASE a.status WHEN 'PENDING_REVIEW' THEN 0 WHEN 'COOLING_DOWN' THEN 1 WHEN 'ACTIVE' THEN 2 WHEN 'REJECTED' THEN 3 ELSE 4 END, a.created_at DESC"
    : 'a.created_at DESC';
  const rows = db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`).all(...args);
  const total = (db.prepare('SELECT COUNT(*) c FROM address_book WHERE org_id = ?').get(auth.org.id) as { c: number }).c;
  return { items: rows.map((r) => toAddressDto(r, auth)), totalInOrg: total };
}

/**
 * 주소 한 건(같은 조직만). 상세 조회·출금 요청 검증·확인·정지가 모두 이 함수로 읽으므로,
 * 읽기 전에 대기 시간이 끝난 주소를 사용 가능으로 바꿔 오래된 상태를 보지 않게 한다.
 */
export function getAddressRow(db: DB, orgId: string, id: string): any {
  activateDueAddresses(db);
  const r = db.prepare(`${SELECT} WHERE a.id = ? AND a.org_id = ?`).get(id, orgId);
  if (!r) throw Errors.notFound('주소');
  return r;
}

const STATUS_ORDER: Record<string, number> = { ACTIVE: 0, COOLING_DOWN: 1, PENDING_REVIEW: 2, DISABLED: 3, REJECTED: 4 };

/** 같은 글자 수(앞+뒤)가 많은 순서, 같으면 사용 가능 → 사용 대기 → 확인 대기 → 사용 중지 → 등록 거절 순으로 정렬한다(자르지 않음). */
function sortMatches(matches: LookalikeFindingMatch[]): LookalikeFindingMatch[] {
  return [...matches]
    .sort((a, b) => (b.prefix + b.suffix) - (a.prefix + a.suffix) || (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.id.localeCompare(b.id));
}

/** 정렬한 뒤 상위 LOOKALIKE_MAX_MATCHES(3)건만 남긴다. 점검 결과(data.matches)에는 이 목록만 저장한다. */
function rankMatches(matches: LookalikeFindingMatch[]): LookalikeFindingMatch[] {
  return sortMatches(matches).slice(0, LOOKALIKE_MAX_MATCHES);
}

/** 유사 주소 점검 결과: 비교해 보여 줄 상위 3건과, 자르기 전 전체 건수. */
export interface LookalikeScan {
  matches: LookalikeFindingMatch[];
  total: number;
}

/** 같은 조직 주소록 전체(상태와 무관)에서 앞·뒤가 같고 가운데가 다른 주소를 모두 찾는다(정렬만 하고 자르지 않음). */
function findAllLookalikes(db: DB, orgId: string, normalized: string, excludeId?: string): LookalikeFindingMatch[] {
  const rows = db.prepare('SELECT id, label, status, address FROM address_book WHERE org_id = ?').all(orgId) as { id: string; label: string; status: string; address: string }[];
  const out: LookalikeFindingMatch[] = [];
  for (const r of rows) {
    if (r.id === excludeId) continue;
    const m = lookalikeMatch(r.address, normalized);
    if (m) out.push({ id: r.id, label: r.label, status: r.status, address: r.address, prefix: m.prefix, suffix: m.suffix });
  }
  return sortMatches(out);
}

/** 같은 조직 주소록 전체(상태와 무관)에서 앞·뒤가 같고 가운데가 다른 주소를 찾는다. 상위 3건과 전체 건수를 함께 돌려준다. */
export function findLookalikes(db: DB, orgId: string, normalized: string, excludeId?: string): LookalikeScan {
  const all = findAllLookalikes(db, orgId, normalized, excludeId);
  return { matches: all.slice(0, LOOKALIKE_MAX_MATCHES), total: all.length };
}

/**
 * 유사 주소 경고. matches는 비교해 보여 줄 상위 3건(이미 정렬됨), total은 자르기 전 전체 건수다.
 * 메시지의 '외 N건'은 total로 센다. 비교 목록이 3건으로 잘려도 실제로 몇 건이 더 있는지 그대로 알린다.
 */
export function lookalikeFinding(matches: LookalikeFindingMatch[], total: number): Finding {
  const top = matches[0]!;
  const st = ADDRESS_STATUS[top.status as AddressStatus]?.label ?? top.status;
  const all = Math.max(total, matches.length);
  const others = all - 1;
  const more = others > 0 ? ` 이 주소 외에 비슷한 기존 주소가 ${others}건 더 있습니다.` : '';
  const cut = all > matches.length ? ` 글자 비교는 가장 비슷한 ${matches.length}건까지 보여 줍니다.` : '';
  return {
    code: 'ADDRESS_LOOKALIKE',
    level: 'warning',
    message: `기존 주소 '${top.label}'(${st})와 앞 ${top.prefix}자·뒤 ${top.suffix}자가 같지만 가운데가 다릅니다.${more}${cut}`,
    action: '앞·뒤만 같게 만든 가짜 주소를 이용한 사기일 수 있습니다. 가운데를 포함한 전체 글자를 받는 곳과 별도 연락 수단으로 다시 대조하고, 어떻게 확인했는지 남기세요.',
    data: { matches },
  };
}

/** 최근 소액(더스트) 입금 한 건: 보낸 주소와 거래 정보 */
export interface DustDeposit {
  txId: string;
  txRef: string;
  address: string;
  assetCode: string;
  networkCode: string;
  amountUnits: string;
  precision: number;
  occurredAt: string;
}

/**
 * 같은 조직의 최근 POISON_LOOKBACK_DAYS(90)일 입금 중, 보낸 주소가 기록되어 있고 수량이 0이거나 소액 기준(DUST_THRESHOLD, 설계 가정)보다 작은 것.
 * 주소 오염 공격은 이런 입금으로 거래 내역에 비슷한 주소를 남겨 복사하게 만든다.
 */
export function recentDustDeposits(db: DB, orgId: string, nowIso: string = now()): DustDeposit[] {
  const since = new Date(Date.parse(nowIso) - POISON_LOOKBACK_DAYS * 86400_000).toISOString();
  const rows = db.prepare(
    `SELECT t.id, t.tx_ref, t.counterparty_address, t.asset_code, t.network_code, t.amount_units, t.occurred_at, a.precision
       FROM transactions t JOIN assets a ON a.code = t.asset_code
      WHERE t.org_id = ? AND t.type = 'deposit' AND t.counterparty_address IS NOT NULL AND t.occurred_at >= ?
      ORDER BY t.occurred_at DESC, t.id`,
  ).all(orgId, since) as any[];
  return rows
    .filter((r) => isDustAmount(String(r.amount_units), Number(r.precision), String(r.asset_code)))
    .map((r) => ({ txId: r.id, txRef: r.tx_ref, address: r.counterparty_address, assetCode: r.asset_code, networkCode: r.network_code, amountUnits: String(r.amount_units), precision: Number(r.precision), occurredAt: r.occurred_at }));
}

const dustMatch = (d: DustDeposit, ends?: { prefix: number; suffix: number }): DustFindingMatch => ({
  txRef: d.txRef, occurredAt: d.occurredAt, assetCode: d.assetCode, networkCode: d.networkCode, amount: formatUnits(d.amountUnits, d.precision),
  ...(ends ? { prefix: ends.prefix, suffix: ends.suffix } : {}),
});

export const POISON_SUSPECTED_MESSAGE = '최근 0원·소액 입금을 보낸 주소와 같습니다. 주소 오염 공격에서 자주 보이는 패턴이라 등록할 수 없습니다.';

/**
 * 주소 오염 의심 점검: 후보 주소를 최근 소액 입금을 보낸 주소와 비교한다.
 * - 같은 주소: ADDRESS_POISON_SUSPECTED(error, 등록 차단)
 * - 앞·뒤가 같고 가운데가 다른 주소(lookalike-v2 기준): ADDRESS_POISON_LOOKALIKE(warning)
 * 보낸 주소 전체는 점검 결과에 넣지 않는다(거래 참조·시각·수량만).
 */
export function poisonFindings(db: DB, orgId: string, normalized: string, nowIso: string = now()): Finding[] {
  const dust = recentDustDeposits(db, orgId, nowIso);
  if (!dust.length) return [];
  const out: Finding[] = [];
  const exact = dust.filter((d) => sameAddress(d.address, normalized));
  if (exact.length) {
    out.push({
      code: 'ADDRESS_POISON_SUSPECTED', level: 'error',
      message: POISON_SUSPECTED_MESSAGE,
      action: '거래 내역에서 주소를 복사하지 마세요. 받는 곳이 보낸 원본에서 주소를 다시 받고, 받은 경로와 다른 연락 수단으로 가운데를 포함한 전체 글자를 대조하세요.',
      data: { dust: exact.map((d) => dustMatch(d)) },
    });
  }
  const similar = dust
    .map((d) => ({ d, m: lookalikeMatch(d.address, normalized) }))
    .filter((x): x is { d: DustDeposit; m: { prefix: number; suffix: number } } => x.m !== null)
    .sort((a, b) => (b.m.prefix + b.m.suffix) - (a.m.prefix + a.m.suffix) || b.d.occurredAt.localeCompare(a.d.occurredAt));
  if (similar.length) {
    const top = similar[0]!;
    const more = similar.length > 1 ? ` 이런 입금이 ${similar.length}건 있습니다.` : '';
    out.push({
      code: 'ADDRESS_POISON_LOOKALIKE', level: 'warning',
      message: `최근 0원·소액 입금을 보낸 주소와 앞 ${top.m.prefix}자·뒤 ${top.m.suffix}자가 같지만 가운데가 다릅니다.${more}`,
      action: '주소 오염 공격은 거래 내역에 비슷한 주소를 남겨 복사하게 만듭니다. 입력한 주소를 거래 내역에서 복사하지 않았는지 확인하고, 받는 곳의 원본과 가운데를 포함한 전체 글자를 다시 대조하세요.',
      data: { dust: similar.slice(0, LOOKALIKE_MAX_MATCHES).map((x) => dustMatch(x.d, x.m)) },
    });
  }
  return out;
}

/** 서버 기준 형식 점검 + 같은 조직 주소록의 중복·유사 주소 점검 + 최근 소액 입금 보낸 주소(주소 오염 의심) 점검 */
export function checkAddress(db: DB, orgId: string, input: { assetCode: string; networkCode: string; address: string; memo?: string }, nowIso: string = now()): { findings: Finding[]; normalized: string } {
  getAsset(db, input.assetCode);
  const network = getNetworkRule(db, input.networkCode);
  assertAssetOnNetwork(db, input.assetCode, input.networkCode);
  const findings = checkAddressFormat(input, network, getNetworkRules(db));
  const normalized = normalizeAddress(input.address, network.family);
  if (!findings.some((f) => f.level === 'error')) {
    // 중복은 쓰는 중인 주소(확인 대기·사용 대기·사용 가능)만 본다. 고유 인덱스와 같은 기준이다.
    const live = db.prepare("SELECT label, address, memo, asset_code, network_code FROM address_book WHERE org_id = ? AND status IN ('PENDING_REVIEW','COOLING_DOWN','ACTIVE')").all(orgId) as any[];
    const memo = (input.memo ?? '').trim();
    const dup = live.find((r) => r.address === normalized && r.network_code === input.networkCode && r.asset_code === input.assetCode && r.memo === memo);
    if (dup) {
      findings.unshift({ code: 'ADDRESS_DUPLICATE', level: 'error', message: `이미 '${dup.label}'(으)로 등록된 주소입니다.`, action: '기존 주소를 사용하거나, 사용 중지 후 다시 등록하세요.' });
    }
    // 유사 주소는 사용 중지·거절된 주소까지 모두 본다.
    const scan = findLookalikes(db, orgId, normalized);
    if (scan.matches.length) findings.unshift(lookalikeFinding(scan.matches, scan.total));
    // 주소 오염 의심(최근 소액 입금 보낸 주소)은 맨 앞에 둔다. 같은 주소면 등록 오류의 첫 원인이 된다.
    findings.unshift(...poisonFindings(db, orgId, normalized, nowIso));
  }
  return { findings, normalized };
}

function tailMismatch(n: number, action: string) {
  return new AppError(422, 'CONFIRM_TAIL_MISMATCH', `다시 입력한 끝 ${n}자리가 주소와 다릅니다.`, action, [{ field: 'confirmTail', message: '주소 끝자리와 일치하지 않습니다.' }]);
}

/** 가운데 8자리 대조. 대소문자는 구분하지 않는다(EVM 모의 형식은 대소문자를 구분하지 않음). */
function assertMiddle(address: string, typed: string, action: string) {
  const mid = middleSegment(address);
  if (typed.trim().toUpperCase() !== mid.text.toUpperCase()) {
    throw new AppError(422, 'CONFIRM_MIDDLE_MISMATCH', `다시 입력한 가운데 ${CONFIRM_MIDDLE_LENGTH}자리(고유부 ${mid.start}~${mid.end}번째)가 주소와 다릅니다.`, action, [{ field: 'confirmMiddle', message: '주소 가운데 글자와 일치하지 않습니다.' }]);
  }
}

const auditMatches = (ms: LookalikeFindingMatch[]) => ms.map((m) => ({ id: m.id, label: m.label, status: m.status, prefix: m.prefix, suffix: m.suffix }));

export interface OutOfBandInput { receivedVia: ReceivedVia; verifiedVia: VerifiedVia; verifiedWith: string }

/** 받은 경로와 다시 확인한 경로가 같으면 다른 경로로 확인한 것이 아니다. */
function assertDifferentChannel(input: OutOfBandInput) {
  if ((input.receivedVia as string) === (input.verifiedVia as string)) {
    throw new AppError(422, 'OUT_OF_BAND_SAME_CHANNEL', '주소를 받은 경로와 다시 확인한 경로가 같습니다.',
      '주소를 받은 경로와 다른 경로로 다시 확인하세요. 예를 들어 이메일로 받았다면 미리 알고 있던 연락처로 전화해 확인합니다. 받은 메시지에 적힌 연락처는 쓰지 마세요.',
      [{ field: 'verifiedVia', message: '받은 경로와 다른 경로를 고르세요.' }]);
  }
}

export function createAddress(db: DB, auth: AuthContext, policy: Policy, input: { label: string; counterparty: string; assetCode: string; networkCode: string; address: string; memo: string; confirmTail: string; confirmMiddle: string; lookalikeReason?: string } & OutOfBandInput) {
  return tx(db, () => {
    const { findings, normalized } = checkAddress(db, auth.org.id, input);
    const errors = findings.filter((f) => f.level === 'error');
    if (errors.length) {
      const e = errors[0]!;
      throw new AppError(422, e.code, e.message, e.action, [{ field: e.code.startsWith('MEMO') ? 'memo' : 'address', message: e.message }], { findings });
    }
    const n = policy.addressBook.confirmTailLength;
    if (input.confirmTail.trim().toUpperCase() !== normalized.slice(-n).toUpperCase()) {
      throw tailMismatch(n, '받는 곳이 알려 준 주소의 마지막 글자를 직접 보고 다시 입력하세요.');
    }
    assertMiddle(normalized, input.confirmMiddle, '붙여 넣은 값이 아니라 받는 곳이 알려 준 원본 주소의 가운데 글자를 직접 보고 다시 입력하세요.');
    const matches = lookalikeMatchesOf(findings);
    // 보이지 않는 서식 문자(폭 없는 공백·방향 제어 문자 등)를 지운 값으로 세고 저장한다. 문장부호·공백만으로는 채울 수 없다(글자·숫자 5자 이상).
    const reason = cleanText(input.lookalikeReason ?? '');
    const reasonProblem = matches.length ? reasonError(reason, { label: '등록 사유', short: '등록 사유를 5자 이상 입력하세요.' }) : null;
    if (reasonProblem) {
      throw new AppError(422, 'REASON_REQUIRED', '비슷한 기존 주소가 있어 등록 사유가 필요합니다.', '받는 곳에 어떤 연락 수단으로 전체 주소를 확인했는지, 기존 주소와 어떻게 다른지 글자·숫자 5자 이상 적어 주세요.', [{ field: 'lookalikeReason', message: reasonProblem }], { findings });
    }
    const lookalikeReason = matches.length ? reason : null;
    assertDifferentChannel(input);
    const label = cleanText(input.label);
    const counterparty = cleanText(input.counterparty);
    const verifiedWith = cleanText(input.verifiedWith);
    const id = randomUUID();
    const status: AddressStatus = policy.addressBook.requireSecondPersonReview ? 'PENDING_REVIEW' : 'ACTIVE';
    db.prepare(
      `INSERT INTO address_book (id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at, check_findings, lookalike_reason, received_via, verified_via, verified_with)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, auth.org.id, label, counterparty, input.assetCode, input.networkCode, normalized, (input.memo ?? '').trim(), status, auth.user.id, now(), JSON.stringify(findings), lookalikeReason, input.receivedVia, input.verifiedVia, verifiedWith);
    // 요약은 화면과 같은 네트워크 이름(예: Ethereum)으로 쓴다. 코드(ETHEREUM)는 detail에 남긴다.
    const networkName = getNetworkRule(db, input.networkCode).name;
    writeAudit(db, {
      orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'address.created', targetType: 'address', targetId: id,
      summary: `주소 등록 요청: ${label} (${input.assetCode}/${networkName})`,
      detail: {
        assetCode: input.assetCode, networkCode: input.networkCode, addressTail: normalized.slice(-6), memoSet: !!(input.memo ?? '').trim(),
        warnings: findings.filter((f) => f.level === 'warning').map((f) => f.code),
        ruleVersion: LOOKALIKE_RULE_VERSION, lookalike: auditMatches(matches), lookalikeReason,
        outOfBand: { receivedVia: input.receivedVia, verifiedVia: input.verifiedVia, verifiedWith },
      },
    });
    return { address: toAddressDto(getAddressRow(db, auth.org.id, id), auth), findings };
  });
}

export function reviewAddress(db: DB, auth: AuthContext, policy: Policy, id: string, input: { decision: 'approve' | 'reject'; note: string; version: number; confirmTail: string; confirmMiddle?: string }) {
  type Outcome =
    | { kind: 'refreshed'; added: LookalikeFindingMatch[] }
    | { kind: 'poisoned'; findings: Finding[] }
    | { kind: 'done'; dto: ReturnType<typeof toAddressDto> };
  const out = tx<Outcome>(db, () => {
    const r = getAddressRow(db, auth.org.id, id);
    if (r.created_by === auth.user.id) {
      throw new AppError(403, 'SELF_REVIEW_FORBIDDEN', '본인이 등록한 주소는 직접 확인할 수 없습니다.', '다른 승인자에게 확인을 요청하세요.');
    }
    if (r.status !== 'PENDING_REVIEW') throw Errors.conflict(`이미 '${ADDRESS_STATUS[r.status as AddressStatus].label}' 상태인 주소입니다.`);
    if (r.version !== input.version) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
    // 보이지 않는 서식 문자를 지운 값으로 세고 저장한다(글자·숫자 5자 이상).
    const note = cleanText(input.note);
    const rejectProblem = input.decision === 'reject' ? reasonError(note, { label: '거절 사유', short: '거절 사유를 5자 이상 입력하세요.' }) : null;
    if (rejectProblem) {
      throw new AppError(422, 'VALIDATION', rejectProblem, '등록자가 무엇을 고쳐야 하는지 알 수 있게 글자·숫자 5자 이상 적어 주세요.', [{ field: 'note', message: rejectProblem }]);
    }
    const seen = parseFindings(r.check_findings);
    const seenMatches = lookalikeMatchesOf(seen);
    if (input.decision === 'approve') {
      // 등록 뒤에 같은 주소에서 소액 입금이 들어왔을 수 있다. 확인(승인) 때 다시 보고, 같으면 확인하지 않는다.
      // 확인은 막되, 찾은 결과는 버리지 않는다: 점검 결과 맨 앞에 넣고 감사 기록을 같은 트랜잭션에서 남긴 뒤(커밋), 422로 알린다.
      // 다음 확인 담당자도 상세 화면에서 이 경고를 보고, 해시 연결 감사 기록에도 탐지 사실이 남는다(유사 주소 갱신과 같은 방식).
      const poison = poisonFindings(db, auth.org.id, String(r.address)).find((f) => f.code === 'ADDRESS_POISON_SUSPECTED');
      if (poison) {
        const dustRefs = (f: Finding | undefined) => (f?.data?.dust ?? []).map((d) => d.txRef).sort().join('\n');
        const stored = seen.find((f) => f.code === 'ADDRESS_POISON_SUSPECTED');
        // 이미 같은 입금으로 저장해 둔 결과면 다시 쓰지 않는다(버전·감사 기록을 반복해 늘리지 않음).
        if (stored && dustRefs(stored) === dustRefs(poison)) return { kind: 'poisoned', findings: seen };
        const next = [poison, ...seen.filter((f) => f.code !== 'ADDRESS_POISON_SUSPECTED')];
        const res = db.prepare('UPDATE address_book SET check_findings = ?, version = version + 1 WHERE id = ? AND org_id = ? AND version = ?').run(JSON.stringify(next), id, auth.org.id, input.version);
        if (res.changes !== 1) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
        writeAudit(db, {
          orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'address.findings_updated', targetType: 'address', targetId: id,
          summary: `주소 점검 결과 갱신: ${r.label} (최근 0원·소액 입금을 보낸 주소와 같음, 확인 보류)`,
          detail: {
            ruleVersion: LOOKALIKE_RULE_VERSION,
            attempted: 'approve',
            added: ['ADDRESS_POISON_SUSPECTED'],
            // 거래 참조·시각·수량만 남긴다(보낸 주소 전체는 남기지 않음).
            dust: poison.data?.dust ?? [],
            findings: next.map((f) => f.code),
            version: input.version + 1,
          },
        });
        return { kind: 'poisoned', findings: next };
      }
      const n = policy.addressBook.confirmTailLength;
      if (input.confirmTail.trim().toUpperCase() !== String(r.address).slice(-n).toUpperCase()) {
        throw tailMismatch(n, '받는 곳에서 받은 원본 주소와 직접 대조한 뒤 입력하세요.');
      }
      assertMiddle(String(r.address), input.confirmMiddle ?? '', '화면을 복사하지 말고 받는 곳에서 받은 원본 주소의 가운데 글자를 보고 입력하세요.');
      // 등록 뒤에 생긴 유사 주소가 있으면 확인 담당자가 비교 내용을 먼저 보도록 점검 결과를 갱신하고 다시 확인하게 한다.
      const fresh = findAllLookalikes(db, auth.org.id, String(r.address), id);
      const freshById = new Map(fresh.map((m) => [m.id, m]));
      const seenIds = new Set(seenMatches.map((m) => m.id));
      // 저장된 결과와 지금 찾은 결과의 합집합(자르기 전). 건수는 메시지의 '외 N건'에 쓴다.
      const union = [...seenMatches.map((m) => freshById.get(m.id) ?? m), ...fresh.filter((m) => !seenIds.has(m.id))];
      const merged = rankMatches(union);
      const added = merged.filter((m) => !seenIds.has(m.id));
      if (added.length) {
        const next = [lookalikeFinding(merged, union.length), ...seen.filter((f) => f.code !== 'ADDRESS_LOOKALIKE')];
        const res = db.prepare('UPDATE address_book SET check_findings = ?, version = version + 1 WHERE id = ? AND org_id = ? AND version = ?').run(JSON.stringify(next), id, auth.org.id, input.version);
        if (res.changes !== 1) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
        // 확인 담당자에게 보여 줄 점검 결과가 바뀌었다는 증거를 같은 트랜잭션에서 남긴다(전체 주소는 남기지 않음).
        writeAudit(db, {
          orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'address.findings_updated', targetType: 'address', targetId: id,
          summary: `주소 점검 결과 갱신: ${r.label} (비슷한 주소 ${added.length}건 새로 확인, 확인 보류)`,
          detail: {
            ruleVersion: LOOKALIKE_RULE_VERSION,
            attempted: 'approve',
            added: auditMatches(added),
            previous: auditMatches(seenMatches),
            lookalike: auditMatches(merged),
            lookalikeTotal: union.length,
            findings: next.map((f) => f.code),
            version: input.version + 1,
          },
        });
        return { kind: 'refreshed', added };
      }
      const noteProblem = seenMatches.length ? reasonError(note, { label: '확인 메모', short: '확인한 방법을 5자 이상 입력하세요.' }) : null;
      if (noteProblem) {
        throw new AppError(422, 'NOTE_REQUIRED', '비슷한 기존 주소가 있어 확인 메모가 필요합니다.', '받는 곳에 어떤 연락 수단으로 전체 주소를 확인했는지 글자·숫자 5자 이상 적어 주세요.', [{ field: 'note', message: noteProblem }]);
      }
    }
    // 확인을 마쳐도 대기 시간(cooldownHours, 설계 가정)이 있으면 바로 쓰지 않고 '사용 대기'로 둔다. 0이면 예전처럼 바로 사용 가능.
    const reviewedAt = now();
    const waitMs = input.decision === 'approve' ? cooldownMs(policy) : 0;
    const activeFrom = waitMs > 0 ? new Date(Date.parse(reviewedAt) + waitMs).toISOString() : null;
    const status: AddressStatus = input.decision === 'approve' ? (activeFrom ? 'COOLING_DOWN' : 'ACTIVE') : 'REJECTED';
    const res = db.prepare('UPDATE address_book SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, active_from = ?, version = version + 1 WHERE id = ? AND org_id = ? AND version = ?')
      .run(status, auth.user.id, reviewedAt, note || null, activeFrom, id, auth.org.id, input.version);
    if (res.changes !== 1) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
    // 확인 담당자가 화면에서 본 점검 결과(저장된 결과)를 함께 남긴다.
    const seenDetail = { ruleVersion: LOOKALIKE_RULE_VERSION, findings: seen.map((f) => f.code), lookalike: auditMatches(seenMatches) };
    const hours = waitMs / 3600_000;
    writeAudit(db, {
      orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name,
      action: input.decision === 'approve' ? 'address.approved' : 'address.rejected', targetType: 'address', targetId: id,
      summary: input.decision === 'approve'
        ? `주소 확인 완료: ${r.label}${activeFrom ? ` (사용 대기 ${hours}시간)` : ''}`
        : `주소 등록 거절: ${r.label}`,
      at: reviewedAt,
      detail: input.decision === 'reject'
        ? { reason: note, ...seenDetail }
        : { ...seenDetail, ...(note ? { note } : {}), cooldown: activeFrom ? { hours, activeFrom } : null },
    });
    return { kind: 'done', dto: toAddressDto(getAddressRow(db, auth.org.id, id), auth) };
  });
  // 점검 결과 갱신과 그 감사 기록은 위 트랜잭션에서 함께 저장(커밋)한 뒤 알린다. 이 함수를 바깥 트랜잭션으로 감싸면 둘 다 취소되므로 감싸지 않는다.
  // 화면은 409를 받으면 주소를 다시 불러와 갱신된 비교 내용을 보여 준다(입력값은 유지).
  if (out.kind === 'poisoned') {
    // 화면은 이 오류를 받으면 주소를 다시 불러와 맨 앞에 저장된 주소 오염 의심 결과와 바뀐 버전을 보여 준다.
    throw new AppError(422, 'ADDRESS_POISON_SUSPECTED', POISON_SUSPECTED_MESSAGE, '이 등록은 확인하지 말고 사유와 함께 거절하세요. 받는 곳에는 받은 경로와 다른 연락 수단으로 주소를 다시 확인하세요.', undefined, { findings: out.findings });
  }
  if (out.kind === 'refreshed') {
    const labels = out.added.map((m) => `'${m.label}'`).join(', ');
    throw new AppError(409, 'LOOKALIKE_UPDATED', `등록 뒤에 비슷한 주소(${labels})가 새로 확인되어 점검 결과를 갱신했습니다.`, '갱신된 점검 결과와 글자 비교가 화면에 다시 표시됩니다. 새로 표시된 주소와 가운데를 포함한 전체 글자를 대조하고, 어떻게 확인했는지 메모를 남긴 뒤 다시 확인하세요.');
  }
  return out.dto;
}

export function disableAddress(db: DB, auth: AuthContext, id: string, version: number) {
  return tx(db, () => {
    const r = getAddressRow(db, auth.org.id, id);
    if (r.status === 'COOLING_DOWN') {
      throw new AppError(409, 'USE_COOLDOWN_STOP', '사용 대기 중인 주소입니다.', "'사용 대기 중 정지'로 사유를 남기고 정지하세요.");
    }
    if (!['ACTIVE', 'PENDING_REVIEW'].includes(r.status)) throw Errors.conflict('이미 사용할 수 없는 주소입니다.');
    const res = db.prepare("UPDATE address_book SET status = 'DISABLED', disabled_by = ?, disabled_at = ?, version = version + 1 WHERE id = ? AND org_id = ? AND version = ?").run(auth.user.id, now(), id, auth.org.id, version);
    if (res.changes !== 1) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
    writeAudit(db, { orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'address.disabled', targetType: 'address', targetId: id, summary: `주소 사용 중지: ${r.label}` });
    return toAddressDto(getAddressRow(db, auth.org.id, id), auth);
  });
}

/**
 * 사용 대기 중 정지: 사용 대기(COOLING_DOWN) 주소를 바로 사용 중지(DISABLED)로 바꾸고 사유를 남긴다.
 * 위험을 줄이는 행동이라 두 번째 사람의 확인 없이 바로 적용한다. 같은 조직에서 주소 등록·확인·사용 중지 권한 중 하나가 있으면 할 수 있다.
 * 대기 시간이 이미 끝났으면(사용 가능) 이 경로로는 멈추지 않는다(조직 관리자의 사용 중지를 쓴다).
 */
export function stopCoolingAddress(db: DB, auth: AuthContext, id: string, input: { version: number; reason: string }) {
  assertCanStopCooling(auth);
  return tx(db, () => {
    const r = getAddressRow(db, auth.org.id, id);
    if (r.status !== 'COOLING_DOWN') {
      const label = ADDRESS_STATUS[r.status as AddressStatus]?.label ?? r.status;
      throw new AppError(409, 'NOT_COOLING_DOWN', `이 주소는 '${label}' 상태라 사용 대기 중 정지를 할 수 없습니다.`,
        r.status === 'ACTIVE' ? '대기 시간이 끝나 사용 가능해졌습니다. 더 쓰지 않으려면 조직 관리자에게 사용 중지를 요청하세요.' : '화면을 새로 고쳐 최신 상태를 확인하세요.',
        undefined, { status: r.status });
    }
    if (r.version !== input.version) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
    // 보이지 않는 서식 문자를 지운 값으로 세고 저장한다(글자·숫자 5자 이상).
    const reason = cleanText(input.reason);
    const reasonProblem = reasonError(reason, { label: '정지 사유', short: '정지 사유를 5자 이상 입력하세요.' });
    if (reasonProblem) {
      throw new AppError(422, 'VALIDATION', reasonProblem, '요청하지 않은 등록인지, 받는 곳에서 확인되지 않았는지 등 정지한 이유를 글자·숫자 5자 이상 적어 주세요.', [{ field: 'reason', message: reasonProblem }]);
    }
    const t = now();
    const res = db.prepare("UPDATE address_book SET status = 'DISABLED', disabled_by = ?, disabled_at = ?, disabled_reason = ?, version = version + 1 WHERE id = ? AND org_id = ? AND version = ? AND status = 'COOLING_DOWN'")
      .run(auth.user.id, t, reason, id, auth.org.id, input.version);
    if (res.changes !== 1) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
    writeAudit(db, {
      orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'address.cooldown_stopped', targetType: 'address', targetId: id,
      summary: `사용 대기 중 정지: ${r.label}`,
      at: t,
      detail: { reason, activeFrom: r.active_from, roles: auth.roles },
    });
    return toAddressDto(getAddressRow(db, auth.org.id, id), auth);
  });
}

/** 소액 입금 거래의 주소 오염 의심 표시. 주소록에 비슷한 주소가 있으면 가장 비슷한 한 건을 함께 알려 준다. */
export interface PoisonFlag {
  reason: 'dust';
  lookalike: { id: string; label: string; status: string; prefix: number; suffix: number } | null;
}

/**
 * 거래 행 중 소액(0원 포함) 입금이면서 보낸 주소가 기록된 것에 주소 오염 의심 표시를 붙인다(기간 제한 없음).
 * 주소록 전체(상태 무관)와 lookalike-v2 기준으로 비교한다.
 */
export function poisonFlags(db: DB, orgId: string, rows: { id: string; type: string; amount_units: string; precision: number; asset_code: string; counterparty_address?: string | null }[]): Map<string, PoisonFlag> {
  const out = new Map<string, PoisonFlag>();
  for (const t of rows) {
    if (t.type !== 'deposit' || !t.counterparty_address) continue;
    if (!isDustAmount(String(t.amount_units), Number(t.precision), String(t.asset_code))) continue;
    const top = findLookalikes(db, orgId, t.counterparty_address).matches[0];
    out.set(t.id, { reason: 'dust', lookalike: top ? { id: top.id, label: top.label, status: top.status, prefix: top.prefix, suffix: top.suffix } : null });
  }
  return out;
}
