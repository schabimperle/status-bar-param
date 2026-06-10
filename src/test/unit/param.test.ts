import * as vscode from 'vscode';
import { Param } from '../../param';
import { Options, DisplayableValue } from '../../schemas';
import { ValuesDelegate } from '../../valuesDelegate';
import { JsonFile } from '../../jsonFile';
import { ExtensionConfig } from '../../config';
import { Strings } from '../../strings';

const COMMAND = 'statusBarParam.get.myId';
const A: DisplayableValue = { value: 'a', displayValue: 'a' };
const B: DisplayableValue = { value: 'b', displayValue: 'b' };
const LABELLED: DisplayableValue = { value: 'raw', displayValue: 'Nice' };

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface SetupOptions {
    opts?: Partial<Options>;
    values?: DisplayableValue[];
    unavailable?: boolean;
    showNames?: boolean;
    showSelections?: boolean;
    stored?: Record<string, unknown>;
    secondaryKeys?: string[];
}

function setup(options: SetupOptions = {}) {
    const store = new Map<string, unknown>(Object.entries(options.stored ?? {}));
    const memento = {
        get: jest.fn((key: string, def?: unknown) => (store.has(key) ? store.get(key) : def)),
        update: jest.fn((key: string, value: unknown) => {
            if (value === undefined) {
                store.delete(key);
            } else {
                store.set(key, value);
            }
            return Promise.resolve();
        }),
        keys: jest.fn(() => [...store.keys()]),
    };
    const config = {
        workspaceState: memento,
        showNames: options.showNames ?? false,
        showSelections: options.showSelections ?? true,
    } as unknown as ExtensionConfig;
    const values = options.values ?? [A, B];
    const secondaryKeys = options.secondaryKeys ?? [];
    const delegate = {
        getValues: jest.fn(async () => (options.unavailable ? undefined : values.map((v) => ({ ...v })))),
        getIcon: jest.fn(() => new vscode.ThemeIcon('array')),
        getSecondaryKeys: jest.fn(() => [...secondaryKeys]),
    } as unknown as ValuesDelegate;
    const jsonFile = { uri: vscode.Uri.file('/ws/.vscode/tasks.json'), changeEmitter: new vscode.EventEmitter() } as unknown as JsonFile;
    const param = new Param('myId', COMMAND, { ...options.opts }, 1, ['inputs'], jsonFile, delegate, config);
    const item = (vscode.window.createStatusBarItem as jest.Mock).mock.results.at(-1)!.value;
    return { param, item, memento, store, delegate, jsonFile };
}

beforeEach(() => {
    // override jest-mock-vscode's registerCommand to avoid its internal command
    // registry rejecting the same id across tests
    (vscode.commands.registerCommand as jest.Mock).mockReturnValue(new vscode.Disposable(() => undefined));
});

describe('Param construction', () => {
    it('creates a status bar item and registers the retrieval command', () => {
        const { item } = setup();
        expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(COMMAND, expect.any(Function));
        expect(item.show).toHaveBeenCalled();
    });

    it('reports a clear, named error when the retrieval command id is already taken', () => {
        // a duplicate id makes registerCommand throw; the user must get a message
        // naming the parameter instead of the param silently never appearing
        (vscode.commands.registerCommand as jest.Mock).mockImplementationOnce(() => {
            throw new Error("command 'statusBarParam.get.myId' already exists");
        });
        const { param, item } = setup();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("'myId'"));
        // the status bar item is not shown when registration fails
        expect(item.show).not.toHaveBeenCalled();
        // and the param flags itself so the owning JsonFile drops it instead of
        // keeping a non-functional tree/status-bar entry
        expect(param.registrationFailed).toBe(true);
    });
});

describe('Param.update value mapping', () => {
    it('defaults to the first value when nothing is stored (single select)', async () => {
        const { store } = setup();
        await flush();
        expect(store.get(COMMAND)).toEqual(['a']);
    });

    it('keeps a stored selection that is still available', async () => {
        const { store } = setup({ stored: { [COMMAND]: ['b'] } });
        await flush();
        expect(store.get(COMMAND)).toEqual(['b']);
    });

    it('drops a stored selection that is no longer available, falling back to the first value', async () => {
        const { store } = setup({ stored: { [COMMAND]: ['gone'] } });
        await flush();
        expect(store.get(COMMAND)).toEqual(['a']);
    });

    it('leaves the selection empty for canPickMany when nothing is stored', async () => {
        const { store, item } = setup({ opts: { canPickMany: true } });
        await flush();
        expect(store.get(COMMAND)).toEqual([]);
        // an empty selection with showSelection on falls back to showing the name
        expect(item.text).toBe('myId');
    });

    it('uses a string initialSelection when nothing is stored', async () => {
        const { store } = setup({ opts: { initialSelection: 'b' } });
        await flush();
        expect(store.get(COMMAND)).toEqual(['b']);
    });

    it('uses an array initialSelection for canPickMany', async () => {
        const { store, item } = setup({ opts: { canPickMany: true, initialSelection: ['a', 'b'] } });
        await flush();
        expect(store.get(COMMAND)).toEqual(['a', 'b']);
        expect(item.text).toBe('a b');
    });

    it('keeps only the first value of an array initialSelection for a single-select param', async () => {
        // without canPickMany, seeding multiple values would make onGet join them
        const { store } = setup({ opts: { initialSelection: ['a', 'b'] } });
        await flush();
        expect(store.get(COMMAND)).toEqual(['a']);
    });

    it('preserves the stored selection and does not clobber it when values are unavailable', async () => {
        const { store, item } = setup({ unavailable: true, stored: { [COMMAND]: ['b'] } });
        await flush();
        expect(store.get(COMMAND)).toEqual(['b']);
        expect(item.text).toBe('b');
    });

    it('lets the latest update win when refreshes overlap (no stale write)', async () => {
        const { param, store, delegate } = setup({ stored: { [COMMAND]: ['b'] } });
        await flush(); // settle the constructor's own update()

        // first refresh sees a slow source that ultimately yields only stale values;
        // a second refresh starts before it resolves and yields the fresh value
        let releaseStale!: () => void;
        (delegate.getValues as jest.Mock)
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        releaseStale = () => resolve([{ value: 'stale', displayValue: 'stale' }]);
                    }),
            )
            .mockResolvedValueOnce([{ value: 'fresh', displayValue: 'fresh' }]);

        const first = param.update(); // starts, blocks on the slow getValues
        const second = param.update(); // newer generation, resolves immediately
        await second;
        releaseStale(); // the stale first refresh now resolves last
        await first;

        // the late-resolving stale refresh must not overwrite the fresh result
        expect(store.get(COMMAND)).toEqual(['fresh']);
    });
});

describe('Param.storeSelectedValues / onGet', () => {
    it('persists raw values but displays displayValues', async () => {
        const { param, item, store } = setup({ values: [LABELLED] });
        await flush();
        param.storeSelectedValues([LABELLED]);
        expect(store.get(COMMAND)).toEqual(['raw']);
        expect(item.text).toBe('Nice');
    });

    it('onGet returns the space-joined raw selection', async () => {
        const { param } = setup();
        await flush();
        param.storeSelectedValues([A, B]);
        expect(param.onGet()).toBe('a b');
    });

    it('onGet returns an empty string when nothing is selected', async () => {
        const { param, store } = setup({ opts: { canPickMany: true } });
        await flush();
        store.delete(COMMAND);
        expect(param.onGet()).toBe('');
    });

    it('onGet joins with a custom joinSeparator', async () => {
        const { param } = setup({ opts: { canPickMany: true, joinSeparator: ',' } });
        await flush();
        param.storeSelectedValues([A, B]);
        expect(param.onGet()).toBe('a,b');
    });

    it('onGet interprets backslash escapes in joinSeparator (\\n -> newline)', async () => {
        const { param } = setup({ opts: { canPickMany: true, joinSeparator: '\\n' } });
        await flush();
        param.storeSelectedValues([A, B]);
        expect(param.onGet()).toBe('a\nb');
    });

    it('onGet falls back to a single space when joinSeparator is unset', async () => {
        const { param } = setup({ opts: { canPickMany: true } });
        await flush();
        param.storeSelectedValues([A, B]);
        expect(param.onGet()).toBe('a b');
    });
});

describe('Param secondary (named) values', () => {
    // map entries: value is the canonical identity, secondaryValues the named outputs
    const GCC: DisplayableValue = { value: '{"cc":"gcc","cxx":"g++"}', displayValue: 'gcc', secondaryValues: { cc: 'gcc', cxx: 'g++' } };
    const CLANG: DisplayableValue = { value: '{"cc":"clang","cxx":"clang++"}', displayValue: 'clang', secondaryValues: { cc: 'clang', cxx: 'clang++' } };
    const KEYS = ['cc', 'cxx'];

    beforeEach(() => (vscode.window.showWarningMessage as jest.Mock).mockClear());

    it('registers a retrieval command per secondary key', () => {
        setup({ values: [GCC, CLANG], secondaryKeys: KEYS });
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(`${COMMAND}.cc`, expect.any(Function));
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(`${COMMAND}.cxx`, expect.any(Function));
    });

    it('registers no secondary command when there are no keys', () => {
        setup();
        const ids = (vscode.commands.registerCommand as jest.Mock).mock.calls.map((call) => call[0]);
        expect(ids).toEqual([COMMAND]);
    });

    it('onGetSecondary returns the selected entry secondary for the key', async () => {
        const { param } = setup({ values: [GCC, CLANG], secondaryKeys: KEYS, stored: { [COMMAND]: [GCC.value] } });
        await flush();
        await expect(param.onGetSecondary('cxx')).resolves.toBe('g++');
    });

    it('onGetSecondary returns empty when nothing is selected', async () => {
        const { param, store } = setup({ values: [GCC], secondaryKeys: KEYS, opts: { canPickMany: true } });
        await flush();
        store.delete(COMMAND);
        await expect(param.onGetSecondary('cxx')).resolves.toBe('');
    });

    it('onGetSecondary returns empty when the selected entry lacks the key', async () => {
        const partial: DisplayableValue = { value: '{"cc":"tcc"}', displayValue: 'tcc', secondaryValues: { cc: 'tcc' } };
        const { param } = setup({ values: [GCC, partial], secondaryKeys: KEYS, stored: { [COMMAND]: [partial.value] } });
        await flush();
        await expect(param.onGetSecondary('cxx')).resolves.toBe('');
    });

    it('onGetSecondary joins across a multi-selection', async () => {
        const { param } = setup({ values: [GCC, CLANG], secondaryKeys: KEYS, opts: { canPickMany: true }, stored: { [COMMAND]: [GCC.value, CLANG.value] } });
        await flush();
        await expect(param.onGetSecondary('cxx')).resolves.toBe('g++ clang++');
    });

    it('onGet on a keyless map warns once and contributes nothing, still joining string entries', async () => {
        const { param } = setup({ values: [GCC, A], secondaryKeys: KEYS, opts: { canPickMany: true }, stored: { [COMMAND]: [GCC.value, 'a'] } });
        await flush();
        await expect(param.onGet()).resolves.toBe('a');
        await param.onGet(); // a second read must not re-warn
        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    });

    it('onGet skips a map entry sitting between string entries', async () => {
        const { param } = setup({ values: [GCC, A, B], secondaryKeys: KEYS, opts: { canPickMany: true }, stored: { [COMMAND]: ['a', GCC.value, 'b'] } });
        await flush();
        await expect(param.onGet()).resolves.toBe('a b');
    });

    it('getSelectionText shows the display label and never warns', async () => {
        const { param } = setup({ values: [GCC, CLANG], secondaryKeys: KEYS, stored: { [COMMAND]: [GCC.value] } });
        await flush();
        expect(param.getSelectionText()).toBe('gcc');
        expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('stays functional when a secondary command id is already taken', async () => {
        (vscode.commands.registerCommand as jest.Mock).mockImplementation((id: string) => {
            if (id === `${COMMAND}.cxx`) {
                throw new Error('already exists');
            }
            return new vscode.Disposable(() => undefined);
        });
        const { param } = setup({ values: [GCC], secondaryKeys: KEYS, stored: { [COMMAND]: [GCC.value] } });
        await flush();
        expect(param.registrationFailed).toBe(false);
        await expect(param.onGetSecondary('cc')).resolves.toBe('gcc');
    });
});

describe('Param.setText rendering', () => {
    it('shows only the selection by default', () => {
        const { param, item } = setup();
        param.setText(['x']);
        expect(item.text).toBe('x');
        expect(item.color).toBeUndefined();
    });

    it('prefixes the name when showName is enabled per param', () => {
        const { param, item } = setup({ opts: { showName: true } });
        param.setText(['x']);
        expect(item.text).toBe('myId: x');
    });

    it('shows only the name when showSelection is disabled per param', () => {
        const { param, item } = setup({ opts: { showName: true, showSelection: false } });
        param.setText(['x']);
        expect(item.text).toBe('myId');
    });

    it('falls back to the name and an inactive color when the selection is empty', () => {
        const { param, item } = setup();
        param.setText([]);
        expect(item.text).toBe('myId');
        expect(item.color).toBeInstanceOf(vscode.ThemeColor);
    });

    it('treats a blank/whitespace selection as empty (inactive grey, not a blank active item)', () => {
        // a shell command can emit a blank line; it must not render as a blank but
        // active-coloured item, which looked like a bug ("white" vs the usual grey)
        const { param, item } = setup();
        param.setText([' ']);
        expect(item.text).toBe('myId');
        expect(item.color).toBeInstanceOf(vscode.ThemeColor);
    });

    it('treats multiple all-blank values as empty too', () => {
        const { param, item } = setup({ opts: { canPickMany: true } });
        param.setText(['', '']);
        expect(item.text).toBe('myId');
        expect(item.color).toBeInstanceOf(vscode.ThemeColor);
    });

    it('honors the global showNames default when the param does not override it', () => {
        const { param, item } = setup({ showNames: true });
        param.setText(['x']);
        expect(item.text).toBe('myId: x');
    });
});

describe('Param.loadSelectedValues back-compat', () => {
    it('migrates a pre-1.3.1 single string value stored under the old key', async () => {
        const oldKey = `${Strings.COMMAND_SELECT}.myId`;
        const { param, memento, store } = setup();
        await flush();
        // isolate from the constructor's own update(): seed only the legacy key
        store.clear();
        store.set(oldKey, 'legacy');
        memento.update.mockClear();

        expect(param.loadSelectedValues()).toEqual(['legacy']);
        // migrated value is persisted under the new key before the old one is removed
        expect(memento.update).toHaveBeenCalledWith(COMMAND, ['legacy']);
        expect(memento.update).toHaveBeenCalledWith(oldKey, undefined);
        // a subsequent read via onGet() must still see the migrated value
        expect(param.onGet()).toBe('legacy');
    });
});

describe('Param.getIcon / reveal / dispose', () => {
    it('delegates the icon to the values delegate', () => {
        const { param, delegate } = setup();
        expect(param.getIcon().id).toBe('array');
        expect(delegate.getIcon).toHaveBeenCalled();
    });

    // a document whose getText/positionAt are captured so we can assert which byte
    // offset reveal jumps to (and the selection passed to showTextDocument)
    function mockDoc(text: string) {
        let usedOffset = -1;
        const openSpy = jest.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({
            getText: () => text,
            positionAt: (offset: number) => {
                usedOffset = offset;
                return new vscode.Position(0, offset);
            },
        } as unknown as vscode.TextDocument);
        const showSpy = jest.spyOn(vscode.window, 'showTextDocument').mockResolvedValue({} as never);
        return { offset: () => usedOffset, restore: () => (openSpy.mockRestore(), showSpy.mockRestore()), openSpy, showSpy };
    }

    it('reveal opens the defining document and shows it', async () => {
        const doc = mockDoc('{ "inputs": [ { "id": "myId", "args": ["a"] } ] }');
        const { param, jsonFile } = setup();
        await param.reveal();
        expect(doc.openSpy).toHaveBeenCalledWith(jsonFile.uri);
        expect(doc.showSpy).toHaveBeenCalled();
        doc.restore();
    });

    it('reveal resolves the offset from the document text by id', async () => {
        const text = '{\n  "inputs": [\n    { "id": "myId", "type": "command", "command": "x", "args": ["a"] }\n  ]\n}';
        const expected = text.indexOf('{ "id"');
        const doc = mockDoc(text);
        const { param } = setup();
        await param.reveal();
        expect(doc.offset()).toBe(expected);
        // a selection was passed (the input was located)
        expect(doc.showSpy.mock.calls[0][1]).toMatchObject({ selection: expect.anything() });
        doc.restore();
    });

    it('reveal shows the document without a selection when the input is not found', async () => {
        const doc = mockDoc('{}'); // input gone from the current text — no fallback
        const { param } = setup();
        await param.reveal();
        expect(doc.offset()).toBe(-1); // positionAt never called
        expect(doc.showSpy).toHaveBeenCalled();
        expect(doc.showSpy.mock.calls[0][1]).toBeUndefined(); // no selection option
        doc.restore();
    });

    it('reveal positions inside the user tasks editor the workbench opens', async () => {
        // useDocumentIO files have no openable uri: the workbench command opens the
        // editor, then reveal must still position the cursor at the input by id
        const text = '{\n  "version": "2.0.0",\n  "inputs": [\n    { "id": "myId", "type": "command", "command": "x", "args": ["a"] }\n  ]\n}';
        const expected = text.indexOf('{ "id"');
        const exec = jest.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
        let usedOffset = -1;
        const doc = {
            getText: () => text,
            positionAt: (o: number) => {
                usedOffset = o;
                return new vscode.Position(0, o);
            },
        } as unknown as vscode.TextDocument;
        Object.defineProperty(vscode.window, 'activeTextEditor', { value: { document: doc }, configurable: true });
        const showSpy = jest.spyOn(vscode.window, 'showTextDocument').mockResolvedValue({} as never);
        const { param, jsonFile } = setup();
        (jsonFile as unknown as { useDocumentIO: boolean }).useDocumentIO = true;
        await param.reveal();
        expect(exec).toHaveBeenCalledWith('workbench.action.tasks.openUserTasks');
        expect(usedOffset).toBe(expected);
        expect(showSpy).toHaveBeenCalled();
        exec.mockRestore();
        showSpy.mockRestore();
        Object.defineProperty(vscode.window, 'activeTextEditor', { value: undefined, configurable: true });
    });

    it('dispose tears down the status bar item', () => {
        const { param, item } = setup();
        param.dispose();
        expect(item.dispose).toHaveBeenCalled();
    });
});
