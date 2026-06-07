import * as vscode from 'vscode';

// Guards that the jest-mock-vscode wrapper exposes every vscode API the
// extension touches at runtime, so a future upgrade that drops one is caught
// here rather than deep inside an unrelated test.
describe('vscode mock surface', () => {
    it('provides the value classes the code constructs', () => {
        expect(typeof vscode.Uri.file).toBe('function');
        expect(typeof vscode.Uri.joinPath).toBe('function');
        expect(typeof vscode.EventEmitter).toBe('function');
        expect(typeof vscode.Disposable).toBe('function');
        expect(typeof vscode.RelativePattern).toBe('function');
        expect(typeof vscode.ThemeIcon).toBe('function');
        expect(typeof vscode.ThemeColor).toBe('function');
        expect(typeof vscode.Range).toBe('function');
        expect(vscode.StatusBarAlignment.Left).toBeDefined();
        expect(vscode.TreeItemCollapsibleState.Expanded).toBeDefined();
    });

    it('provides the window functions the code calls', () => {
        for (const fn of [
            'createStatusBarItem',
            'showQuickPick',
            'showInputBox',
            'showInformationMessage',
            'showErrorMessage',
            'showTextDocument',
            'registerTreeDataProvider',
        ]) {
            expect(typeof (vscode.window as any)[fn]).toBe('function');
        }
    });

    it('provides the workspace functions the code calls', () => {
        for (const fn of [
            'getConfiguration',
            'createFileSystemWatcher',
            'openTextDocument',
            'onDidChangeConfiguration',
            'onDidChangeWorkspaceFolders',
            'onDidGrantWorkspaceTrust',
        ]) {
            expect(typeof (vscode.workspace as any)[fn]).toBe('function');
        }
        for (const fn of ['readFile', 'writeFile', 'stat']) {
            expect(typeof (vscode.workspace.fs as any)[fn]).toBe('function');
        }
        expect('isTrusted' in vscode.workspace).toBe(true);
    });

    it('provides commands and env', () => {
        expect(typeof vscode.commands.registerCommand).toBe('function');
        expect(typeof vscode.commands.getCommands).toBe('function');
        expect(typeof vscode.env.clipboard.writeText).toBe('function');
    });

    it('builds a usable status bar item', () => {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
        expect(item).toHaveProperty('text');
        expect(typeof item.show).toBe('function');
        expect(typeof item.dispose).toBe('function');
    });
});
