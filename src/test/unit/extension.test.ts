import * as vscode from 'vscode';
import * as extension from '../../extension';
import { Strings } from '../../strings';
import { JsonFile } from '../../jsonFile';

const registerCommand = vscode.commands.registerCommand as jest.Mock;
const registerTreeDataProvider = vscode.window.registerTreeDataProvider as jest.Mock;
const readFile = vscode.workspace.fs.readFile as jest.Mock;

let createWatcher: jest.SpyInstance;
let workspaceFoldersGet: jest.SpyInstance;
let workspaceFileGet: jest.SpyInstance;

function makeContext(): vscode.ExtensionContext {
    return {
        subscriptions: [],
        workspaceState: { get: jest.fn(), update: jest.fn(), keys: jest.fn(() => []) },
        globalStorageUri: vscode.Uri.file('/global/storage/state'),
    } as unknown as vscode.ExtensionContext;
}

function lastHandler(mock: jest.Mock): (...args: unknown[]) => unknown {
    return mock.mock.calls.at(-1)![0] as (...args: unknown[]) => unknown;
}

beforeAll(() => {
    createWatcher = jest.spyOn(vscode.workspace, 'createFileSystemWatcher');
    workspaceFoldersGet = jest.spyOn(vscode.workspace, 'workspaceFolders', 'get');
    workspaceFileGet = jest.spyOn(vscode.workspace, 'workspaceFile', 'get');
});

beforeEach(() => {
    createWatcher.mockImplementation(
        () =>
            ({
                onDidChange: jest.fn(),
                onDidCreate: jest.fn(),
                onDidDelete: jest.fn(),
                dispose: jest.fn(),
            }) as unknown as vscode.FileSystemWatcher,
    );
    readFile.mockResolvedValue(Buffer.from('{}'));
    registerCommand.mockReturnValue(new vscode.Disposable(() => undefined));
    jest.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
        get: (_key: string, def?: unknown) => def,
        inspect: () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
    workspaceFoldersGet.mockReturnValue(undefined);
    workspaceFileGet.mockReturnValue(undefined);
});

describe('activate', () => {
    it('registers every command and the tree view', () => {
        workspaceFoldersGet.mockReturnValue([{ uri: vscode.Uri.file('/ws'), name: 'ws', index: 0 }]);

        extension.activate(makeContext());

        for (const command of [
            Strings.COMMAND_ADD,
            Strings.COMMAND_ADD_TO_FILE,
            Strings.COMMAND_OPEN_FILE,
            Strings.COMMAND_RESET_SELECTIONS,
            Strings.COMMAND_SELECT,
            Strings.COMMAND_EDIT,
            Strings.COMMAND_COPY_CMD,
            Strings.COMMAND_DELETE,
        ]) {
            expect(registerCommand).toHaveBeenCalledWith(command, expect.any(Function));
        }
        expect(registerTreeDataProvider).toHaveBeenCalledWith(Strings.EXTENSION_ID, expect.anything());
    });

    it('watches the workspace file when one is open', () => {
        workspaceFileGet.mockReturnValue(vscode.Uri.file('/ws/test.code-workspace'));

        extension.activate(makeContext());

        const patterns = createWatcher.mock.calls.map((call) => (call[0] as { pattern: string }).pattern);
        expect(patterns).toContain('test.code-workspace');
    });

    it('watches the global user tasks.json under the user-data dir in a local window', () => {
        extension.activate(makeContext());

        // globalStorageUri (/global/storage/state) /../../tasks.json -> /global/tasks.json,
        // so the global tasks file is watched in /global with the file scheme kept (local window)
        const base = createWatcher.mock.calls
            .map((call) => (call[0] as { baseUri: vscode.Uri }).baseUri)
            .find((uri) => uri.path === '/global' && uri.scheme === 'file');
        expect(base).toBeDefined();
    });

    it('observes the global user tasks.json via the tasks config (not a file watcher) in a remote window', () => {
        const env = vscode.env as { remoteName?: string };
        env.remoteName = 'ssh-remote';
        try {
            extension.activate(makeContext());

            // workbench-owned vscode-userdata scheme is unreachable via file watchers
            expect(vscode.workspace.onDidChangeConfiguration as jest.Mock).toHaveBeenCalled();
            const userdataWatcher = createWatcher.mock.calls
                .map((call) => (call[0] as { baseUri: vscode.Uri }).baseUri)
                .find((uri) => uri.scheme === 'vscode-userdata');
            expect(userdataWatcher).toBeUndefined();
        } finally {
            env.remoteName = undefined;
        }
    });

    it('wires the configuration, workspace-folder and trust event handlers without throwing', () => {
        const context = makeContext();
        extension.activate(context);

        // invoking the registered handlers exercises refresh / add+remove folder / trust
        expect(() => lastHandler(vscode.workspace.onDidChangeConfiguration as jest.Mock)({ affectsConfiguration: () => true })).not.toThrow();
        expect(() =>
            lastHandler(vscode.workspace.onDidChangeWorkspaceFolders as jest.Mock)({
                added: [{ uri: vscode.Uri.file('/added'), name: 'added', index: 1 }],
                removed: [],
            }),
        ).not.toThrow();
        expect(() => lastHandler(vscode.workspace.onDidGrantWorkspaceTrust as jest.Mock)()).not.toThrow();
    });

    it("disposes only the removed folder's json files when a workspace folder is removed", () => {
        // two folders, so removal must target one without touching the other
        const kept = { uri: vscode.Uri.file('/kept'), name: 'kept', index: 0 };
        const removed = { uri: vscode.Uri.file('/removed'), name: 'removed', index: 1 };
        workspaceFoldersGet.mockReturnValue([kept, removed]);

        extension.activate(makeContext());

        // each folder contributes one watcher per input file (tasks.json + launch.json);
        // RelativePattern keeps the originating folder as its `base`, so group by it
        const watchersFor = (folder: unknown) =>
            createWatcher.mock.calls
                .map((call, i) => ({ base: (call[0] as { base: unknown }).base, watcher: createWatcher.mock.results[i].value }))
                .filter((entry) => entry.base === folder)
                .map((entry) => entry.watcher);
        const removedWatchers = watchersFor(removed);
        const keptWatchers = watchersFor(kept);
        expect(removedWatchers).toHaveLength(2);
        expect(keptWatchers).toHaveLength(2);

        lastHandler(vscode.workspace.onDidChangeWorkspaceFolders as jest.Mock)({ added: [], removed: [removed] });

        removedWatchers.forEach((watcher) => expect(watcher.dispose).toHaveBeenCalled());
        keptWatchers.forEach((watcher) => expect(watcher.dispose).not.toHaveBeenCalled());
    });

    it('removes a folder matched by uri even when the event carries a different object', () => {
        // VS Code does not guarantee the folder in the `removed` event is the same
        // object reference we stored on add; matching by uri must still dispose it
        const folder = { uri: vscode.Uri.file('/removed'), name: 'removed', index: 0 };
        workspaceFoldersGet.mockReturnValue([folder]);

        extension.activate(makeContext());

        // the folder's own watchers (one per input file), excluding the unrelated
        // global user-tasks watcher
        const folderWatchers = createWatcher.mock.calls
            .map((call, i) => ({ base: (call[0] as { base: unknown }).base, watcher: createWatcher.mock.results[i].value }))
            .filter((entry) => entry.base === folder)
            .map((entry) => entry.watcher);
        expect(folderWatchers).toHaveLength(2);

        // a fresh object with the same uri, as VS Code may hand back
        const removedCopy = { uri: vscode.Uri.file('/removed'), name: 'removed', index: 0 };
        lastHandler(vscode.workspace.onDidChangeWorkspaceFolders as jest.Mock)({ added: [], removed: [removedCopy] });

        folderWatchers.forEach((watcher) => expect(watcher.dispose).toHaveBeenCalled());
    });
});

describe('param command fallback picker', () => {
    function editHandler(): (param?: unknown) => Promise<void> {
        extension.activate(makeContext());
        const call = registerCommand.mock.calls.find((c) => c[0] === Strings.COMMAND_EDIT)!;
        return call[1] as (param?: unknown) => Promise<void>;
    }

    it('acts directly on a param passed by the tree view', async () => {
        const reveal = jest.fn();
        await editHandler()({ reveal, id: 'p', onGet: () => '', getIcon: () => new vscode.ThemeIcon('array') });
        expect(reveal).toHaveBeenCalled();
    });

    it('prompts for a param when invoked without one', async () => {
        const reveal = jest.fn();
        (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({
            param: { reveal, id: 'p', onGet: () => '', getIcon: () => new vscode.ThemeIcon('array') },
        });
        await editHandler()();
        expect(vscode.window.showQuickPick).toHaveBeenCalled();
        expect(reveal).toHaveBeenCalled();
    });
});

describe('open-file command', () => {
    function openHandler(): (jsonFile?: unknown) => void {
        extension.activate(makeContext());
        const call = registerCommand.mock.calls.find((c) => c[0] === Strings.COMMAND_OPEN_FILE)!;
        return call[1] as (jsonFile?: unknown) => void;
    }

    it('opens a JsonFile handed over by the tree node', () => {
        const open = jest.spyOn(JsonFile.prototype, 'open').mockResolvedValue(undefined);
        try {
            // a real JsonFile instance (prototype chain) so the handler's instanceof passes
            openHandler()(Object.create(JsonFile.prototype));
            expect(open).toHaveBeenCalled();
        } finally {
            open.mockRestore();
        }
    });

    it('ignores a non-JsonFile argument (e.g. a focused param node)', () => {
        const open = jest.spyOn(JsonFile.prototype, 'open').mockResolvedValue(undefined);
        try {
            openHandler()({ id: 'p' });
            expect(open).not.toHaveBeenCalled();
        } finally {
            open.mockRestore();
        }
    });
});

describe('deactivate', () => {
    it('disposes the json files created during activation', () => {
        extension.activate(makeContext());
        const watcher = createWatcher.mock.results.at(-1)!.value;
        extension.deactivate();
        expect(watcher.dispose).toHaveBeenCalled();
    });

    it('does not throw when called before activate (e.g. if activation failed)', () => {
        // VS Code may call deactivate even if no instance was created; the guard
        // (extension?.dispose()) must tolerate that and a repeated deactivate.
        expect(() => {
            extension.deactivate();
            extension.deactivate();
        }).not.toThrow();
    });
});
