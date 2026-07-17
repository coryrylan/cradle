import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PKG_ROOT = resolve(import.meta.dirname, '..');

/**
 * Guards the embedded-resource inlining across the bundler boundary. The in-process
 * tests run native TS and never cross `bun build`, so a regression in the
 * `with { type: 'json' }` inlining (`cradle-pi.json`) would ship a binary missing its
 * base sandbox profile, undetected without this. Mirrors the shipped `build:js` command.
 */
describe('embedded-resource inlining', () => {
  let outDir: string;
  let bundle: string;
  let outFiles: string[];

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'cradle-bundle-'));
    const proc = Bun.spawn(
      ['bun', 'build', './src/index.ts', `--outdir=${outDir}`, '--target=bun', '--format=esm', '--minify'],
      { cwd: PKG_ROOT, stdout: 'pipe', stderr: 'pipe' }
    );
    const code = await proc.exited;
    if (code !== 0) throw new Error(`bun build failed: ${await new Response(proc.stderr).text()}`);
    bundle = await readFile(join(outDir, 'index.js'), 'utf8');
    outFiles = await readdir(outDir);
  });

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('produces a single bundle with no sidecar asset dir', () => {
    expect(outFiles).toContain('index.js');
    expect(outFiles).not.toContain('assets');
  });

  it('inlines the cradle-pi nono profile', () => {
    expect(bundle).toContain('cradle-pi');
    expect(bundle).toContain('node_runtime');
  });
});
