import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Host-agnostic smoke checks shared by the local (./index.ts) and the genuine
 * remote (./remote/index.ts) runners, so the common behaviour is asserted once
 * per host instead of only locally. Each runner appends its own checks and
 * executes the combined list with runChecks().
 *
 * Only *behavioural* checks live here — ones that go through `executeCommand` to
 * retrieve a param value, which routes to wherever the extension runs. They work
 * identically in a local window and a genuine remote one (where the extension
 * runs in the remote host but the test runner runs in the local host). They also
 * implicitly prove the extension activated and registered its retrieval commands
 * on whichever host it lives.
 *
 * Introspective checks (getExtension/getCommands/packageJSON) are deliberately
 * NOT here: in a remote window they'd query the local extension host, which can't
 * see the remote-hosted extension. They stay local-only in ./index.ts.
 *
 * Both runners open the same fixture workspace (./fixtures/workspace), so the
 * `fruit` / `labelled` / `shellfruit` inputs exist on either side. The remote
 * host is slower to settle, so the polling budget is passed in (see waitFor).
 *
 * A tiny home-grown collector is used so this layer needs no test framework
 * beyond @vscode/test-electron.
 */
export interface Check {
    name: string;
    fn: () => Promise<void>;
}

/** Poll until `predicate(value)` holds or the timeout elapses. */
export async function waitFor<T>(produce: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs: number, intervalMs = 200): Promise<T> {
    const start = Date.now();
    for (;;) {
        const value = await produce();
        if (predicate(value)) {
            return value;
        }
        if (Date.now() - start > timeoutMs) {
            throw new Error(`timed out after ${timeoutMs}ms; last value: ${JSON.stringify(value)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

/** Retrieve a param value the way a tasks/launch substitution would, or undefined if not registered yet. */
async function getValue(id: string): Promise<string | undefined> {
    try {
        return await vscode.commands.executeCommand<string>(`statusBarParam.get.${id}`);
    } catch {
        return undefined;
    }
}

/**
 * The behavioural checks that must hold on every host. `timeoutMs` is the
 * per-check polling budget (the remote window needs a larger one than local).
 */
export function sharedChecks({ timeoutMs }: { timeoutMs: number }): Check[] {
    return [
        {
            name: 'resolves an array param to its default (first) value',
            fn: async () => {
                const value = await waitFor(
                    () => getValue('fruit'),
                    (v) => v === 'apple',
                    timeoutMs,
                );
                assert.strictEqual(value, 'apple');
            },
        },
        {
            name: 'returns the raw value (not the displayValue) for a labelled param',
            fn: async () => {
                const value = await waitFor(
                    () => getValue('labelled'),
                    (v) => v === 'v1',
                    timeoutMs,
                );
                assert.strictEqual(value, 'v1');
            },
        },
        {
            name: 'runs a real shell-command param and resolves its first output line',
            fn: async () => {
                const value = await waitFor(
                    () => getValue('shellfruit'),
                    (v) => v === 'cat',
                    timeoutMs,
                );
                assert.strictEqual(value, 'cat');
            },
        },
        {
            name: 'resolves a named (map) value through its per-key commands',
            fn: async () => {
                // the default (first) selection is the gcc map; its keys resolve independently
                const cc = await waitFor(
                    () => getValue('compiler.cc'),
                    (v) => v === 'gcc',
                    timeoutMs,
                );
                assert.strictEqual(cc, 'gcc');
                assert.strictEqual(await getValue('compiler.cxx'), 'g++');
            },
        },
        {
            name: 'returns empty for a keyless read of a map param',
            fn: async () => {
                // a map entry has no single keyless value (the extension also warns)
                assert.strictEqual(await getValue('compiler'), '');
            },
        },
        {
            name: 'joins a multi-selection with the configured joinSeparator',
            fn: async () => {
                // initialSelection ['a','b'] + joinSeparator ',' -> 'a,b'
                const value = await waitFor(
                    () => getValue('multi'),
                    (v) => v === 'a,b',
                    timeoutMs,
                );
                assert.strictEqual(value, 'a,b');
            },
        },
    ];
}

/** Run a list of checks, logging each, and throw if any failed. */
export async function runChecks(checks: Check[]): Promise<void> {
    let failed = 0;
    for (const { name, fn } of checks) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
        } catch (err) {
            failed++;
            console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.stack : String(err)}`);
        }
    }
    if (failed > 0) {
        throw new Error(`${failed}/${checks.length} smoke checks failed`);
    }
    console.log(`smoke OK: ${checks.length} checks passed`);
}
