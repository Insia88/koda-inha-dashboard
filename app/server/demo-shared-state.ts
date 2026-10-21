import { get, head, put } from '@vercel/blob';
import { tx, type DB } from './db.ts';

const B64 = '__b64';
const BIG = '__big';

/** SQLite 값 → JSON. BLOB(Uint8Array)과 BigInt를 표시해 두었다가 그대로 되돌린다. */
function encodeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return { [B64]: Buffer.from(v).toString('base64') };
  if (typeof v === 'bigint') return { [BIG]: v.toString() };
  return v;
}
function decodeValue(v: unknown): unknown {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o[B64] === 'string') return Buffer.from(o[B64] as string, 'base64');
    if (typeof o[BIG] === 'string') return BigInt(o[BIG] as string);
  }
  return v;
}

/** 모든 테이블을 JSON으로 내보낸다(스키마 마이그레이션 표 포함). 모의 데이터라 크기가 작다. */
function exportSnapshot(db: DB): Record<string, unknown[]> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[];
    out[t] = rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, encodeValue(v)])));
  }
  return out;
}

/** 스냅샷을 현재 DB에 원자적으로 반영한다(외래키 잠시 끔, 한 트랜잭션). */
function importSnapshot(db: DB, tables: Record<string, unknown[]>): void {
  tx(db, () => {
    db.exec('PRAGMA foreign_keys = OFF');
    for (const [t, rows] of Object.entries(tables)) {
      db.exec(`DELETE FROM "${t}"`);
      if (!rows.length) continue;
      const cols = Object.keys(rows[0] as Record<string, unknown>);
      const stmt = db.prepare(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of rows) stmt.run(...cols.map((c) => decodeValue((row as Record<string, unknown>)[c])) as any[]);
    }
    db.exec('PRAGMA foreign_keys = ON');
  });
}

export interface DemoSharedState {
  readonly enabled: boolean;
  /** 다른 인스턴스의 최신 스냅샷을 가져온다(짧은 간격은 건너뜀). 실패하면 조용히 넘어간다. */
  pull(): Promise<void>;
  /** 이 인스턴스의 변경을 공유 저장소에 올린다. 실패해도 요청 처리는 계속한다. */
  push(): Promise<void>;
}

/**
 * 공개 데모 전용 공유 상태(A8).
 * Vercel 함수는 인스턴스마다 메모리 DB가 따로라서, 새 인스턴스로 요청이 가면 방금 만든 요청·승인이 사라져 보였다.
 * Vercel Blob(비공개 저장소, OIDC)에 DB 스냅샷을 두고, 요청 전에 최신본을 당겨오고 변경 뒤에 올려 모든 인스턴스가 같은 데이터를 보게 한다.
 * BLOB_STORE_ID/VERCEL_OIDC_TOKEN이 없으면(로컬 실행) 아무 것도 하지 않는다.
 */
export function createDemoSharedState(db: DB): DemoSharedState {
  const deployment = process.env.VERCEL_URL ?? 'local';
  const key = `demo-state/${deployment}.json`;
  const enabled = process.env.DEMO_SHARED_STATE !== 'off' && !!process.env.BLOB_STORE_ID && !!process.env.VERCEL_OIDC_TOKEN;
  let rev = 0;
  let lastRemoteAt: string | null = null;
  let lastPullAt = 0;
  let inflightPull: Promise<void> | null = null;

  const push = async () => {
    if (!enabled) return;
    try {
      rev += 1;
      const body = JSON.stringify({ rev, at: new Date().toISOString(), tables: exportSnapshot(db) });
      await put(key, body, { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' });
      lastRemoteAt = new Date().toISOString();
    } catch {
      rev = Math.max(0, rev - 1);
    }
  };

  const pull = async () => {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastPullAt < 700) return;
    if (inflightPull) return inflightPull;
    lastPullAt = now;
    inflightPull = (async () => {
      try {
        let info: Awaited<ReturnType<typeof head>> | null = null;
        try { info = await head(key); } catch { info = null; }
        if (!info) {
          await push(); // 첫 인스턴스가 기준 스냅샷을 만든다.
          return;
        }
        const remoteAt = new Date(info.uploadedAt).toISOString();
        if (lastRemoteAt === remoteAt && rev > 0) return;
        const got = await get(key, { access: 'private', useCache: false });
        if (!got) return;
        const text = await new Response(got.stream).text();
        const data = JSON.parse(text) as { rev?: number; tables?: Record<string, unknown[]> };
        if (!data.tables) return;
        if (typeof data.rev === 'number' && data.rev <= rev) { lastRemoteAt = remoteAt; return; }
        importSnapshot(db, data.tables);
        rev = typeof data.rev === 'number' ? data.rev : rev;
        lastRemoteAt = remoteAt;
      } catch {
        /* 공유 저장소가 잠시 안 되면 이 인스턴스 DB로 계속 동작한다. */
      } finally {
        inflightPull = null;
      }
    })();
    return inflightPull;
  };

  return { enabled, pull, push };
}
