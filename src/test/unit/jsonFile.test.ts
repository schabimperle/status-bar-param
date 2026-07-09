import * as path from 'path';
import * as jsonc from 'jsonc-parser';
import * as vscode from 'vscode';
import { JsonFile } from '../../jsonFile';
import { ExtensionConfig } from '../../config';

const readFile = vscode.workspace.fs.readFile as jest.Mock;
const writeFile = vscode.workspace.fs.writeFile as jest.Mock;
const createDirectory = vscode.workspace.fs.createDirectory as jest.Mock;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakeConfig(): ExtensionConfig {
    const store = new Map<string, unknown>();
    return {
        workspaceState: {
            get: (key: string, def?: unknown) => (store.has(key) ? store.get(key) : def),
            update: (key: string, value: unknown) => {
                store.set(key, value);
                return Promise.resolve();
            },
            keys: () => [...store.keys()],
        },
        showNames: false,
        showSelections: true,
    } as unknown as ExtensionConfig;
}

function makeWatcher() {
    return { onDidChange: jest.fn(), onDidCreate: jest.fn(), onDidDelete: jest.fn(), dispose: jest.fn() };
}

let createWatcher: jest.SpyInstance;

function makeFile(uriPath: string, content = '{}'): JsonFile {
    readFile.mockResolvedValue(Buffer.from(content));
    return JsonFile.createFromPathOutsideWorkspace(1, vscode.Uri.file(uriPath), fakeConfig(), new vscode.EventEmitter());
}

beforeAll(() => {
    // jest-mock-vscode does not implement createFileSystemWatcher
    createWatcher = jest.spyOn(vscode.workspace, 'createFileSystemWatcher');
});

beforeEach(() => {
    createWatcher.mockImplementation(() => makeWatcher() as unknown as vscode.FileSystemWatcher);
    readFile.mockResolvedValue(Buffer.from('{}'));
    writeFile.mockResolvedValue(undefined);
    // mutate() ensures the parent dir exists before writing; the mock rejects by default
    createDirectory.mockResolvedValue(undefined);
    // avoid jest-mock-vscode's command registry rejecting duplicate ids
    (vscode.commands.registerCommand as jest.Mock).mockReturnValue(new vscode.Disposable(() => undefined));
    // user-tasks files read inputs from the `tasks` config; default to empty
    jest.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
        inspect: () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
});

describe('JsonFile path helpers', () => {
    it('getDefaultCwd strips a trailing .vscode segment', () => {
        const file = makeFile('/ws/.vscode/tasks.json');
        expect(file.getDefaultCwd()).toBe(path.dirname(path.dirname(file.uri.fsPath)));
    });

    it('getDefaultCwd returns the containing dir for a file outside .vscode', () => {
        const file = makeFile('/ws/test.code-workspace');
        expect(file.getDefaultCwd()).toBe(path.dirname(file.uri.fsPath));
    });

    it('getDefaultCwd resolves to the root for a .vscode dir at the filesystem root', () => {
        const file = makeFile('/.vscode/tasks.json');
        // the filesystem root, spelled per-platform (`/` posix, `\` win32)
        expect(file.getDefaultCwd()).toBe(path.parse(file.uri.fsPath).root);
    });

    it('getDefaultCwd does not strip a dir merely ending in .vscode', () => {
        const file = makeFile('/ws/my.vscode/tasks.json');
        expect(file.getDefaultCwd()).toBe(path.dirname(file.uri.fsPath));
    });

    it('getFileName returns the basename', () => {
        expect(makeFile('/ws/.vscode/launch.json').getFileName()).toBe('launch.json');
    });

    it('getDescription falls back to the fsPath for an outside-workspace file (e.g. a .code-workspace)', () => {
        const file = makeFile('/ws/test.code-workspace');
        expect(file.getDescription()).toBe(file.uri.fsPath);
    });

    it('getDescription is "User (Global)" for the local user tasks.json, matching the remote label', () => {
        // the local global tasks.json is a plain file with no workspace folder;
        // it must show the same friendly "User (Global)" label as the remote vscode-userdata one
        const file = makeFile('/home/me/.config/Code/User/tasks.json');
        expect(file.getDescription()).toBe('User (Global)');
    });

    it('getJsoncPaths targets the top level for tasks.json', () => {
        expect(makeFile('/ws/.vscode/tasks.json').getJsoncPaths()).toEqual({
            versionPath: ['version'],
            tasksPath: ['tasks'],
            inputsPath: ['inputs'],
        });
    });

    it('getJsoncPaths nests under "tasks" for a .code-workspace file', () => {
        expect(makeFile('/ws/test.code-workspace').getJsoncPaths()).toEqual({
            versionPath: ['tasks', 'version'],
            tasksPath: ['tasks', 'tasks'],
            inputsPath: ['tasks', 'inputs'],
        });
    });
});

describe('JsonFile.detectFormatting', () => {
    it('detects 2-space indentation', () => {
        expect(JsonFile.detectFormatting('{\n  "a": 1\n}')).toEqual({ tabSize: 2, insertSpaces: true });
    });
    it('detects 4-space indentation', () => {
        expect(JsonFile.detectFormatting('{\n    "a": 1\n}')).toEqual({ tabSize: 4, insertSpaces: true });
    });
    it('detects tab indentation', () => {
        expect(JsonFile.detectFormatting('{\n\t"a": 1\n}')).toEqual({ tabSize: 4, insertSpaces: false });
    });
    it('falls back to 4-space for a flat/empty file', () => {
        expect(JsonFile.detectFormatting('{}')).toEqual({ tabSize: 4, insertSpaces: true });
    });
});

describe('JsonFile.displayRank (file list ordering)', () => {
    const folder = { uri: vscode.Uri.file('/ws'), name: 'ws', index: 0 } as vscode.WorkspaceFolder;
    const insideFile = (relativePath: string) => JsonFile.createFromPathInsideWorkspace(1, folder, relativePath, fakeConfig(), new vscode.EventEmitter());

    it('ranks workspace config files (tasks.json / launch.json) first', () => {
        // a config file under a workspace folder has a workspaceFolder, so it is neither
        // the global tasks.json nor the .code-workspace — the common, first-listed case
        expect(insideFile('.vscode/tasks.json').displayRank).toBe(0);
        expect(insideFile('.vscode/launch.json').displayRank).toBe(0);
    });

    it('ranks a .code-workspace file after the local config files', () => {
        expect(makeFile('/ws/team.code-workspace').displayRank).toBe(1);
    });

    it('ranks the user (global) tasks.json last — both the local and the remote form', () => {
        // local: a tasks.json with no workspace folder
        expect(makeFile('/home/me/.config/Code/User/tasks.json').displayRank).toBe(2);
        // remote: the vscode-userdata placeholder
        const remote = JsonFile.createFromPathOutsideWorkspace(
            1,
            vscode.Uri.from({ scheme: 'vscode-userdata', path: '/tasks.json' }),
            fakeConfig(),
            new vscode.EventEmitter(),
        );
        expect(remote.displayRank).toBe(2);
    });
});

describe('JsonFile.addParam', () => {
    function written(): Record<string, unknown> {
        return jsonc.parse((writeFile.mock.calls.at(-1)![1] as Buffer).toString());
    }
    function writtenRaw(): string {
        return (writeFile.mock.calls.at(-1)![1] as Buffer).toString();
    }

    it('writes a command input with the version and no task', async () => {
        const file = makeFile('/ws/.vscode/tasks.json');
        await file.addParam('greeting', ['hi', 'bye'], false);

        const result = written();
        expect(result.version).toBe('2.0.0');
        expect(result.inputs).toEqual([{ id: 'greeting', type: 'command', command: 'statusBarParam.get.greeting', args: ['hi', 'bye'] }]);
        expect(result.tasks).toBeUndefined();
    });

    it('creates the parent directory before writing, so a first add to a clean folder succeeds', async () => {
        const file = makeFile('/ws/.vscode/tasks.json');
        // a fresh workspace has no .vscode/tasks.json yet; writeFile does not create it
        readFile.mockRejectedValue(vscode.FileSystemError.FileNotFound());
        await file.addParam('greeting', ['hi'], false);

        expect(createDirectory).toHaveBeenCalledTimes(1);
        const dir = createDirectory.mock.calls[0][0] as vscode.Uri;
        expect(dir.fsPath).toBe(path.dirname(file.uri.fsPath)); // the .vscode dir
        expect(writeFile).toHaveBeenCalled();
    });

    it('adds a demonstrating sample task when requested', async () => {
        const file = makeFile('/ws/.vscode/tasks.json');
        await file.addParam('greeting', ['hi'], true);

        const tasks = written().tasks as Array<{ label: string }>;
        expect(tasks).toHaveLength(1);
        expect(tasks[0].label).toContain('greeting');
        // a comment above the task object explains it only demonstrates the parameter
        expect(writtenRaw()).toMatch(/\/\/ Sample task demonstrating the use of the 'greeting' parameter\.\n\s*\{/);
    });

    it('passes the parameter reference as its own `args` element, not appended to the command', async () => {
        const file = makeFile('/ws/.vscode/tasks.json');
        await file.addParam('greeting', ['hi'], true);

        const tasks = written().tasks as Array<{ command: string; args: string[] }>;
        // one element == one argument, so a value containing spaces survives intact
        expect(tasks[0].command).toBe('echo');
        expect(tasks[0].args).toEqual(['${input:greeting}']);
    });

    it('builds a named-value sample task that references each per-key command, not the keyless input', async () => {
        const file = makeFile('/ws/.vscode/tasks.json');
        await file.addParam('compiler', [{ displayValue: 'gcc', value: { cc: 'gcc', cxx: 'g++' } }], true);

        const tasks = written().tasks as Array<{ command: string; args: string[] }>;
        // a named value has no keyless value, so the demo references the per-key commands --
        // one `args` element each, so a key's value can never be word-split into two arguments
        expect(tasks[0].args).toEqual(['cc=${command:statusBarParam.get.compiler.cc}', 'cxx=${command:statusBarParam.get.compiler.cxx}']);
        expect(tasks[0].args.join(' ')).not.toContain('${input:compiler}');
    });

    it("keeps the file's existing indentation (no tabs, consistent levels)", async () => {
        // a 2-space file must stay 2-space; the jsonc default ({}) would otherwise
        // emit tabs and re-flow the touched property to column 0 (mixed indent).
        const file = makeFile('/ws/.vscode/tasks.json', '{\n  "version": "2.0.0",\n  "tasks": []\n}\n');
        await file.addParam('greeting', ['hi'], true);

        const raw = writtenRaw();
        expect(raw).not.toContain('\t');
        expect(raw).toContain('\n  "tasks": ['); // top-level key stays at 2 spaces
        expect(raw).toContain('\n    {'); // task object nested one level (4)
        expect(raw).toContain('\n      "label":'); // task props nested two levels (6)
    });

    it('adds a one-time IntelliSense tip comment directly above args, for the first parameter only', async () => {
        // first param into an empty file -> tip comment present, on the line above `args`
        const file = makeFile('/ws/.vscode/tasks.json');
        await file.addParam('first', ['hi'], false);
        const firstRaw = (writeFile.mock.calls.at(-1)![1] as Buffer).toString();
        // two-line tip; the second line sits directly above "args" (both indented)
        expect(firstRaw).toMatch(/\/\/ 'args' can be an array[^\n]*\n\s*\/\/ and advanced options[^\n]*IntelliSense\.\n\s*"args":/);

        // adding into a file that already has an input must not repeat it
        const existing = JSON.stringify({
            version: '2.0.0',
            inputs: [{ id: 'existing', type: 'command', command: 'statusBarParam.get.existing', args: ['x'] }],
        });
        const file2 = makeFile('/ws/.vscode/tasks.json', existing);
        await file2.addParam('second', ['bye'], false);
        const secondRaw = (writeFile.mock.calls.at(-1)![1] as Buffer).toString();
        expect(secondRaw).not.toContain("// 'args'");
    });

    it('writes a header comment above the input and suppresses the generic args tip', async () => {
        const file = makeFile('/ws/.vscode/tasks.json');
        // first param into an empty file: without a header comment it would get the args
        // tip; the explicit header takes its place and sits above the input object
        await file.addParam('demo', ['hi'], false, '// edit me');
        const raw = writtenRaw();
        expect(raw).toMatch(/\/\/ edit me\n\s*\{/);
        // the generic args tip must not also appear
        expect(raw).not.toContain("// 'args'");
    });

    it('does not add a version field to launch.json', async () => {
        const file = makeFile('/ws/.vscode/launch.json');
        await file.addParam('greeting', ['hi'], false);

        const result = written();
        expect(result.version).toBeUndefined();
        expect(result.inputs).toHaveLength(1);
    });

    it('nests the input under "tasks" for a .code-workspace file', async () => {
        const file = makeFile('/ws/test.code-workspace');
        await file.addParam('greeting', ['hi'], false);

        const tasks = written().tasks as { inputs: Array<{ id: string }> };
        expect(tasks.inputs[0].id).toBe('greeting');
    });

    it('preserves backslashes in values without corrupting the JSON', async () => {
        const file = makeFile('/ws/.vscode/tasks.json');
        // a Windows path and a literal escape sequence: both must round-trip
        // verbatim. A naive un-escaping pass turns `\U`/`\t` into an invalid
        // escape (corrupting the file) or a control character (changing the value).
        await file.addParam('cmd', { shellCmd: 'dir C:\\Users', separator: '\\t' }, false);

        const raw = (writeFile.mock.calls.at(-1)![1] as Buffer).toString();
        // the written text must be valid JSON (no parse errors)
        const errors: jsonc.ParseError[] = [];
        jsonc.parseTree(raw, errors);
        expect(errors).toHaveLength(0);
        // and the values must read back exactly as supplied
        const args = (written().inputs as Array<{ args: { shellCmd: string; separator: string } }>)[0].args;
        expect(args.shellCmd).toBe('dir C:\\Users');
        expect(args.separator).toBe('\\t');
    });
});

describe('JsonFile parsing', () => {
    it('creates a param for a valid status bar input', async () => {
        const content = JSON.stringify({
            version: '2.0.0',
            inputs: [{ id: 'p', type: 'command', command: 'statusBarParam.get.p', args: ['a', 'b'] }],
        });
        const file = makeFile('/ws/.vscode/tasks.json', content);
        await flush();
        await flush();

        expect(file.hasParams()).toBe(true);
        expect(file.params.map((param) => param.id)).toEqual(['p']);
    });

    it('parses both the tasks and launch input sections of a .code-workspace file', async () => {
        const content = JSON.stringify({
            tasks: {
                version: '2.0.0',
                inputs: [{ id: 't', type: 'command', command: 'statusBarParam.get.t', args: ['a'] }],
            },
            launch: {
                inputs: [{ id: 'l', type: 'command', command: 'statusBarParam.get.l', args: ['b'] }],
            },
        });
        const file = makeFile('/ws/test.code-workspace', content);
        await flush();
        await flush();

        expect(file.params.map((param) => param.id).sort()).toEqual(['l', 't']);
        // each param must remember which inputs section it came from, so a later
        // delete targets the right array
        const byId = Object.fromEntries(file.params.map((param) => [param.id, param.inputsPath]));
        expect(byId['t']).toEqual(['tasks', 'inputs']);
        expect(byId['l']).toEqual(['launch', 'inputs']);
    });

    it('creates a param for a top-level array of displayValue objects', async () => {
        // a top-level array (rather than { values: [...] }) carrying object
        // values must be wrapped before reaching ArrayValuesDelegate, otherwise
        // parsing throws on `arrayOptions.values` and the param silently vanishes
        const content = JSON.stringify({
            inputs: [
                {
                    id: 'p',
                    type: 'command',
                    command: 'statusBarParam.get.p',
                    args: [
                        { value: 'a', displayValue: 'A' },
                        { value: 'b', displayValue: 'B' },
                    ],
                },
            ],
        });
        const file = makeFile('/ws/.vscode/tasks.json', content);
        await flush();
        await flush();

        expect(file.params.map((param) => param.id)).toEqual(['p']);
    });

    it('ignores inputs that are not status bar params', async () => {
        const content = JSON.stringify({
            inputs: [{ id: 'x', type: 'promptString', description: 'not ours' }],
        });
        const file = makeFile('/ws/.vscode/tasks.json', content);
        await flush();
        await flush();

        expect(file.hasParams()).toBe(false);
    });

    it('ignores an input whose retrieval command does not match its id', async () => {
        // a hand-edited mismatch would register one command yet advertise another
        const content = JSON.stringify({
            inputs: [{ id: 'foo', type: 'command', command: 'statusBarParam.get.bar', args: ['a'] }],
        });
        const file = makeFile('/ws/.vscode/tasks.json', content);
        await flush();
        await flush();

        expect(file.hasParams()).toBe(false);
    });

    it('parses content delivered as a plain Uint8Array, not a Buffer', async () => {
        // a host may return a plain Uint8Array; .toString() on one yields byte values
        const content = JSON.stringify({
            inputs: [{ id: 'p', type: 'command', command: 'statusBarParam.get.p', args: ['a'] }],
        });
        readFile.mockResolvedValue(new TextEncoder().encode(content));
        const file = JsonFile.createFromPathOutsideWorkspace(1, vscode.Uri.file('/ws/.vscode/tasks.json'), fakeConfig(), new vscode.EventEmitter());
        await flush();
        await flush();

        expect(file.params.map((param) => param.id)).toEqual(['p']);
    });
});

describe('JsonFile watcher behavior', () => {
    const lastWatcher = () => createWatcher.mock.results.at(-1)!.value;
    const validContent = JSON.stringify({
        inputs: [{ id: 'p', type: 'command', command: 'statusBarParam.get.p', args: ['a'] }],
    });

    it('parses the file when the watcher reports it was created', async () => {
        const file = makeFile('/ws/.vscode/tasks.json'); // initialises empty ('{}')
        await flush();
        await flush();
        expect(file.hasParams()).toBe(false);

        readFile.mockResolvedValue(Buffer.from(validContent));
        const onCreate = lastWatcher().onDidCreate.mock.calls[0][0] as () => void;
        onCreate();
        await flush();
        await flush();

        expect(file.params.map((param) => param.id)).toEqual(['p']);
    });

    it('clears params without disposing the file when the watcher reports a delete', async () => {
        const file = makeFile('/ws/.vscode/tasks.json', validContent);
        await flush();
        await flush();
        expect(file.hasParams()).toBe(true);

        const watcher = lastWatcher();
        // a genuine deletion surfaces as a FileNotFound read error
        readFile.mockRejectedValue(vscode.FileSystemError.FileNotFound(file.uri));
        const onDelete = watcher.onDidDelete.mock.calls[0][0] as () => void;
        onDelete();
        await flush();
        await flush();

        expect(file.hasParams()).toBe(false);
        // re-parse instead of dispose, so a recreated file is picked back up
        expect(watcher.dispose).not.toHaveBeenCalled();
    });

    it('inside-workspace file: clears params on delete and re-parses on recreate without disposing the watcher', async () => {
        // deleting and recreating .vscode/tasks.json must not permanently silence its params
        const folder = { uri: vscode.Uri.file('/ws'), name: 'ws', index: 0 } as vscode.WorkspaceFolder;
        readFile.mockResolvedValue(Buffer.from(validContent));
        const file = JsonFile.createFromPathInsideWorkspace(1, folder, '.vscode/tasks.json', fakeConfig(), new vscode.EventEmitter());
        await flush();
        await flush();
        expect(file.hasParams()).toBe(true);

        const watcher = lastWatcher();
        readFile.mockRejectedValue(vscode.FileSystemError.FileNotFound(file.uri));
        (watcher.onDidDelete.mock.calls[0][0] as () => void)();
        await flush();
        await flush();
        expect(file.hasParams()).toBe(false);
        expect(watcher.dispose).not.toHaveBeenCalled();

        readFile.mockResolvedValue(Buffer.from(validContent));
        (watcher.onDidCreate.mock.calls[0][0] as () => void)();
        await flush();
        await flush();
        expect(file.params.map((param) => param.id)).toEqual(['p']);
    });

    it('keeps the current params (and reports) when a read fails for a reason other than not-found', async () => {
        const file = makeFile('/ws/.vscode/tasks.json', validContent);
        await flush();
        await flush();
        expect(file.hasParams()).toBe(true);

        // a transient/permission/provider failure is not a deletion: the params
        // must not silently disappear as if the file were removed
        readFile.mockRejectedValue(vscode.FileSystemError.NoPermissions(file.uri));
        const onChange = lastWatcher().onDidChange.mock.calls[0][0] as () => void;
        onChange();
        await flush();
        await flush();

        expect(file.hasParams()).toBe(true);
        expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });

    it('watches by an escaped basename so glob metacharacters are matched literally', () => {
        makeFile('/ws/app[dev].code-workspace');
        const pattern = createWatcher.mock.calls.at(-1)![0] as vscode.RelativePattern;
        expect(pattern.pattern).toBe('app\\[dev\\].code-workspace');
    });

    it('coalesces a change that arrives mid-parse and re-parses once afterwards', async () => {
        const file = makeFile('/ws/.vscode/tasks.json', '{}');
        await flush();
        await flush();
        const onChange = lastWatcher().onDidChange.mock.calls[0][0] as () => void;

        // make the next read hang so the first onFileChange stays "busy"
        readFile.mockClear();
        let release!: () => void;
        readFile.mockReturnValueOnce(
            new Promise<Buffer>((resolve) => {
                release = () => resolve(Buffer.from('{}'));
            }),
        );

        onChange(); // round 1: starts parsing, blocks on the hanging read
        await flush();
        onChange(); // round 2: arrives while busy -> coalesced, no new read yet
        await flush();
        expect(readFile).toHaveBeenCalledTimes(1);

        release(); // round 1 finishes -> the coalesced change triggers exactly one re-parse
        await flush();
        await flush();
        await flush();
        expect(readFile).toHaveBeenCalledTimes(2);
        expect(file.hasParams()).toBe(false);
    });
});

// The user tasks.json lives under the workbench-owned `vscode-userdata:` scheme,
// which a remote extension host can't reach: inputs are read via the `tasks`
// configuration and writes edit the document the workbench opens for us.
describe('JsonFile user tasks (vscode-userdata) I/O', () => {
    const placeholder = vscode.Uri.from({ scheme: 'vscode-userdata', path: '/tasks.json' });
    const realUri = vscode.Uri.from({ scheme: 'vscode-userdata', path: '/Users/me/Library/Application Support/Code/User/tasks.json' });
    const validContentP = JSON.stringify({
        inputs: [{ id: 'p', type: 'command', command: 'statusBarParam.get.p', args: ['a'] }],
    });
    const validContentMyId = JSON.stringify({
        inputs: [{ id: 'myId', type: 'command', command: 'statusBarParam.get.myId', args: ['a', 'b'] }],
    });
    let applyEdit: jest.SpyInstance;
    let executeCommand: jest.SpyInstance;

    beforeEach(() => {
        applyEdit = jest.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(true);
        executeCommand = jest.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    });
    afterEach(() => {
        applyEdit.mockRestore();
        executeCommand.mockRestore();
        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [];
    });

    function fakeDoc(text: string) {
        return {
            uri: realUri,
            getText: () => text,
            positionAt: (offset: number) => new vscode.Position(0, offset),
            save: jest.fn(async () => true),
        } as unknown as vscode.TextDocument;
    }

    it('getDefaultCwd is the root (the user tasks file is not tied to a folder)', () => {
        const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
        expect(file.getDefaultCwd()).toBe('/');
    });

    it('observes the tasks configuration, not a file watcher', () => {
        JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
        const userdataWatcher = createWatcher.mock.calls
            .map((call) => (call[0] as { baseUri: vscode.Uri }).baseUri)
            .find((uri) => uri.scheme === 'vscode-userdata');
        expect(userdataWatcher).toBeUndefined();
        expect(vscode.workspace.onDidChangeConfiguration as jest.Mock).toHaveBeenCalled();
    });

    // contract: vscode-userdata is unreachable from a remote host via workspace.fs /
    // file watchers, so the user tasks file must never use them (would have caught
    // the original regression).
    it('never uses workspace.fs or a file watcher for the user tasks file', async () => {
        const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
        await flush();
        await flush();
        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [fakeDoc('{}')];
        await file.mutate(() => '{}');

        expect(readFile).not.toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
        expect(createWatcher).not.toHaveBeenCalled();
    });

    it('shows previously defined params from the tasks configuration without opening the file', async () => {
        const getConfiguration = jest.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
            inspect: (key: string) => (key === 'inputs' ? { globalValue: JSON.parse(validContentP).inputs } : undefined),
        } as unknown as vscode.WorkspaceConfiguration);
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await flush();
            await flush();
            expect(file.params.map((param) => param.id)).toEqual(['p']);
        } finally {
            getConfiguration.mockRestore();
        }
    });

    // the user tasks file has no real watcher; a tasks-config change is what stands
    // in for one, so prove it actually triggers a re-parse.
    it('re-parses params when the tasks configuration changes', async () => {
        let inputs: unknown[] = [];
        const getConfiguration = jest.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
            inspect: (key: string) => (key === 'inputs' ? { globalValue: inputs } : undefined),
        } as unknown as vscode.WorkspaceConfiguration);
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await flush();
            await flush();
            expect(file.hasParams()).toBe(false);

            // a param appears in the config, then a `tasks` change fires
            inputs = JSON.parse(validContentP).inputs;
            const onConfigChange = (vscode.workspace.onDidChangeConfiguration as jest.Mock).mock.calls.at(-1)![0] as (
                e: vscode.ConfigurationChangeEvent,
            ) => void;
            onConfigChange({ affectsConfiguration: (section: string) => section === 'tasks' } as vscode.ConfigurationChangeEvent);
            await flush();
            await flush();

            expect(file.params.map((param) => param.id)).toEqual(['p']);
        } finally {
            getConfiguration.mockRestore();
        }
    });

    it('ignores configuration changes unrelated to tasks', async () => {
        let inputs: unknown[] = [];
        const getConfiguration = jest.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
            inspect: (key: string) => (key === 'inputs' ? { globalValue: inputs } : undefined),
        } as unknown as vscode.WorkspaceConfiguration);
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await flush();
            await flush();

            inputs = JSON.parse(validContentP).inputs;
            const onConfigChange = (vscode.workspace.onDidChangeConfiguration as jest.Mock).mock.calls.at(-1)![0] as (
                e: vscode.ConfigurationChangeEvent,
            ) => void;
            onConfigChange({ affectsConfiguration: () => false } as vscode.ConfigurationChangeEvent);
            await flush();
            await flush();

            // an unrelated change must not trigger a re-parse
            expect(file.hasParams()).toBe(false);
        } finally {
            getConfiguration.mockRestore();
        }
    });

    it('mutate edits the already-open user tasks document and saves it', async () => {
        const doc = fakeDoc('{}');
        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [doc];
        const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());

        await file.mutate(() => '{"inputs":[{"id":"x"}]}');

        const editArg = applyEdit.mock.calls[0][0] as vscode.WorkspaceEdit;
        expect(editArg.has(realUri)).toBe(true);
        expect(doc.save).toHaveBeenCalled();
        expect(writeFile).not.toHaveBeenCalled();
    });

    it('mutate opens the user tasks file via the command when it is not open yet', async () => {
        const doc = fakeDoc('{}');
        const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
        const done = file.mutate(() => '{"inputs":[]}');
        await flush();
        // resolve the open we are waiting for
        const onOpen = (vscode.workspace.onDidOpenTextDocument as jest.Mock).mock.calls.at(-1)![0] as (d: vscode.TextDocument) => void;
        onOpen(doc);
        await done;

        expect(executeCommand).toHaveBeenCalledWith('workbench.action.tasks.openUserTasks');
        expect(applyEdit).toHaveBeenCalled();
        expect(doc.save).toHaveBeenCalled();
    });

    // Bug fix: the tree node's click opens the file via JsonFile.open(). The user
    // tasks.json's uri is a vscode-userdata placeholder a remote host can't open, so it
    // must route through the workbench (showTextDocument of the opened document), not a
    // bare vscode.open on that uri (which fails with "file does not exist").
    it('open shows the user tasks document via the workbench, not vscode.open on the placeholder', async () => {
        const doc = fakeDoc('{}');
        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [doc];
        const show = jest.spyOn(vscode.window, 'showTextDocument').mockResolvedValue({} as never);
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await file.open();
            expect(show).toHaveBeenCalledWith(doc);
            expect(executeCommand).not.toHaveBeenCalledWith('vscode.open', expect.anything());
        } finally {
            show.mockRestore();
        }
    });

    it('open uses vscode.open for a normal (openable) file uri', async () => {
        const file = makeFile('/ws/.vscode/tasks.json');
        await file.open();
        expect(executeCommand).toHaveBeenCalledWith('vscode.open', file.uri);
    });

    it('open surfaces an error when the user tasks document fails to open', async () => {
        const errSpy = jest.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
        const openUserData = jest.spyOn(JsonFile.prototype, 'openUserDataDocument').mockRejectedValue(new Error('timed out'));
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await file.open();
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('timed out'));
        } finally {
            errSpy.mockRestore();
            openUserData.mockRestore();
        }
    });

    // a mock `tasks` config whose Global values come from `seed`; returns the update spy
    function mockTasksConfig(seed: { inputs?: unknown[]; tasks?: unknown[]; version?: string } = {}) {
        const update = jest.fn().mockResolvedValue(undefined);
        const getConfiguration = jest.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
            inspect: (key: string) => ({ globalValue: (seed as Record<string, unknown>)[key] }),
            update,
        } as unknown as vscode.WorkspaceConfiguration);
        return { update, restore: () => getConfiguration.mockRestore() };
    }

    // Regression: editing the user tasks.json to add a param (via the workbench's
    // openUserTasks) pops VS Code's "create tasks.json from template" picker whenever
    // the file has no tasks — confusing, and the picker overwrites our inputs. The
    // *write* must therefore not open the file: it writes the `tasks` configuration (the
    // channel its inputs are read from), which creates/updates the file silently. (The
    // reveal that opens the file is a separate, later step — see the reveal test below.)
    it('writes a user-tasks param via the tasks config without opening the file (no template picker)', async () => {
        const { update, restore } = mockTasksConfig({ tasks: [{ label: 'existing' }] });
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await file.addParam('myId', ['a', 'b'], false);

            // the input is appended at Global scope (which materializes the file)...
            expect(update).toHaveBeenCalledWith(
                'inputs',
                [expect.objectContaining({ id: 'myId', type: 'command', args: ['a', 'b'] })],
                vscode.ConfigurationTarget.Global,
            );
            // ...and the write itself uses neither the template-prompting open command
            // nor a document edit (the reveal happens later, on the config-change re-parse)
            expect(executeCommand).not.toHaveBeenCalledWith('workbench.action.tasks.openUserTasks');
            expect(applyEdit).not.toHaveBeenCalled();
        } finally {
            restore();
        }
    });

    // Bug fix: after writing the param, the file must open for editing (like every other
    // file) — the example wizard especially seeds an example to edit. The write arms the
    // reveal (paramIdToEditOnCreate); the config-change re-parse then opens the file. Safe
    // because addParamToUserTasks guarantees a task, so openUserTasks won't pop the picker.
    it('reveals (opens) the new param on the re-parse the config write triggers', async () => {
        // a user tasks doc is already open, so the reveal's openUserDataDocument resolves
        // to it immediately and goes on to show it
        const doc = fakeDoc(validContentMyId);
        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [doc];
        const show = jest.spyOn(vscode.window, 'showTextDocument').mockResolvedValue({} as never);
        let inputs: unknown[] = [];
        const update = jest.fn().mockImplementation((key: string, value: unknown[]) => {
            if (key === 'inputs') {
                inputs = value;
            }
            return Promise.resolve();
        });
        const getConfiguration = jest.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
            inspect: (key: string) => (key === 'inputs' ? { globalValue: inputs } : { globalValue: [{ label: 'existing' }] }),
            update,
        } as unknown as vscode.WorkspaceConfiguration);
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await flush();
            await flush();
            await file.addParam('myId', ['a', 'b'], false);
            // the write does not open the file by itself
            expect(executeCommand).not.toHaveBeenCalledWith('workbench.action.tasks.openUserTasks');

            // VS Code fires the tasks-config change the write caused; the re-parse reveals
            const onConfigChange = (vscode.workspace.onDidChangeConfiguration as jest.Mock).mock.calls.at(-1)![0] as (
                e: vscode.ConfigurationChangeEvent,
            ) => void;
            onConfigChange({ affectsConfiguration: (section: string) => section === 'tasks' } as vscode.ConfigurationChangeEvent);
            await flush();
            await flush();

            // the new param is now revealed: the already-open user tasks document is
            // shown (openUserDataDocument returns it without re-running openUserTasks)
            expect(show).toHaveBeenCalled();
            expect(show.mock.calls.at(-1)![0]).toBe(doc);
        } finally {
            getConfiguration.mockRestore();
            show.mockRestore();
        }
    });

    it('appends the new input/sample task to the existing user-level config values', async () => {
        const existingInputs = [{ id: 'old' }];
        const existingTasks = [{ label: 'old task' }];
        const { update, restore } = mockTasksConfig({ inputs: existingInputs, tasks: existingTasks, version: '2.0.0' });
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await file.addParam('myId', ['a'], true);

            // version is left to VS Code (never written); tasks/inputs are appended to
            expect(update).not.toHaveBeenCalledWith('version', expect.anything(), expect.anything());
            expect(update).toHaveBeenCalledWith(
                'tasks',
                [...existingTasks, expect.objectContaining({ label: 'echo value of myId', type: 'shell', command: 'echo', args: ['${input:myId}'] })],
                vscode.ConfigurationTarget.Global,
            );
            expect(update).toHaveBeenCalledWith('inputs', [...existingInputs, expect.objectContaining({ id: 'myId' })], vscode.ConfigurationTarget.Global);
        } finally {
            restore();
        }
    });

    // VS Code prompts for a template when the user tasks.json has no tasks, so a
    // task-less file must never be left behind: add the demo task even when the user
    // declined it, and tell them why.
    it('forces a sample task when the user tasks file would otherwise have none', async () => {
        const info = jest.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
        const { update, restore } = mockTasksConfig({}); // empty: no tasks at all
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await file.addParam('myId', ['a'], false); // user did NOT ask for a sample task

            expect(update).toHaveBeenCalledWith(
                'tasks',
                [expect.objectContaining({ label: 'echo value of myId', type: 'shell', command: 'echo', args: ['${input:myId}'] })],
                vscode.ConfigurationTarget.Global,
            );
            expect(info).toHaveBeenCalled();
        } finally {
            restore();
            info.mockRestore();
        }
    });

    it('surfaces an example header comment as a message, since a config write cannot embed it', async () => {
        const info = jest.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
        const { update, restore } = mockTasksConfig({ tasks: [{ label: 'existing' }] });
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await file.addParam('myId', ['a'], false, "// Example parameter — edit the values in 'args', then use the\n// selected value via ${input:myId}.");

            // the input is still written via config (no document edit) ...
            expect(update).toHaveBeenCalledWith('inputs', expect.anything(), vscode.ConfigurationTarget.Global);
            expect(applyEdit).not.toHaveBeenCalled();
            // ... and the guidance is surfaced as a single-line message (// stripped), not dropped
            expect(info).toHaveBeenCalledWith(expect.stringContaining('${input:myId}'));
            expect(info).toHaveBeenCalledWith(expect.not.stringContaining('//'));
        } finally {
            restore();
            info.mockRestore();
        }
    });

    it('does not force a sample task when the user tasks file already has tasks', async () => {
        const info = jest.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
        const { update, restore } = mockTasksConfig({ tasks: [{ label: 'existing' }] });
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await file.addParam('myId', ['a'], false);

            expect(update).not.toHaveBeenCalledWith('tasks', expect.anything(), expect.anything());
            expect(update).toHaveBeenCalledWith('inputs', expect.anything(), vscode.ConfigurationTarget.Global);
            expect(info).not.toHaveBeenCalled();
        } finally {
            restore();
            info.mockRestore();
        }
    });

    // deleting must also avoid opening the file (same picker hazard); it filters the
    // input out of the tasks config so removing the last param keeps the file task-bearing.
    it('deletes a user-tasks param by filtering it out of the tasks config inputs', async () => {
        const keep = { id: 'keep', type: 'command', command: 'x', args: ['z'] };
        const { update, restore } = mockTasksConfig({ inputs: [{ id: 'myId' }, keep], tasks: [{ label: 't' }] });
        try {
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            await file.deleteParamFromUserTasks('myId');
            expect(update).toHaveBeenCalledWith('inputs', [keep], vscode.ConfigurationTarget.Global);
        } finally {
            restore();
        }
    });

    it('mutate rejects and frees the listener if the user tasks file never opens', async () => {
        jest.useFakeTimers();
        try {
            const sub = { dispose: jest.fn() };
            (vscode.workspace.onDidOpenTextDocument as jest.Mock).mockReturnValueOnce(sub);
            const file = JsonFile.createFromPathOutsideWorkspace(1, placeholder, fakeConfig(), new vscode.EventEmitter());
            const done = file.mutate(() => '{}');
            const rejects = expect(done).rejects.toThrow(/Timed out/);
            await Promise.resolve(); // let the executeCommand await settle
            jest.advanceTimersByTime(10_000); // fire the open timeout
            await rejects;
            expect(sub.dispose).toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('JsonFile.dispose', () => {
    it('disposes the file system watcher', () => {
        const file = makeFile('/ws/.vscode/tasks.json');
        const watcher = createWatcher.mock.results.at(-1)!.value;
        file.dispose();
        expect(watcher.dispose).toHaveBeenCalled();
    });
});
