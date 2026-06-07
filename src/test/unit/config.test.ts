import * as vscode from 'vscode';
import { ExtensionConfig } from '../../config';

function context(workspaceState: unknown = {}): vscode.ExtensionContext {
    return { workspaceState } as unknown as vscode.ExtensionContext;
}

function withSettings(values: Record<string, unknown>): jest.SpyInstance {
    return jest.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
        get: (key: string, def?: unknown) => (key in values ? values[key] : def),
    } as unknown as vscode.WorkspaceConfiguration);
}

describe('ExtensionConfig', () => {
    it('applies the documented defaults', () => {
        withSettings({});
        const config = new ExtensionConfig(context());
        expect(config.showNames).toBe(false);
        expect(config.showSelections).toBe(true);
    });

    it('reads configured values', () => {
        withSettings({ showNames: true, showSelections: false });
        const config = new ExtensionConfig(context());
        expect(config.showNames).toBe(true);
        expect(config.showSelections).toBe(false);
    });

    it('reports whether loadSettings changed anything', () => {
        const spy = withSettings({});
        const config = new ExtensionConfig(context());

        spy.mockReturnValue({
            get: (key: string, def?: unknown) => (key === 'showNames' ? true : def),
        } as unknown as vscode.WorkspaceConfiguration);
        expect(config.loadSettings()).toBe(true);
        expect(config.showNames).toBe(true);
        expect(config.loadSettings()).toBe(false);
    });

    it('exposes the context workspaceState', () => {
        withSettings({});
        const state = { get: jest.fn(), update: jest.fn(), keys: jest.fn() };
        expect(new ExtensionConfig(context(state)).workspaceState).toBe(state);
    });
});
