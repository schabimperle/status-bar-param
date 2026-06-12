import { workspace, ExtensionContext, window, commands, env, EventEmitter, Uri, WorkspaceFolder } from 'vscode';
import { JsonFile } from './jsonFile';
import { Strings } from './strings';
import { Param } from './param';
import { ParameterProvider, type TreeChangeEmitter } from './parameterProvider';
import { ExtensionConfig } from './config';
import { onAddParam, onCopyCmd, onDelete, onEdit, onReset, onSelect } from './commands';
import * as log from './log';

const WORKSPACE_INPUT_FILES = ['.vscode/tasks.json', '.vscode/launch.json'];

/** Activation-time state and wiring; command/listener bodies delegate to commands.ts. */
class StatusBarParam {
    private readonly jsonFiles: JsonFile[] = [];
    private readonly config: ExtensionConfig;
    // tree-view change emitter, injected into the provider and every JsonFile/Param
    // so they can request a refresh without reaching for global state
    private readonly changeEmitter: TreeChangeEmitter = new EventEmitter();
    // status bar priority (higher = further left), decremented per file so later
    // files sort after earlier ones. May go negative, which VS Code handles fine.
    private nextPriority = 100;

    constructor(private readonly context: ExtensionContext) {
        this.config = new ExtensionConfig(context);
    }

    activate() {
        log.debug('activate');

        // add disposables to the context array to be disposed at extension shutdown
        this.context.subscriptions.push(
            // listen for extension configuration changes
            workspace.onDidChangeConfiguration((e) => {
                log.debug('onDidChangeConfiguration');
                if (e.affectsConfiguration(Strings.EXTENSION_ID)) {
                    this.refresh();
                }
            }),

            // global commands. COMMAND_ADD (palette + view title `+`) always prompts
            // for the target file: since VS Code 2022 a view/title command is handed
            // the tree's focused node, so accepting an argument here would silently skip
            // the file prompt whenever a node happened to be selected. The per-file
            // inline `+` keeps that behavior under its own command (COMMAND_ADD_TO_FILE).
            commands.registerCommand(Strings.COMMAND_ADD, () => onAddParam(this.config, this.jsonFiles)),
            commands.registerCommand(Strings.COMMAND_ADD_TO_FILE, (jsonFile?: JsonFile) =>
                onAddParam(this.config, this.jsonFiles, jsonFile instanceof JsonFile ? jsonFile : undefined),
            ),
            commands.registerCommand(Strings.COMMAND_RESET_SELECTIONS, () => onReset(this.config, this.jsonFiles)),
            // open a file node from the tree. Routed through the JsonFile (not a bare
            // vscode.open on its uri) so the user tasks.json, whose uri is an unopenable
            // vscode-userdata placeholder remotely, opens via the workbench instead.
            commands.registerCommand(Strings.COMMAND_OPEN_FILE, (jsonFile?: JsonFile) => {
                if (jsonFile instanceof JsonFile) {
                    jsonFile.open();
                }
            }),

            // param commands (fall back to a picker when invoked without a param)
            this.createParamCommand(Strings.COMMAND_SELECT, onSelect),
            this.createParamCommand(Strings.COMMAND_EDIT, onEdit),
            this.createParamCommand(Strings.COMMAND_COPY_CMD, onCopyCmd),
            this.createParamCommand(Strings.COMMAND_DELETE, onDelete),

            // listen for changes of workspace folders
            workspace.onDidChangeWorkspaceFolders((e) => {
                e.added.forEach((folder) => this.addWorkspaceFolder(folder));
                e.removed.forEach((folder) => this.removeWorkspaceFolder(folder));
                this.changeEmitter.fire();
            }),

            // dispose the change emitter on shutdown
            this.changeEmitter,

            // re-evaluate once trusted: command params skipped while untrusted now run
            workspace.onDidGrantWorkspaceTrust(() => {
                log.debug('onDidGrantWorkspaceTrust');
                this.jsonFiles.forEach((jsonFile) => jsonFile.update());
            }),
        );
        // listen for changes of the global user tasks.json
        this.addJsonFile(this.getUserTasksUri());
        // listen for changes of the .code-workspace file
        if (workspace.workspaceFile && workspace.workspaceFile.scheme !== 'untitled') {
            this.addJsonFile(workspace.workspaceFile);
        }

        // init workspace
        workspace.workspaceFolders?.forEach((folder) => this.addWorkspaceFolder(folder));

        // register status bar param tab in file explorer
        this.context.subscriptions.push(window.registerTreeDataProvider(Strings.EXTENSION_ID, new ParameterProvider(this.jsonFiles, this.changeEmitter)));
    }

    dispose() {
        log.debug('deactivate');
        this.jsonFiles.forEach((jsonFile) => jsonFile.dispose());
    }

    // a param command that prompts for a param when invoked without one (e.g. from
    // the command palette instead of a tree item)
    private createParamCommand(commandString: string, cb: (param: Param) => unknown) {
        return commands.registerCommand(commandString, async (param?: Param) => {
            param ??= await this.pickParam();
            if (param) {
                cb(param);
            }
        });
    }

    private async pickParam(): Promise<Param | undefined> {
        const items = this.jsonFiles
            .flatMap((jsonFile) => jsonFile.params)
            .map((param) => ({
                label: `$(${param.getIcon().id}) ${param.id}`,
                description: param.getSelectionText(),
                param,
            }));
        const res = await window.showQuickPick(items, {
            placeHolder: 'Select a parameter.',
            // match the other prompts: a focus change shouldn't silently cancel the pick
            ignoreFocusOut: true,
        });
        return res?.param;
    }

    private addWorkspaceFolder(workspaceFolder: WorkspaceFolder) {
        log.debug('addWorkspaceFolder', workspaceFolder.name);
        WORKSPACE_INPUT_FILES.forEach((relativePath) => {
            const jsonFile = JsonFile.createFromPathInsideWorkspace(this.nextPriority--, workspaceFolder, relativePath, this.config, this.changeEmitter);
            this.jsonFiles.push(jsonFile);
        });
    }

    private addJsonFile(path: Uri) {
        log.debug('addJsonFile', path.fsPath);
        const jsonFile = JsonFile.createFromPathOutsideWorkspace(this.nextPriority--, path, this.config, this.changeEmitter);
        this.jsonFiles.push(jsonFile);
    }

    private removeWorkspaceFolder(workspaceFolder: WorkspaceFolder) {
        log.debug('removeWorkspaceFolder', workspaceFolder.name);
        // match by uri, not identity: the removed event may not carry the stored
        // reference, and a mismatch would leak its watchers
        const removedUri = workspaceFolder.uri.toString();
        for (let i = this.jsonFiles.length - 1; i >= 0; i--) {
            if (this.jsonFiles[i].workspaceFolder?.uri.toString() === removedUri) {
                this.jsonFiles[i].dispose();
                this.jsonFiles.splice(i, 1);
            }
        }
    }

    // reload settings and, if they changed, re-render all params
    private refresh() {
        log.debug('refresh');
        if (this.config.loadSettings()) {
            this.jsonFiles.forEach((jsonFile) => jsonFile.update());
        }
    }

    // URI of VS Code's user-level (global) tasks.json. Locally it sits next to the
    // extension's global storage; in a remote window its real path is unresolvable
    // here, so return a `vscode-userdata` placeholder routed through the workbench
    // (see JsonFile.useDocumentIO).
    private getUserTasksUri(): Uri {
        if (env.remoteName) {
            return Uri.from({ scheme: 'vscode-userdata', path: '/tasks.json' });
        }
        return Uri.joinPath(this.context.globalStorageUri, '../../tasks.json');
    }
}

let extension: StatusBarParam | undefined;

/** VS Code entry point: build the extension instance and wire it up. */
export function activate(context: ExtensionContext) {
    extension = new StatusBarParam(context);
    extension.activate();
}

/** VS Code shutdown hook: dispose the extension (guarded against double/early calls). */
export function deactivate() {
    extension?.dispose();
    extension = undefined;
}
