import * as assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Check, runChecks, sharedChecks, waitFor } from './shared';

/**
 * In-host smoke tests for a local window, run by ./runTest.ts via
 * @vscode/test-electron.
 *
 * The real-API layer: it boots an actual VS Code (Electron) instance and checks
 * the extension against the genuine `vscode` API — no mock. It runs headlessly
 * under an emulated display (xvfb on Linux) and is part of the default CI (the
 * `integration` job in ci.yml; GitHub's ubuntu-latest image already ships the
 * GTK/NSS libraries Electron needs, so only xvfb is required). Run it locally
 * with `xvfb-run -a npm run test:integration` on a headless Linux box (on a
 * desktop / macOS / Windows, plain `npm run test:integration`).
 *
 * runTest.ts opens ./fixtures/workspace (with workspace trust disabled) so the
 * extension parses a real .vscode/tasks.json and we can verify end-to-end
 * retrieval through `${command:statusBarParam.get.<id>}`. The behavioural checks
 * in ./shared.ts also run remotely (./remote/index.ts); this file adds the
 * checks that only make sense in a local window: introspecting the extension
 * object (getExtension/getCommands/manifest) — which in a remote window would
 * query the local host, not the remote one the extension runs in — and the
 * vscode-userdata user-tasks I/O. These complement, and do not replace, the
 * headless Jest unit suite (jest-mock-vscode); interactive write flows
 * (add/delete prompts) stay unit-tested rather than UI-driven here.
 */
const LOCAL_WAIT_MS = 15000;

const EXTENSION_ID = 'mschababerle.status-bar-param';
const STATIC_COMMANDS = [
    'statusBarParam.add',
    'statusBarParam.resetSelections',
    'statusBarParam.select',
    'statusBarParam.edit',
    'statusBarParam.copyCmd',
    'statusBarParam.delete',
];

/*
 * Local-only: introspect the extension object directly. These query the
 * extension host the test runner shares with the extension, which holds only in a
 * local window — in a remote window the extension lives in the remote host while
 * this runner is local, so getExtension/getCommands can't see it. The remote
 * smoke proves activation+registration end-to-end through behaviour instead.
 */
const introspectiveChecks: Check[] = [
    {
        name: 'activates the extension',
        fn: async () => {
            const extension = vscode.extensions.getExtension(EXTENSION_ID);
            assert.ok(extension, `extension ${EXTENSION_ID} not found in the test host`);
            await extension.activate();
            assert.ok(extension.isActive, 'extension failed to activate');
        },
    },
    {
        name: 'registers its static commands',
        fn: async () => {
            const registered = await vscode.commands.getCommands(true);
            for (const command of STATIC_COMMANDS) {
                assert.ok(registered.includes(command), `command not registered: ${command}`);
            }
        },
    },
    {
        name: 'contributes the commands and activates on startup in its manifest',
        fn: async () => {
            const manifest = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON;
            const contributed = (manifest.contributes.commands as Array<{ command: string }>).map((c) => c.command);
            for (const command of STATIC_COMMANDS) {
                assert.ok(contributed.includes(command), `command not contributed in package.json: ${command}`);
            }
            assert.ok((manifest.activationEvents as string[]).includes('onStartupFinished'), 'extension does not activate on startup');
        },
    },
];

/*
 * Local-only: validate, against the real API, the primitives the *remote*
 * user-tasks path relies on (extension.getUserTasksUri / JsonFile.useDocumentIO).
 * The extension itself takes the local file: path here (this is a local window),
 * so these exercise the underlying VS Code behaviours directly. runTest.ts seeds
 * a global tasks.json with a `userParam` input under a controlled --user-data-dir.
 * The vscode-userdata scheme is local-machine-only, so these stay out of ./shared.
 */
const isUserTasksDoc = (doc: vscode.TextDocument | undefined): doc is vscode.TextDocument =>
    !!doc && doc.uri.scheme === 'vscode-userdata' && path.posix.basename(doc.uri.path) === 'tasks.json';

async function openUserTasksDoc(): Promise<vscode.TextDocument> {
    await vscode.commands.executeCommand('workbench.action.tasks.openUserTasks');
    return waitFor(() => Promise.resolve(vscode.workspace.textDocuments.find(isUserTasksDoc)), isUserTasksDoc, LOCAL_WAIT_MS) as Promise<vscode.TextDocument>;
}

const localChecks: Check[] = [
    {
        name: 'exposes user-level task inputs through the tasks configuration',
        fn: async () => {
            // the remote display path reads params from here instead of the file
            const inputs = await waitFor(
                () => Promise.resolve(vscode.workspace.getConfiguration('tasks').inspect<Array<{ id: string }>>('inputs')?.globalValue),
                (v) => Array.isArray(v) && v.some((i) => i?.id === 'userParam'),
                LOCAL_WAIT_MS,
            );
            assert.ok(
                inputs!.some((i) => i.id === 'userParam'),
                'seeded user input missing from tasks config globalValue',
            );
        },
    },
    {
        name: 'opens the user tasks.json under the vscode-userdata scheme via the command',
        fn: async () => {
            const doc = await openUserTasksDoc();
            assert.strictEqual(doc.uri.scheme, 'vscode-userdata');
            assert.strictEqual(path.posix.basename(doc.uri.path), 'tasks.json');
        },
    },
    {
        name: 'persists an edit to the user tasks.json via applyEdit + save',
        fn: async () => {
            const userTasksPath = process.env.SBP_USER_TASKS!;
            assert.ok(userTasksPath, 'SBP_USER_TASKS not set by runTest.ts');

            const doc = await openUserTasksDoc();
            const marker = `marker_${Date.now()}`;
            const json = JSON.parse(doc.getText());
            json.inputs.push({ id: marker, type: 'command', command: `statusBarParam.get.${marker}`, args: ['z'] });

            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), JSON.stringify(json, null, 2));
            assert.ok(await vscode.workspace.applyEdit(edit), 'applyEdit returned false');
            assert.ok(await doc.save(), 'save returned false');

            assert.ok(readFileSync(userTasksPath, 'utf8').includes(marker), 'edit was not persisted to the local user tasks.json');
        },
    },
];

export async function run(): Promise<void> {
    await runChecks([...sharedChecks({ timeoutMs: LOCAL_WAIT_MS }), ...introspectiveChecks, ...localChecks]);
}
