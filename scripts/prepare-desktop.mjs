import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  console.error('Build Relay Desktop on Windows x64. This step copies your Windows Node runtime and the Windows native SQLite module.');
  process.exit(1);
}

const nodeModules = path.join(root, 'node_modules');
if (!fs.existsSync(nodeModules)) {
  console.error('Dependencies are missing. Run SETUP DESKTOP BUILDER.bat once before building the installer.');
  process.exit(1);
}

const listing = spawnSync('npm ls --workspace=server --all --parseable --omit=dev', {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
  shell: true
});
if (!listing.stdout || listing.status !== 0) {
  console.error(listing.stderr || 'Could not inspect the server production dependencies.');
  process.exit(1);
}

const stage = path.join(root, 'desktop-stage', 'node_modules');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const copied = new Set();
for (const rawLine of listing.stdout.split(/\r?\n/)) {
  const source = rawLine.trim();
  if (!source || !fs.existsSync(source)) continue;
  const resolved = path.resolve(source);
  const prefix = nodeModules + path.sep;
  if (!resolved.toLowerCase().startsWith(prefix.toLowerCase())) continue;
  const relative = path.relative(nodeModules, resolved);
  if (!relative || relative.startsWith('..')) continue;
  const destination = path.join(stage, relative);
  const key = relative.toLowerCase();
  if (copied.has(key)) continue;
  copied.add(key);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(resolved, destination, { recursive: true, dereference: true, force: true });
}

const runtimeDir = path.join(root, 'desktop-runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
fs.copyFileSync(process.execPath, path.join(runtimeDir, 'node.exe'));

const requiredRuntime = [
  ...['better-sqlite3', 'bcryptjs', 'cookie-parser', 'cors', 'dotenv', 'express', 'express-rate-limit', 'helmet', 'multer', 'nanoid', 'socket.io', 'zod'].map(name => path.join(stage, name))
];
for (const dependency of requiredRuntime) {
  if (!fs.existsSync(dependency)) {
    console.error(`Required production dependency was not staged: ${path.basename(dependency)}`);
    process.exit(1);
  }
}
console.log(`Prepared ${copied.size} production dependency folders.`);
console.log(`Bundled local Node runtime: ${process.version}`);
console.log('Desktop runtime staging is ready.');
