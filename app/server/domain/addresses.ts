import { randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';
import { now, tx } from '../db.ts';
import { AppError, Errors } from '../errors.ts';
import { writeAudit } from '../audit.ts';
import type { AuthContext } from '../auth.ts';
import {
  checkAddressFormat, CONFIRM_MIDDLE_LENGTH, LOOKALIKE_MAX_MATCHES, LOOKALIKE_RULE_VERSION, lookalikeMatch, middleSegment, normalizeAddress,
  type Finding, type LookalikeFindingMatch,
} from '../../shared/address-rules.ts';
import { assertAssetOnNetwork, getAsset, getNetworkRule, getNetworkRules } from './catalog.ts';
import type { Policy } from '../config.ts';
import { ADDRESS_STATUS, type AddressStatus } from '../../shared/terms.ts';

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
    allowedActions: [] as string[],
  };
  if (auth) {
    if (r.status === 'PENDING_REVIEW' && auth.perms.has('address.review') && r.created_by !== auth.user.id) dto.allowedActions.push('review');
    if ((r.status === 'ACTIVE' || r.status === 'PENDING_REVIEW') && auth.perms.has('address.disable')) dto.allowedActions.push('disable');
  }
  return dto;
}

const SELECT = `SELECT a.*, n.name network_name, cu.name creator_name, ru.name reviewer_name,
    (SELECT COUNT(*) FROM withdrawal_requests wr WHERE wr.address_id = a.id AND wr.org_id = a.org_id AND wr.status IN ('DRAFT','REVIEW','PENDING_APPROVAL')) open_request_count
  FROM address_book a JOIN networks n ON n.code = a.network_code
  JOIN users cu ON cu.id = a.created_by LEFT JOIN users ru ON ru.id = a.reviewed_by`;

export function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
}

export function listAddresses(db: DB, auth: AuthContext, q: { status?: string; assetCode?: string; networkCode?: string; q?: string; sort?: string }) {
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
    : q.sort === 'status' ? "CASE a.status WHEN 'PENDING_REVIEW' THEN 0 WHEN 'ACTIVE' THEN 1 WHEN 'REJECTED' THEN 2 ELSE 3 END, a.created_at DESC"
    : 'a.created_at DESC';
  const rows = db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`).all(...args);
  const total = (db.prepare('SELECT COUNT(*) c FROM address_book WHERE org_id = ?').get(auth.org.id) as { c: number }).c;
  return { items: rows.map((r) => toAddressDto(r, auth)), totalInOrg: total };
}

export function getAddressRow(db: DB, orgId: string, id: string): any {
  const r = db.prepare(`${SELECT} WHERE a.id = ? AND a.org_id = ?`).get(id, orgId);
  if (!r) throw Errors.notFound('주소');
  return r;
}

const STATUS_ORDER: Record<string, number> = { ACTIVE: 0, PENDING_REVIEW: 1, DISABLED: 2, REJECTED: 3 };

/** 같은 글자 수(앞+뒤)가 많은 순서, 같으면 사용 가능 → 확인 대기 → 사용 중지 → 등록 거절 순으로 정렬한다(자르지 않음). */
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

/** 서버 기준 형식 점검 + 같은 조직 주소록의 중복·유사 주소 점검 */
export function checkAddress(db: DB, orgId: string, input: { assetCode: string; networkCode: string; address: string; memo?: string }): { findings: Finding[]; normalized: string } {
  getAsset(db, input.assetCode);
  const network = getNetworkRule(db, input.networkCode);
  assertAssetOnNetwork(db, input.assetCode, input.networkCode);
  const findings = checkAddressFormat(input, network, getNetworkRules(db));
  const normalized = normalizeAddress(input.address, network.family);
  if (!findings.some((f) => f.level === 'error')) {
    // 중복은 쓰는 중인 주소(확인 대기·사용 가능)만 본다. 고유 인덱스와 같은 기준이다.
    const live = db.prepare("SELECT label, address, memo, asset_code, network_code FROM address_book WHERE org_id = ? AND status IN ('PENDING_REVIEW','ACTIVE')").all(orgId) as any[];
    const memo = (input.memo ?? '').trim();
    const dup = live.find((r) => r.address === normalized && r.network_code === input.networkCode && r.asset_code === input.assetCode && r.memo === memo);
    if (dup) {
      findings.unshift({ code: 'ADDRESS_DUPLICATE', level: 'error', message: `이미 '${dup.label}'(으)로 등록된 주소입니다.`, action: '기존 주소를 사용하거나, 사용 중지 후 다시 등록하세요.' });
    }
    // 유사 주소는 사용 중지·거절된 주소까지 모두 본다.
    const scan = findLookalikes(db, orgId, normalized);
    if (scan.matches.length) findings.unshift(lookalikeFinding(scan.matches, scan.total));
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

export function createAddress(db: DB, auth: AuthContext, policy: Policy, input: { label: string; counterparty: string; assetCode: string; networkCode: string; address: string; memo: string; confirmTail: string; confirmMiddle: string; lookalikeReason?: string }) {
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
    const reason = (input.lookalikeReason ?? '').trim();
    if (matches.length && reason.length < 5) {
      throw new AppError(422, 'REASON_REQUIRED', '비슷한 기존 주소가 있어 등록 사유가 필요합니다.', '받는 곳에 어떤 연락 수단으로 전체 주소를 확인했는지, 기존 주소와 어떻게 다른지 5자 이상 적어 주세요.', [{ field: 'lookalikeReason', message: '등록 사유를 5자 이상 입력하세요.' }], { findings });
    }
    const lookalikeReason = matches.length ? reason : null;
    const id = randomUUID();
    const status: AddressStatus = policy.addressBook.requireSecondPersonReview ? 'PENDING_REVIEW' : 'ACTIVE';
    db.prepare(
      `INSERT INTO address_book (id, org_id, label, counterparty, asset_code, network_code, address, memo, status, created_by, created_at, check_findings, lookalike_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, auth.org.id, input.label.trim(), input.counterparty.trim(), input.assetCode, input.networkCode, normalized, (input.memo ?? '').trim(), status, auth.user.id, now(), JSON.stringify(findings), lookalikeReason);
    writeAudit(db, {
      orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'address.created', targetType: 'address', targetId: id,
      summary: `주소 등록 요청: ${input.label.trim()} (${input.assetCode}/${input.networkCode})`,
      detail: {
        assetCode: input.assetCode, networkCode: input.networkCode, addressTail: normalized.slice(-6), memoSet: !!(input.memo ?? '').trim(),
        warnings: findings.filter((f) => f.level === 'warning').map((f) => f.code),
        ruleVersion: LOOKALIKE_RULE_VERSION, lookalike: auditMatches(matches), lookalikeReason,
      },
    });
    return { address: toAddressDto(getAddressRow(db, auth.org.id, id), auth), findings };
  });
}

export function reviewAddress(db: DB, auth: AuthContext, policy: Policy, id: string, input: { decision: 'approve' | 'reject'; note: string; version: number; confirmTail: string; confirmMiddle?: string }) {
  type Outcome = { kind: 'refreshed'; added: LookalikeFindingMatch[] } | { kind: 'done'; dto: ReturnType<typeof toAddressDto> };
  const out = tx<Outcome>(db, () => {
    const r = getAddressRow(db, auth.org.id, id);
    if (r.created_by === auth.user.id) {
      throw new AppError(403, 'SELF_REVIEW_FORBIDDEN', '본인이 등록한 주소는 직접 확인할 수 없습니다.', '다른 승인자에게 확인을 요청하세요.');
    }
    if (r.status !== 'PENDING_REVIEW') throw Errors.conflict(`이미 '${ADDRESS_STATUS[r.status as AddressStatus].label}' 상태인 주소입니다.`);
    if (r.version !== input.version) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
    const note = input.note.trim();
    if (input.decision === 'reject' && note.length < 5) {
      throw new AppError(422, 'VALIDATION', '거절 사유를 5자 이상 입력하세요.', '등록자가 무엇을 고쳐야 하는지 알 수 있게 적어 주세요.', [{ field: 'note', message: '거절 사유를 5자 이상 입력하세요.' }]);
    }
    const seen = parseFindings(r.check_findings);
    const seenMatches = lookalikeMatchesOf(seen);
    if (input.decision === 'approve') {
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
      if (seenMatches.length && note.length < 5) {
        throw new AppError(422, 'NOTE_REQUIRED', '비슷한 기존 주소가 있어 확인 메모가 필요합니다.', '받는 곳에 어떤 연락 수단으로 전체 주소를 확인했는지 5자 이상 적어 주세요.', [{ field: 'note', message: '확인한 방법을 5자 이상 입력하세요.' }]);
      }
    }
    const status: AddressStatus = input.decision === 'approve' ? 'ACTIVE' : 'REJECTED';
    const res = db.prepare('UPDATE address_book SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, version = version + 1 WHERE id = ? AND org_id = ? AND version = ?')
      .run(status, auth.user.id, now(), note || null, id, auth.org.id, input.version);
    if (res.changes !== 1) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
    // 확인 담당자가 화면에서 본 점검 결과(저장된 결과)를 함께 남긴다.
    const seenDetail = { ruleVersion: LOOKALIKE_RULE_VERSION, findings: seen.map((f) => f.code), lookalike: auditMatches(seenMatches) };
    writeAudit(db, {
      orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name,
      action: input.decision === 'approve' ? 'address.approved' : 'address.rejected', targetType: 'address', targetId: id,
      summary: `${input.decision === 'approve' ? '주소 확인 완료' : '주소 등록 거절'}: ${r.label}`,
      detail: input.decision === 'reject' ? { reason: note, ...seenDetail } : { ...seenDetail, ...(note ? { note } : {}) },
    });
    return { kind: 'done', dto: toAddressDto(getAddressRow(db, auth.org.id, id), auth) };
  });
  // 점검 결과 갱신과 그 감사 기록은 위 트랜잭션에서 함께 저장(커밋)한 뒤 알린다. 이 함수를 바깥 트랜잭션으로 감싸면 둘 다 취소되므로 감싸지 않는다.
  // 화면은 409를 받으면 주소를 다시 불러와 갱신된 비교 내용을 보여 준다(입력값은 유지).
  if (out.kind === 'refreshed') {
    const labels = out.added.map((m) => `'${m.label}'`).join(', ');
    throw new AppError(409, 'LOOKALIKE_UPDATED', `등록 뒤에 비슷한 주소(${labels})가 새로 확인되어 점검 결과를 갱신했습니다.`, '갱신된 점검 결과와 글자 비교가 화면에 다시 표시됩니다. 새로 표시된 주소와 가운데를 포함한 전체 글자를 대조하고, 어떻게 확인했는지 메모를 남긴 뒤 다시 확인하세요.');
  }
  return out.dto;
}

export function disableAddress(db: DB, auth: AuthContext, id: string, version: number) {
  return tx(db, () => {
    const r = getAddressRow(db, auth.org.id, id);
    if (!['ACTIVE', 'PENDING_REVIEW'].includes(r.status)) throw Errors.conflict('이미 사용할 수 없는 주소입니다.');
    const res = db.prepare("UPDATE address_book SET status = 'DISABLED', version = version + 1 WHERE id = ? AND org_id = ? AND version = ?").run(id, auth.org.id, version);
    if (res.changes !== 1) throw Errors.conflict('다른 사용자가 먼저 이 주소를 변경했습니다.');
    writeAudit(db, { orgId: auth.org.id, actorId: auth.user.id, actorName: auth.user.name, action: 'address.disabled', targetType: 'address', targetId: id, summary: `주소 사용 중지: ${r.label}` });
    return toAddressDto(getAddressRow(db, auth.org.id, id), auth);
  });
}
