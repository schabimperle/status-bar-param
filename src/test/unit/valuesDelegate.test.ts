import * as path from 'path';
import { exec } from 'child_process';
import * as vscode from 'vscode';
import { ArrayValuesDelegate, CommandValuesCache, CommandValuesDelegate } from '../../valuesDelegate';
import { CommandOptions } from '../../schemas';

jest.mock('child_process', () => ({ exec: jest.fn() }));
const mockExec = exec as unknown as jest.Mock;

// each delegate gets a fresh cache by default, so getValues() executes (empty cache)
function makeDelegate(opts: CommandOptions, cwd = '/root', cache: CommandValuesCache = new Map()) {
    return new CommandValuesDelegate(opts, cwd, cache, `statusBarParam.get.${opts.shellCmd}`);
}

function execResolves(stdout: string, stderr = ''): void {
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (e: unknown, o: string, err: string) => void) => cb(null, stdout, stderr));
}
function execFails(message: string, stderr = ''): void {
    mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: (e: unknown, o: string, err: string) => void) => cb(new Error(message), '', stderr));
}

describe('ArrayValuesDelegate', () => {
    it('exposes the array icon', () => {
        expect(new ArrayValuesDelegate({ values: [] }).getIcon().id).toBe('array');
    });

    it('normalizes plain strings to value/displayValue pairs', async () => {
        const delegate = new ArrayValuesDelegate({ values: ['a', 'b'] });
        await expect(delegate.getValues()).resolves.toEqual([
            { value: 'a', displayValue: 'a' },
            { value: 'b', displayValue: 'b' },
        ]);
    });

    it('keeps displayValue objects and mixes them with plain strings', async () => {
        const delegate = new ArrayValuesDelegate({ values: ['a', { value: 'v', displayValue: 'Label' }] });
        await expect(delegate.getValues()).resolves.toEqual([
            { value: 'a', displayValue: 'a' },
            { value: 'v', displayValue: 'Label' },
        ]);
    });

    it('falls back to value when an object omits displayValue', async () => {
        // the schema only requires `value`; without a fallback the status bar
        // and quick pick would render `undefined` as the label
        const delegate = new ArrayValuesDelegate({ values: [{ value: 'v' } as never] });
        await expect(delegate.getValues()).resolves.toEqual([{ value: 'v', displayValue: 'v' }]);
    });

    it('returns a fresh array each call so callers cannot mutate the source order', async () => {
        const delegate = new ArrayValuesDelegate({ values: ['a'] });
        const first = await delegate.getValues();
        first!.push({ value: 'x', displayValue: 'x' });
        await expect(delegate.getValues()).resolves.toHaveLength(1);
    });

    it('normalizes a map value: canonical (key-sorted) identity, displayValue, secondaryValues', async () => {
        const delegate = new ArrayValuesDelegate({ values: [{ displayValue: 'gcc', value: { cxx: 'g++', cc: 'gcc' } }] });
        await expect(delegate.getValues()).resolves.toEqual([
            // keys sorted in the identity so re-ordering the map keeps the same stored selection
            { value: '{"cc":"gcc","cxx":"g++"}', displayValue: 'gcc', secondaryValues: { cxx: 'g++', cc: 'gcc' } },
        ]);
    });

    it('exposes no secondary keys for plain or string-value entries', () => {
        expect(new ArrayValuesDelegate({ values: ['a', { value: 'v', displayValue: 'L' }] }).getSecondaryKeys()).toEqual([]);
    });

    it('unions map keys across values in first-seen order without duplicates', () => {
        const delegate = new ArrayValuesDelegate({
            values: [
                { displayValue: 'gcc', value: { cxx: 'g++', extra: '1' } },
                { displayValue: 'clang', value: { cxx: 'clang++', cc: 'clang' } },
            ],
        });
        expect(delegate.getSecondaryKeys()).toEqual(['cxx', 'extra', 'cc']);
    });
});

describe('CommandValuesDelegate', () => {
    beforeEach(() => {
        (vscode.workspace as { isTrusted: boolean }).isTrusted = true;
        (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({});
    });

    it('exposes the terminal icon', () => {
        expect(makeDelegate({ shellCmd: 'ls' }).getIcon().id).toBe('terminal');
    });

    it('never exposes secondary keys (stdout lines are not named maps)', () => {
        expect(makeDelegate({ shellCmd: 'ls' }).getSecondaryKeys()).toEqual([]);
    });

    it('returns undefined in an untrusted workspace without executing anything', async () => {
        (vscode.workspace as { isTrusted: boolean }).isTrusted = false;
        await expect(makeDelegate({ shellCmd: 'ls' }).getValues(true)).resolves.toBeUndefined();
        expect(mockExec).not.toHaveBeenCalled();
    });

    it('splits stdout on LF and drops a single trailing empty line', async () => {
        execResolves('a\nb\n');
        await expect(makeDelegate({ shellCmd: 'ls' }).getValues()).resolves.toEqual([
            { value: 'a', displayValue: 'a' },
            { value: 'b', displayValue: 'b' },
        ]);
    });

    it('splits stdout on CRLF regardless of the host OS', async () => {
        execResolves('a\r\nb\r\n');
        await expect(makeDelegate({ shellCmd: 'ls' }).getValues()).resolves.toEqual([
            { value: 'a', displayValue: 'a' },
            { value: 'b', displayValue: 'b' },
        ]);
    });

    it('splits on a custom separator', async () => {
        execResolves('a,b,c');
        await expect(makeDelegate({ shellCmd: 'ls', separator: ',' }).getValues()).resolves.toEqual([
            { value: 'a', displayValue: 'a' },
            { value: 'b', displayValue: 'b' },
            { value: 'c', displayValue: 'c' },
        ]);
    });

    it('keeps a non-empty final line (no spurious trailing pop)', async () => {
        execResolves('only');
        await expect(makeDelegate({ shellCmd: 'ls' }).getValues()).resolves.toEqual([{ value: 'only', displayValue: 'only' }]);
    });

    it('executes from the default cwd when no cwd option is given', async () => {
        execResolves('a');
        await makeDelegate({ shellCmd: 'ls' }, '/root/project').getValues();
        expect(mockExec).toHaveBeenCalledWith('ls', expect.objectContaining({ cwd: '/root/project' }), expect.any(Function));
    });

    it('passes a timeout and an explicit maxBuffer to exec', async () => {
        execResolves('a');
        await makeDelegate({ shellCmd: 'ls' }).getValues();
        expect(mockExec).toHaveBeenCalledWith(
            'ls',
            expect.objectContaining({ timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }),
            expect.any(Function),
        );
    });

    it('resolves a relative cwd against the default cwd', async () => {
        execResolves('a');
        await makeDelegate({ shellCmd: 'ls', cwd: 'sub' }, '/root/project').getValues();
        expect(mockExec).toHaveBeenCalledWith('ls', expect.objectContaining({ cwd: path.resolve('/root/project', 'sub') }), expect.any(Function));
    });

    it('keeps an absolute cwd', async () => {
        execResolves('a');
        await makeDelegate({ shellCmd: 'ls', cwd: '/abs/dir' }, '/root').getValues();
        expect(mockExec).toHaveBeenCalledWith('ls', expect.objectContaining({ cwd: path.resolve('/root', '/abs/dir') }), expect.any(Function));
    });

    it('returns undefined and reports an error when the cwd does not exist', async () => {
        (vscode.workspace.fs.stat as jest.Mock).mockRejectedValueOnce(new Error('ENOENT'));
        await expect(makeDelegate({ shellCmd: 'ls' }, '/missing').getValues()).resolves.toBeUndefined();
        expect(vscode.window.showErrorMessage).toHaveBeenCalled();
        expect(mockExec).not.toHaveBeenCalled();
    });

    it('returns undefined and reports an error when the command fails', async () => {
        execFails('boom', 'stderr text');
        await expect(makeDelegate({ shellCmd: 'bad' }).getValues()).resolves.toBeUndefined();
        expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });

    it('reports a persistent failure only once across repeated refreshes', async () => {
        execFails('boom', 'stderr text');
        const delegate = makeDelegate({ shellCmd: 'bad' });
        // the identical error must not pop a fresh toast on each forced run
        await delegate.getValues(true);
        await delegate.getValues(true);
        await delegate.getValues(true);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    });

    it('reports the failure again after a successful run in between', async () => {
        const delegate = makeDelegate({ shellCmd: 'flaky' });
        execFails('boom');
        await delegate.getValues(true); // first failure -> notified
        execResolves('a');
        await delegate.getValues(true); // recovers -> clears the remembered error
        execFails('boom');
        await delegate.getValues(true); // fails again -> notified again
        expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);
    });

    it('reports a different failure message even without a success in between', async () => {
        const delegate = makeDelegate({ shellCmd: 'bad' });
        execFails('first');
        await delegate.getValues(true);
        execFails('second');
        await delegate.getValues(true);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(2);
    });

    describe('caching', () => {
        it('reuses the cache on a silent refresh without re-executing', async () => {
            execResolves('a');
            const cache: CommandValuesCache = new Map();
            const delegate = makeDelegate({ shellCmd: 'ls' }, '/root', cache);
            await delegate.getValues(); // first load -> executes and caches
            await delegate.getValues(); // silent refresh -> cache hit
            expect(mockExec).toHaveBeenCalledTimes(1);
        });

        it('re-executes when forced even if a cache entry exists', async () => {
            execResolves('a');
            const cache: CommandValuesCache = new Map();
            const delegate = makeDelegate({ shellCmd: 'ls' }, '/root', cache);
            await delegate.getValues();
            await delegate.getValues(true);
            expect(mockExec).toHaveBeenCalledTimes(2);
        });

        it('re-executes when the command definition changes (shared cache, new delegate)', async () => {
            execResolves('a');
            const cache: CommandValuesCache = new Map();
            const key = 'statusBarParam.get.x';
            await new CommandValuesDelegate({ shellCmd: 'ls' }, '/root', cache, key).getValues();
            // a save rebuilds the param with an edited command but the same cache/key
            await new CommandValuesDelegate({ shellCmd: 'ls -a' }, '/root', cache, key).getValues();
            expect(mockExec).toHaveBeenCalledTimes(2);
        });

        it('caches a failure so a silent refresh neither re-runs nor re-toasts it', async () => {
            execFails('boom');
            const cache: CommandValuesCache = new Map();
            const key = 'statusBarParam.get.x';
            // first load (failed) caches the failure; a save rebuilds the param with
            // the same cache/key and refreshes silently
            await new CommandValuesDelegate({ shellCmd: 'bad' }, '/root', cache, key).getValues();
            await new CommandValuesDelegate({ shellCmd: 'bad' }, '/root', cache, key).getValues();
            expect(mockExec).toHaveBeenCalledTimes(1);
            expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
        });
    });
});
