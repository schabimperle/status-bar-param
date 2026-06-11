import * as vscode from 'vscode';
import { ParameterProvider } from '../../parameterProvider';
import { JsonFile } from '../../jsonFile';
import { Param } from '../../param';
import { ExtensionConfig } from '../../config';
import { Strings } from '../../strings';

const readFile = vscode.workspace.fs.readFile as jest.Mock;
let createWatcher: jest.SpyInstance;

beforeAll(() => {
    createWatcher = jest.spyOn(vscode.workspace, 'createFileSystemWatcher');
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
});

function realJsonFile(): JsonFile {
    return JsonFile.createFromPathOutsideWorkspace(
        1,
        vscode.Uri.file('/ws/.vscode/tasks.json'),
        { showNames: false, showSelections: true } as ExtensionConfig,
        new vscode.EventEmitter(),
    );
}

describe('ParameterProvider.getTreeItem', () => {
    it('renders a JsonFile node', () => {
        const file = realJsonFile();
        const item = new ParameterProvider([file], new vscode.EventEmitter()).getTreeItem(file);
        expect(item.contextValue).toBe('JsonFile');
        expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
        expect(item.command?.command).toBe('vscode.open');
        expect(item.resourceUri).toBe(file.uri);
    });

    it('renders a Param node', () => {
        const param = {
            id: 'myId',
            getSelectionText: () => 'selected',
            getIcon: () => new vscode.ThemeIcon('array'),
        } as unknown as Param;
        const item = new ParameterProvider([], new vscode.EventEmitter()).getTreeItem(param);
        expect(item.label).toBe('myId');
        expect(item.description).toBe('selected');
        expect(item.contextValue).toBe('Param');
        expect(item.command?.command).toBe(Strings.COMMAND_SELECT);
    });
});

describe('ParameterProvider.getChildren', () => {
    it('returns only files that have params at the root', () => {
        const withParams = { hasParams: () => true, displayRank: 0 } as unknown as JsonFile;
        const empty = { hasParams: () => false, displayRank: 0 } as unknown as JsonFile;
        const provider = new ParameterProvider([withParams, empty], new vscode.EventEmitter());
        expect(provider.getChildren()).toEqual([withParams]);
    });

    it('orders root files: local configs, then .code-workspace, then user tasks (stably)', () => {
        const user = { hasParams: () => true, displayRank: 2 } as unknown as JsonFile;
        const ws = { hasParams: () => true, displayRank: 1 } as unknown as JsonFile;
        const localA = { hasParams: () => true, displayRank: 0 } as unknown as JsonFile;
        const localB = { hasParams: () => true, displayRank: 0 } as unknown as JsonFile;
        // input order scrambled, matching how the extension assembles the list
        const provider = new ParameterProvider([user, localA, ws, localB], new vscode.EventEmitter());
        expect(provider.getChildren()).toEqual([localA, localB, ws, user]);
    });

    it('returns the params of a given file', () => {
        const params = [{ id: 'p' }] as unknown as Param[];
        const file = { params } as unknown as JsonFile;
        expect(new ParameterProvider([], new vscode.EventEmitter()).getChildren(file)).toBe(params);
    });
});

describe('ParameterProvider events', () => {
    it('exposes an onDidChangeTreeData event', () => {
        expect(typeof new ParameterProvider([], new vscode.EventEmitter()).onDidChangeTreeData).toBe('function');
    });
});
