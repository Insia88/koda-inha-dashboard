import type { DB } from '../db.ts';
import type { AddressFamily, NetworkRule } from '../../shared/address-rules.ts';
import { AppError } from '../errors.ts';

export interface AssetRow { code: string; name: string; precision: number }

export function getAssets(db: DB): AssetRow[] {
  return db.prepare('SELECT code, name, precision FROM assets ORDER BY code').all() as unknown as AssetRow[];
}

export function getAsset(db: DB, code: string): AssetRow {
  const a = db.prepare('SELECT code, name, precision FROM assets WHERE code = ?').get(code) as AssetRow | undefined;
  if (!a) throw new AppError(422, 'ASSET_UNSUPPORTED', '지원하지 않는 자산입니다.', '토큰 목록에서 지원 자산을 확인하세요.', [{ field: 'assetCode', message: '지원하지 않는 자산입니다.' }]);
  return a;
}

export function getNetworkRules(db: DB): NetworkRule[] {
  const rows = db.prepare('SELECT code, name, family, memo_required, memo_label FROM networks ORDER BY code').all() as any[];
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    family: r.family as AddressFamily,
    memoRequired: !!r.memo_required,
    memoLabel: r.memo_label,
    memoPattern: r.memo_required ? /^(?:[0-9]{1,9}|[1-3][0-9]{9}|4[0-1][0-9]{8}|42[0-8][0-9]{7}|429[0-3][0-9]{6}|4294[0-8][0-9]{5}|42949[0-5][0-9]{4}|429496[0-6][0-9]{3}|4294967[0-1][0-9]{2}|42949672[0-8][0-9]|429496729[0-5])$/ : null,
  }));
}

export function getNetworkRule(db: DB, code: string): NetworkRule {
  const n = getNetworkRules(db).find((x) => x.code === code);
  if (!n) throw new AppError(422, 'NETWORK_UNSUPPORTED', '지원하지 않는 네트워크입니다.', '토큰 목록에서 자산별 지원 네트워크를 확인하세요.', [{ field: 'networkCode', message: '지원하지 않는 네트워크입니다.' }]);
  return n;
}

export function assertAssetOnNetwork(db: DB, assetCode: string, networkCode: string) {
  const ok = db.prepare('SELECT 1 FROM asset_networks WHERE asset_code = ? AND network_code = ?').get(assetCode, networkCode);
  if (!ok) {
    const nets = (db.prepare('SELECT n.name FROM asset_networks an JOIN networks n ON n.code = an.network_code WHERE an.asset_code = ?').all(assetCode) as { name: string }[]).map((r) => r.name);
    throw new AppError(422, 'ASSET_NETWORK_UNSUPPORTED', `${assetCode}은(는) 선택한 네트워크에서 지원하지 않습니다.`, nets.length ? `지원 네트워크: ${nets.join(', ')}` : '토큰 목록을 확인하세요.', [{ field: 'networkCode', message: '이 자산을 지원하지 않는 네트워크입니다.' }]);
  }
}

export function getCatalog(db: DB) {
  const assets = getAssets(db);
  const networks = getNetworkRules(db).map(({ memoPattern, ...n }) => ({ ...n, memoHint: memoPattern ? '숫자 1~10자리 (0 ~ 4294967295)' : null }));
  const pairs = db.prepare('SELECT asset_code assetCode, network_code networkCode FROM asset_networks ORDER BY asset_code, network_code').all();
  return { assets, networks, pairs };
}
