import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

// 화면 번들(dist/assets/*.js)은 압축 과정에서 패키지의 저작권 주석이 빠진다. 그래서 MIT 등의 고지는
// public/THIRD_PARTY_LICENSES.txt(빌드 때 dist/THIRD_PARTY_LICENSES.txt로 복사)로 함께 배포한다.
// 이 테스트는 화면 코드가 실제로 끌어오는 패키지를 esbuild로 다시 묶어 찾고, 그 패키지마다
// 이름@버전과 node_modules의 LICENSE 원문이 고지 파일에 그대로 있는지 확인한다.

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTICE_FILE = path.join(APP, 'public', 'THIRD_PARTY_LICENSES.txt');
const NM = 'node_modules/';

type Pkg = { name: string; version: string; dir: string };

/** 공백·줄바꿈 차이를 무시하고 비교한다. */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function licenseTextOf(dir: string): string {
  const file = fs.readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  if (!file) throw new Error(`${dir}에 LICENSE 파일이 없습니다`);
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

/** src/main.tsx에서 시작해 코드 바이트가 실제로 번들에 들어가는 node_modules 패키지. */
async function bundledPackages(): Promise<Pkg[]> {
  const r = await build({
    absWorkingDir: APP,
    entryPoints: ['src/main.tsx'],
    bundle: true,
    minify: true,
    format: 'esm',
    jsx: 'automatic',
    write: false,
    outdir: '.license-check',
    metafile: true,
    logLevel: 'silent',
    // 스타일·글꼴·그림은 따로 고지한다(Pretendard는 public/fonts/PRETENDARD-LICENSE.txt). 여기서는 스크립트만 본다.
    loader: { '.css': 'empty', '.svg': 'empty', '.webp': 'empty', '.png': 'empty', '.woff2': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const found = new Map<string, Pkg>();
  for (const out of Object.values(r.metafile.outputs)) {
    for (const [input, info] of Object.entries(out.inputs)) {
      const p = input.replace(/\\/g, '/');
      const at = p.lastIndexOf(NM);
      if (at < 0 || info.bytesInOutput === 0) continue;
      const rest = p.slice(at + NM.length).split('/');
      const name = rest[0]!.startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]!;
      if (found.has(name)) continue;
      const dir = path.resolve(APP, p.slice(0, at + NM.length) + name);
      const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version as string;
      found.set(name, { name, version, dir });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Vite가 빌드 때 화면 번들에 넣는 모듈 미리 불러오기 보조 코드(modulepreload polyfill)의 고지: Vite 본체 라이선스 부분. */
function viteCore(): Pkg & { text: string } {
  const dir = path.join(APP, 'node_modules', 'vite');
  const all = fs.readFileSync(path.join(dir, 'LICENSE.md'), 'utf8');
  const start = all.indexOf('MIT License');
  const end = all.indexOf('# Licenses of bundled dependencies');
  expect(start, 'vite LICENSE.md 머리 부분을 찾지 못했습니다').toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return { name: 'vite', version: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, dir, text: all.slice(start, end) };
}

describe('화면 번들의 제3자 라이선스 고지 (public/THIRD_PARTY_LICENSES.txt)', () => {
  let pkgs: Pkg[] = [];
  let notice = '';
  // 화면 코드 전체를 한 번 묶는다(한가할 때 약 3초). 다른 테스트 파일·E2E와 함께 돌면 기본 훅 제한(10초)을 넘을 수 있어 넉넉히 둔다.
  beforeAll(async () => {
    pkgs = await bundledPackages();
    notice = fs.existsSync(NOTICE_FILE) ? fs.readFileSync(NOTICE_FILE, 'utf8') : '';
  }, 60_000);

  it('finds the runtime packages the browser bundle is made of', () => {
    const names = pkgs.map((p) => p.name);
    for (const expected of ['react', 'react-dom', 'react-router', '@tanstack/react-query', '@tabler/icons-react']) expect(names).toContain(expected);
    // Zod는 서버 입력 검증에만 쓰며 화면 번들에 들어가지 않는다(THIRD_PARTY_NOTICES.md).
    expect(names).not.toContain('zod');
  });

  it('ships a notice file in public/ so Vite copies it into dist/', () => {
    expect(fs.existsSync(NOTICE_FILE), 'public/THIRD_PARTY_LICENSES.txt가 없습니다').toBe(true);
  });

  it('carries name@version and the verbatim LICENSE text (with copyright line) of every bundled package', () => {
    const body = norm(notice);
    for (const p of pkgs) {
      expect(notice, `${p.name}@${p.version} 머리글`).toContain(`Package: ${p.name}@${p.version}`);
      const text = licenseTextOf(p.dir);
      const copyright = text.split(/\r?\n/).filter((l) => /^Copyright/i.test(l.trim()));
      expect(copyright.length, `${p.name} LICENSE에 저작권 줄이 없습니다`).toBeGreaterThan(0);
      expect(body, `${p.name} LICENSE 원문`).toContain(norm(text));
    }
  });

  it('carries the Vite core notice for the module preload helper that the build injects', () => {
    const v = viteCore();
    expect(notice).toContain(`Package: vite@${v.version}`);
    expect(norm(notice)).toContain(norm(v.text));
  });

  it('lists no package that the bundle does not contain', () => {
    const listed = [...notice.matchAll(/^Package: (\S+)@(\S+)$/gm)].map((m) => m[1]);
    const allowed = new Set([...pkgs.map((p) => p.name), 'vite']);
    expect(listed.filter((n) => !allowed.has(n!))).toEqual([]);
  });

  it('is referenced from THIRD_PARTY_NOTICES.md as the browser bundle notice', () => {
    const md = fs.readFileSync(path.join(APP, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    expect(md.includes('dist/THIRD_PARTY_LICENSES.txt'), 'THIRD_PARTY_NOTICES.md가 화면 번들 고지 파일을 가리키지 않습니다').toBe(true);
    // 화면 번들은 node_modules 없이 dist/만 배포되므로 'node_modules의 LICENSE로 고지된다'고 쓰면 안 된다.
    expect(/node_modules\/<패키지>\/LICENSE`에 포함되어 배포된다/.test(md), '화면 번들의 고지를 node_modules로 설명합니다').toBe(false);
  });
});
