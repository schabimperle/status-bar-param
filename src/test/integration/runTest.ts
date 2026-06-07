import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { runTests } from '@vscode/test-electron';

/**
 * Launcher for the real-host smoke layer. Downloads a VS Code build and runs
 * ./index.ts inside its extension host, with ./fixtures/workspace opened so the
 * extension parses a real .vscode/tasks.json. Run via `npm run test:integration`
 * (the `integration` CI job wraps it in xvfb) — see ./index.ts for details.
 *
 * We also point VS Code at a throwaway --user-data-dir seeded with a global
 * (user) tasks.json so ./index.ts can verify, against the real API, the
 * primitives the remote user-tasks path relies on: that user inputs are exposed
 * through the `tasks` configuration, and that the file is opened/written via the
 * built-in command + applyEdit (see JsonFile.useDocumentIO). The seeded file has
 * a `tasks` entry so "Open User Tasks" opens it directly instead of prompting for
 * a template.
 */
function seedUserTasks(): { userDataDir: string; userTasksPath: string } {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbp-itest-'));
    const userTasksPath = path.join(userDataDir, 'User', 'tasks.json');
    fs.mkdirSync(path.dirname(userTasksPath), { recursive: true });
    fs.writeFileSync(
        userTasksPath,
        JSON.stringify(
            {
                version: '2.0.0',
                tasks: [{ label: 'noop', type: 'shell', command: 'echo', problemMatcher: [] }],
                inputs: [{ id: 'userParam', type: 'command', command: 'statusBarParam.get.userParam', args: ['x', 'y'] }],
            },
            null,
            2,
        ),
    );
    return { userDataDir, userTasksPath };
}

async function main(): Promise<void> {
    try {
        // repo root (out/test/integration -> ../../../)
        const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
        // the module exporting run()
        const extensionTestsPath = path.resolve(__dirname, './index');
        // fixture workspace lives in src (not compiled); resolve it from the repo root
        const workspacePath = path.resolve(extensionDevelopmentPath, 'src/test/integration/fixtures/workspace');

        const { userDataDir, userTasksPath } = seedUserTasks();

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            // open the fixture folder; disable trust so the shell-command param runs;
            // use the seeded user-data dir so the global tasks.json is known
            launchArgs: [workspacePath, '--disable-workspace-trust', `--user-data-dir=${userDataDir}`],
            // tell the in-host tests where the seeded user tasks.json lives
            extensionTestsEnv: { SBP_USER_TASKS: userTasksPath },
        });
    } catch (err) {
        console.error('Integration smoke tests failed', err);
        process.exit(1);
    }
}

main();
