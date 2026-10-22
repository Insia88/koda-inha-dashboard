// 개발 DB를 지우고 마이그레이션·모의 데이터를 다시 만든다. 운영 데이터에 사용하지 않는다.
import { rmSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { migrate, openDb } from './db.ts';
import { seed } from './seed.ts';

const cfg = loadConfig();
for (const suffix of ['', '-wal', '-shm']) rmSync(cfg.dbPath + suffix, { force: true });
const db = openDb(cfg.dbPath);
const ran = migrate(db);
seed(db);
console.log(`DB 초기화 완료: ${cfg.dbPath}\n적용한 마이그레이션: ${ran.join(', ')}`);
db.close();