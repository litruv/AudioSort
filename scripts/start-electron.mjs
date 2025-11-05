/** @typedef {import('node:child_process').ChildProcess} ChildProcess */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import treeKill from 'tree-kill';
import electronPath from 'electron';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const distMainEntry = path.resolve(dirname, '../dist/main/main/index.js');
const distMainDir = path.dirname(distMainEntry);
let child = /** @type {ChildProcess | null} */ (null);
let restartTimer = /** @type {NodeJS.Timeout | null} */ (null);
let isStarting = false;

/**
 * Simple debounce helper to avoid rapid restarts.
 * @param {() => void} fn
 * @param {number} delayMs
 */
function schedule(fn, delayMs) {
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    fn();
  }, delayMs);
}

/**
 * Waits until the compiled main bundle exists before attempting to launch Electron.
 * @returns {Promise<void>}
 */
async function waitForBundle() {
  if (fs.existsSync(distMainEntry)) {
    return;
  }
  await new Promise((resolve) => {
    const interval = setInterval(() => {
      if (fs.existsSync(distMainEntry)) {
        clearInterval(interval);
        resolve();
      }
    }, 250);
  });
}

/**
 * Starts Electron pointing at the compiled JavaScript main entry.
 */
function launchElectron() {
  if (child) {
    return;
  }
  isStarting = true;
  const spawnOptions = {
    stdio: 'inherit',
    env: { ...process.env },
    windowsHide: false
  };
  child = spawn(electronPath, [distMainEntry], spawnOptions);

  child.on('close', (code) => {
    if (code !== 0) {
      console.error(`Electron exited with code ${code ?? 'unknown'}`);
    }
    child = null;
    isStarting = false;
  });

  setTimeout(() => {
    isStarting = false;
  }, 1000);
}

/**
 * Kills the current Electron process if it is running.
 */
function disposeElectron() {
  if (child?.pid) {
    try {
      treeKill(child.pid, 'SIGTERM');
    } catch (error) {
      console.warn('Failed to terminate Electron process', error);
    }
  }
  child = null;
}

/**
 * Initializes the dev runner by waiting for the bundle, launching Electron, and watching for rebuilds.
 */
async function bootstrap() {
  await waitForBundle();
  launchElectron();

  const watcher = fs.watch(distMainDir, { recursive: true }, (eventType, filename) => {
    if (!filename || isStarting || child === null) {
      return;
    }
    if (filename.endsWith('.js') || filename.endsWith('.js.map')) {
      schedule(() => {
        disposeElectron();
        launchElectron();
      }, 500);
    }
  });

  process.on('SIGINT', () => {
    watcher.close();
    disposeElectron();
    process.exit(0);
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
