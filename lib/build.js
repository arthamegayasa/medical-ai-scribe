import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDevOnly, isPrivatePath } from './publish.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Documentation, tests, dotfiles and development-only files stay in the repository; only the site
// is published. See lib/publish.js (the local server uses the same rules).
const skip = relativePath => isPrivatePath(relativePath) || isDevOnly(relativePath);

async function copyTree(source, output, prefix = '') {
  let count = 0;
  await mkdir(output, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const relativePath = `${prefix}${entry.name}`;
    if (skip(relativePath)) continue;
    const from = resolve(source, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing to publish a symbolic link: ${entry.name}`);
    if (entry.isDirectory()) count += await copyTree(from, resolve(output, entry.name), `${relativePath}/`);
    else if (entry.isFile()) { await copyFile(from, resolve(output, entry.name)); count++; }
  }
  return count;
}

/** Rebuilds `output` as a clean copy of the publishable files in `source`. */
export async function buildSite({ source = resolve(ROOT, 'web'), output = resolve(ROOT, 'public') } = {}) {
  const sourceStat = await lstat(source).catch(() => null);
  if (!sourceStat?.isDirectory()) throw new Error('The web/ directory is missing; there is nothing to publish.');
  const outputStat = await lstat(output).catch(() => null);
  if (outputStat?.isSymbolicLink()) throw new Error('The public output directory must not be a symbolic link.');
  if (outputStat) await rm(output, { recursive: true });
  return copyTree(source, output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const count = await buildSite();
  console.log(`Built ${count} files from web/ into public/. API handlers remain in api/.`);
}
