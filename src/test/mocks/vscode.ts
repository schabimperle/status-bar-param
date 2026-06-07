/**
 * Runtime mock of the `vscode` module for headless Jest tests.
 *
 * Backed by the maintained `jest-mock-vscode` package (real vscode-uri based
 * Uri, EventEmitter, Range, … plus jest.fn() spies for window/workspace/…), so
 * we don't hand-roll the API surface. Jest maps `import ... from 'vscode'` here
 * via moduleNameMapper in jest.config.js; type-checking still uses the real
 * `@types/vscode`, so this only provides the runtime values.
 *
 * `env` and `RelativePattern` are the only two members the extension uses that
 * jest-mock-vscode leaves unimplemented (both appear in its NotImplemented list
 * in every released version), so we supply minimal stand-ins for them here.
 */
import { jest } from '@jest/globals';
import { createVSCodeMock } from 'jest-mock-vscode';

const vscode = createVSCodeMock(jest) as Record<string, unknown>;

if (!vscode.env) {
    vscode.env = { clipboard: { writeText: jest.fn(async () => undefined) } };
}

if (!vscode.RelativePattern) {
    vscode.RelativePattern = class RelativePattern {
        readonly baseUri: unknown;
        constructor(
            public base: unknown,
            public pattern: string,
        ) {
            this.baseUri = base;
        }
    };
}

// jest-mock-vscode leaves the text-document event subscriptions returning
// undefined; the real API returns a Disposable, which the extension stores and
// later disposes. Hand back a real Disposable so disposal doesn't crash.
const Disposable = vscode.Disposable as { new (fn: () => void): unknown };
const workspaceMock = vscode.workspace as Record<string, unknown>;
for (const name of ['onDidChangeTextDocument', 'onDidSaveTextDocument', 'onDidOpenTextDocument', 'onDidCloseTextDocument', 'onDidChangeConfiguration']) {
    const fn = workspaceMock[name] as { mockReturnValue?: (v: unknown) => void } | undefined;
    fn?.mockReturnValue?.(new Disposable(() => undefined));
}

export = vscode;
