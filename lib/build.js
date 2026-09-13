import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'public');
const files = ['index.html', 'assets/app.js', 'assets/styles.css', 'assets/favicon.svg'];
const allowed = new Set([...files, 'assets']);

async function verifyExistingOutput(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink() || !allowed.has(relative)) {
      throw new Error('The public directory contains an unexpected file or link. Use a clean build output directory.');
    }
    if (entry.isDirectory()) await verifyExistingOutput(resolve(directory, entry.name), relative + '/');
  }
}

await mkdir(output, { recursive: true });
if ((await lstat(output)).isSymbolicLink()) throw new Error('The public output directory must not be a symbolic link.');
await verifyExistingOutput(output);
await mkdir(resolve(output, 'assets'), { recursive: true });
for (const file of files) await copyFile(resolve(root, file), resolve(output, file));
console.log(`Built ${files.length} allowlisted frontend files into public/. API handlers remain in api/.`);
