import type { Role } from '../shared/terms.ts';

export type Permission =
  | 'dashboard.read' | 'asset.read' | 'activity.read' | 'wallet.read' | 'staking.read' | 'catalog.read'
  | 'address.read' | 'address.create' | 'address.review' | 'address.disable'
  | 'request.read' | 'request.create' | 'request.approve'
  | 'org.read' | 'org.manage'
  | 'audit.read' | 'audit.export'
  | 'insight.read' | 'insight.manage';

const CUSTOMER_READ: Permission[] = ['dashboard.read', 'asset.read', 'activity.read', 'wallet.read', 'staking.read', 'catalog.read', 'address.read', 'request.read', 'org.read', 'insight.read'];

// 설계 가정: 실제 KODA 역할·권한 매핑이 확인되지 않아 변경 가능한 기본값으로 둔다 (docs/assumptions.md A-04).
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  requester: [...CUSTOMER_READ, 'address.create', 'request.create'],
  approver: [...CUSTOMER_READ, 'address.review', 'request.approve'],
  auditor: [...CUSTOMER_READ, 'audit.read', 'audit.export'],
  admin: [...CUSTOMER_READ, 'org.manage', 'audit.read', 'address.disable'],
  operator: ['insight.read', 'insight.manage', 'catalog.read'],
};

export function permissionsFor(roles: Role[]): Set<Permission> {
  const s = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) s.add(p);
  return s;
}
