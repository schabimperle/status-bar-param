import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { runTests, downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';

/**
 * Real remote-window smoke test. Connects a local VS Code to localhost over SSH
 * (set up by scripts/setup-ssh-localhost.sh) so the extension runs in a genuine
 * remote extension host while the user data stays local — the split the
 * user-tasks fix targets. ./remote/index.ts then checks the cross-host read.
 *
 * localhost == the SSH remote, so the dev extension is pointed at the remote URI
 * to load it in the remote (workspace) host; the test runner stays local and
 * drives it via commands, which route cross-host. Needs an SSH server + network,
 * so it runs in CI, not the sandbox. Locally on Linux: `scripts/setup-ssh-
 * localhost.sh && npm run test:integration:remote`. Pin a build via SBP_VSCODE_VERSION.
 */
async function main(): Promise<void> {
    const repoRoot = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './remote/index');
    const host = process.env.SBP_SSH_HOST || 'sbp-localhost';
    const version = process.env.SBP_VSCODE_VERSION || 'stable';

    // seed the LOCAL user tasks.json with an array param
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbp-remote-'));
    const userTasksPath = path.join(userDataDir, 'User', 'tasks.json');
    fs.mkdirSync(path.dirname(userTasksPath), { recursive: true });
    fs.writeFileSync(
        userTasksPath,
        JSON.stringify(
            {
                version: '2.0.0',
                inputs: [{ id: 'userParam', type: 'command', command: 'statusBarParam.get.userParam', args: ['x', 'y'] }],
            },
            null,
            2,
        ),
    );

    const vscodeExecutablePath = await downloadAndUnzipVSCode(version);

    // install Remote-SSH into the local (UI) host so the window can connect
    const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    const installRemoteSsh = spawnSync(cli, [...cliArgs, '--install-extension', 'ms-vscode-remote.remote-ssh', '--force'], { stdio: 'inherit' });
    if (installRemoteSsh.status !== 0) {
        throw new Error('failed to install ms-vscode-remote.remote-ssh');
    }

    const remoteRepo = `vscode-remote://ssh-remote+${host}${repoRoot}`;
    // open the same fixture workspace the local runner uses (localhost == the
    // remote, so the path exists on both sides) so the host-agnostic shared checks
    // see the fruit/labelled/shellfruit inputs here too
    const remoteWorkspace = `${remoteRepo}/src/test/integration/fixtures/workspace`;
    await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath: remoteRepo, // load the dev extension in the remote host
        extensionTestsPath,
        extensionTestsEnv: { SBP_USER_TASKS: userTasksPath },
        launchArgs: ['--folder-uri', remoteWorkspace, `--user-data-dir=${userDataDir}`, '--disable-workspace-trust'],
    });
}

main().catch((err) => {
    console.error('Remote smoke test failed', err);
    process.exit(1);
});
