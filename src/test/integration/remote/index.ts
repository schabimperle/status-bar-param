import * as assert from 'assert';
import * as vscode from 'vscode';
import { Check, runChecks, sharedChecks, waitFor } from '../shared';

/**
 * Smoke layer for a *genuine* remote window (UI local, extension host remote),
 * driven by ../remoteRunTest.ts over SSH-to-localhost — the only layer that
 * reproduces the UI-side/remote-side split the user-tasks fix is about. The
 * extension is installed in the remote host.
 *
 * It opens the same ./fixtures/workspace as the local runner (localhost == the
 * remote, so the path resolves on both sides), so the host-agnostic checks in
 * ../shared.ts run here too — catching remote-host regressions for free. On top
 * of them, the remote-only check below proves the seeded LOCAL user tasks.json
 * surfaces in the remote host via the cross-host `tasks` configuration read.
 *
 * Needs an SSH server, so it runs in CI (the `remote` job in ci.yml). The remote
 * window settles more slowly than a local one, hence the larger polling budget.
 */
const REMOTE_WAIT_MS = 45000;

const remoteChecks: Check[] = [
    {
        // The extension runs in the remote (workspace) host; the get-command routes
        // there. The LOCAL user tasks.json (seeded by remoteRunTest.ts) defines
        // `userParam` as an array param ["x","y"]; resolving it to its default "x"
        // proves the remote extension read user tasks via the cross-host `tasks` config.
        name: 'reads the local user tasks.json across the host boundary',
        fn: async () => {
            const value = await waitFor(
                () =>
                    Promise.resolve(vscode.commands.executeCommand<string>('statusBarParam.get.userParam')).then(
                        (v) => v,
                        () => undefined,
                    ),
                (v) => v === 'x',
                REMOTE_WAIT_MS,
            );
            assert.strictEqual(value, 'x', 'remote extension did not read the local user tasks.json');
        },
    },
];

export async function run(): Promise<void> {
    // the test is only meaningful in a real remote window
    assert.ok(vscode.env.remoteName, `expected a remote window, got remoteName=${vscode.env.remoteName}`);
    await runChecks([...sharedChecks({ timeoutMs: REMOTE_WAIT_MS }), ...remoteChecks]);
}
