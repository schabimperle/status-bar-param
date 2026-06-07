#!/usr/bin/env node
/*
 * Ensure the shared libraries the VS Code (Electron) test host needs are present
 * before `npm run test:integration`.
 *
 * Runs automatically via the `pretest:integration` npm hook, so the integration
 * smoke test works the same way on CI and locally — including on a Linux dev
 * container where global apt installs don't survive a restart (this just
 * reinstalls on the next run). It is:
 *   - a no-op on non-Linux (macOS/Windows download a self-contained VS Code),
 *   - a no-op when the libraries are already installed (fast guard, no apt),
 *   - release-agnostic: it tries both the historic and the Ubuntu 24.04 `t64`
 *     package names and ignores the ones that don't exist on this distro.
 */
const { execSync } = require('child_process');

if (process.platform !== 'linux') {
    process.exit(0);
}

/** Run a command, swallowing output; return true on success. */
function tryRun(command) {
    try {
        execSync(command, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Is libgtk-3 (the canonical missing dependency) available to the loader? */
function libsPresent() {
    try {
        // ldconfig usually lives in /sbin, which isn't always on PATH
        const out = execSync('ldconfig -p', {
            env: { ...process.env, PATH: `/sbin:/usr/sbin:${process.env.PATH || ''}` },
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString();
        return /libgtk-3\.so\.0/.test(out);
    } catch {
        return false;
    }
}

if (!tryRun('command -v apt-get')) {
    console.warn('ensure-vscode-test-libs: apt-get not found; install the VS Code host libraries manually if the test host fails to start.');
    process.exit(0);
}

if (libsPresent()) {
    process.exit(0);
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const sudo = isRoot ? '' : (tryRun('command -v sudo') ? 'sudo ' : null);
if (sudo === null) {
    console.warn('ensure-vscode-test-libs: need root (or sudo) to install the VS Code host libraries; skipping.');
    process.exit(0);
}

console.log('ensure-vscode-test-libs: installing VS Code (Electron) host libraries…');

// Both the historic names and the Ubuntu 24.04 time_t (t64) renames; the ones
// that don't exist on this release are simply skipped.
const packages = [
    'libgtk-3-0', 'libgtk-3-0t64',
    'libnss3', 'libnspr4',
    'libatk1.0-0', 'libatk1.0-0t64',
    'libatk-bridge2.0-0', 'libatk-bridge2.0-0t64',
    'libcups2', 'libcups2t64',
    'libdrm2', 'libgbm1',
    'libasound2', 'libasound2t64',
    'libxkbcommon0',
    'libatspi2.0-0', 'libatspi2.0-0t64',
    'libxcomposite1', 'libxdamage1', 'libxfixes3', 'libxrandr2', 'libxshmfence1',
    'libpango-1.0-0', 'libcairo2',
    'xauth', 'xvfb',
];

tryRun(`${sudo}apt-get update`);
for (const pkg of packages) {
    tryRun(`${sudo}apt-get install -y ${pkg}`);
}

if (!libsPresent()) {
    console.error('ensure-vscode-test-libs: libgtk-3 is still missing after the install attempt.');
    process.exit(1);
}
console.log('ensure-vscode-test-libs: VS Code host libraries ready.');
