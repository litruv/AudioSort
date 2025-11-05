/// <reference types="node" />
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

/**
 * Resolves the Electron binary path based on the current platform.
 * @returns {string} Absolute path to the Electron executable.
 */
function resolveElectronBinary(): string {
  const base = path.resolve(dirname, '../node_modules/.bin');
  if (process.platform === 'win32') {
    return path.join(base, 'electron.cmd');
  }
  return path.join(base, 'electron');
}

/**
 * Boots Electron pointing at the TypeScript main entry so tsx can transpile on the fly.
 */
function launchElectron(): void {
  const electronBinary = resolveElectronBinary();
  const mainEntry = path.resolve(dirname, '../src/main/index.ts');
  const child = spawn(electronBinary, [mainEntry], {
    stdio: 'inherit',
    env: { ...process.env }
  });

  child.on('close', (code?: number) => {
    process.exit(code ?? 0);
  });
}

launchElectron();
