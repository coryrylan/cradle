import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const cliDir = '../cli';
const outDir = 'dist';

const binaries = (await readdir(join(cliDir, 'dist'))).filter(file => file.startsWith('cradle-'));
if (binaries.length === 0) {
  throw new Error(`no cradle-* binaries found in ${join(cliDir, 'dist')} — run the cli build first`);
}

await mkdir(join(outDir, 'bin'), { recursive: true });
await copyFile(join(cliDir, 'install.sh'), join(outDir, 'install.sh'));
await Promise.all(binaries.map(file => copyFile(join(cliDir, 'dist', file), join(outDir, 'bin', file))));
