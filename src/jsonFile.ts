import {
    workspace,
    commands,
    window,
    Uri,
    WorkspaceFolder,
    Disposable,
    RelativePattern,
    WorkspaceEdit,
    Range,
    TextDocument,
    FileSystemError,
    ConfigurationTarget,
} from 'vscode';
import * as jsonc from 'jsonc-parser';
import { JSONPath } from 'jsonc-parser';
import { Param } from './param';
import { ArrayValuesDelegate, CommandValuesCache, CommandValuesDelegate, ValuesDelegate } from './valuesDelegate';
import * as path from 'path';
import type { TreeChangeEmitter } from './parameterProvider';
import {
    ArrayOptions,
    ArrayValue,
    CommandOptions,
    Options,
    validateArrayOptionsInput,
    validateCommandOptionsInput,
    validateStatusBarParamInput,
} from './schemas';
import { Strings } from './strings';
import { ExtensionConfig } from './config';
import * as log from './log';

interface JsoncPaths {
    versionPath: JSONPath;
    tasksPath: JSONPath;
    inputsPath: JSONPath;
}

/**
 * One watched JSON file that may contribute parameters (a workspace
 * `tasks.json`/`launch.json`, a `.code-workspace`, or the user's global
 * `tasks.json`). Parses its `inputs` into {@link Param}s, keeps them in sync with
 * file changes, and writes new parameters back while preserving formatting. Reads
 * the user (global) tasks.json via the `tasks` configuration so it works from a
 * remote extension host (see {@link useDocumentIO}).
 */
export class JsonFile implements Disposable {
    // params are spaced this far below the file's base priority (decremented by 1
    // per file). Assumes < 1000 params/file; beyond that they interleave with the
    // next file's band in the status bar — cosmetic, not worth guarding.
    private static readonly PRIORITY_STEP = 0.001;
    private static readonly OPEN_USER_TASKS_TIMEOUT_MS = 10_000;
    private disposables: Disposable[] = [];
    private paramIdToEditOnCreate: string = '';
    private busy: boolean = false;
    private changeWhileBusy: boolean = false;
    // command-param output cache, keyed by retrieval command id. On the JsonFile
    // (not the Param) so it survives the param rebuild on each save: an unchanged
    // command isn't re-run just because the file was saved.
    private readonly commandValuesCache: CommandValuesCache = new Map();
    params: Param[] = [];

    static createFromPathInsideWorkspace(
        priority: number,
        workspaceFolder: WorkspaceFolder,
        relativePath: string,
        config: ExtensionConfig,
        changeEmitter: TreeChangeEmitter,
    ): JsonFile {
        log.debug('createFromPathInsideWorkspace:', workspaceFolder.name, relativePath);

        // workaround for bug: https://github.com/microsoft/vscode/issues/10633
        const uri = workspaceFolder.uri.with({ path: `${workspaceFolder.uri.path}/${relativePath}` });

        // wait for changes of tasks.json
        const jsonFile = new JsonFile(priority, uri, config, changeEmitter, workspaceFolder);
        const pattern = new RelativePattern(workspaceFolder, relativePath);
        const watcher = workspace.createFileSystemWatcher(pattern);
        watcher.onDidChange(() => jsonFile.coalesceFileChange());
        watcher.onDidCreate(() => jsonFile.coalesceFileChange());
        // re-parse instead of disposing, so a recreated file is picked back up;
        // full disposal happens on workspace-folder removal (removeWorkspaceFolder)
        watcher.onDidDelete(() => jsonFile.coalesceFileChange());
        jsonFile.disposables.push(new Disposable(() => watcher.dispose()));

        // init status bar items
        jsonFile.coalesceFileChange();
        return jsonFile;
    }

    static createFromPathOutsideWorkspace(priority: number, uri: Uri, config: ExtensionConfig, changeEmitter: TreeChangeEmitter): JsonFile {
        log.debug('createFromPathOutsideWorkspace:', uri.toString());

        // wait for changes of the given file
        const jsonFile = new JsonFile(priority, uri, config, changeEmitter);
        if (jsonFile.useDocumentIO) {
            // user tasks.json is read via the `tasks` configuration; re-parse on change
            jsonFile.disposables.push(
                workspace.onDidChangeConfiguration((e) => {
                    if (e.affectsConfiguration('tasks')) {
                        jsonFile.coalesceFileChange();
                    }
                }),
            );
        } else {
            // FileSystemWatcher, not fs.watch: fs.watch throws when the file is absent
            // and never fires on later create. Watching the parent dir for the basename
            // handles create/change/delete uniformly even while the file doesn't exist.
            // escape glob metacharacters so `app[dev].code-workspace` matches literally
            const escapedName = path.posix.basename(uri.path).replace(/[*?[\]{}]/g, '\\$&');
            // keep the uri's scheme (not Uri.file(fsPath)): may be a `vscode-remote:` uri
            const pattern = new RelativePattern(Uri.joinPath(uri, '..'), escapedName);
            const watcher = workspace.createFileSystemWatcher(pattern);
            watcher.onDidChange(() => jsonFile.coalesceFileChange());
            watcher.onDidCreate(() => jsonFile.coalesceFileChange());
            // re-parse (clearing params) instead of disposing, so the watcher keeps
            // running and picks the file back up if it is recreated
            watcher.onDidDelete(() => jsonFile.coalesceFileChange());
            jsonFile.disposables.push(new Disposable(() => watcher.dispose()));
        }

        // init status bar items
        jsonFile.coalesceFileChange();
        return jsonFile;
    }

    // parameter properties handle the field assignments; no constructor body needed
    private constructor(
        private priority: number,
        public uri: Uri,
        private readonly config: ExtensionConfig,
        public readonly changeEmitter: TreeChangeEmitter,
        public workspaceFolder?: WorkspaceFolder,
    ) {}

    // The user tasks.json lives under the workbench-owned `vscode-userdata:` scheme,
    // unreachable from a remote extension host. Its inputs are read via the `tasks`
    // config and written by editing the document the workbench opens for us.
    get useDocumentIO(): boolean {
        return this.uri.scheme === 'vscode-userdata';
    }

    // VS Code's user-level (global) tasks.json: the vscode-userdata document
    // remotely, or locally a tasks.json with no workspace folder (a workspace's own
    // .vscode/tasks.json has one; the other outside file is the .code-workspace).
    get isUserTasks(): boolean {
        return this.useDocumentIO || (!this.workspaceFolder && this.getFileName() === 'tasks.json');
    }

    // A .code-workspace nests tasks/launch (and inputs) under top-level
    // `tasks`/`launch` keys; every other file holds them at the top level.
    get isCodeWorkspace(): boolean {
        return this.uri.path.endsWith('.code-workspace');
    }

    // launch.json has no `tasks` and gets no version/sample-task treatment.
    get isLaunchJson(): boolean {
        return this.uri.path.endsWith('launch.json');
    }

    // read the file's text, or undefined if it doesn't exist (file-scheme files only)
    async readText(): Promise<string | undefined> {
        try {
            // decode as UTF-8: .toString() on a plain Uint8Array (the API's return
            // type) yields byte values, not text, if the host doesn't return a Buffer
            return new TextDecoder('utf-8').decode(await workspace.fs.readFile(this.uri));
        } catch (err) {
            // an absent file is the normal "no params yet" case; any other failure
            // (permissions, flaky remote) must not be mistaken for a deletion, so
            // surface it rather than returning undefined and dropping the params
            if (err instanceof FileSystemError && err.code === 'FileNotFound') {
                return undefined;
            }
            throw err;
        }
    }

    // apply a transform to the file's current text and persist the result
    async mutate(transform: (current: string) => string): Promise<void> {
        if (!this.useDocumentIO) {
            const current = (await this.readText()) ?? '{}';
            // writeFile doesn't create missing dirs, so ensure the parent (e.g. a
            // not-yet-created `.vscode`) exists. createDirectory is recursive and a
            // no-op if it already exists.
            await workspace.fs.createDirectory(Uri.joinPath(this.uri, '..'));
            await workspace.fs.writeFile(this.uri, Buffer.from(transform(current)));
            return;
        }
        const doc = await this.openUserDataDocument();
        const updated = transform(doc.getText() || '{}');
        const edit = new WorkspaceEdit();
        edit.replace(doc.uri, new Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), updated);
        await workspace.applyEdit(edit);
        await doc.save();
    }

    // have the workbench open (creating if needed) the real user tasks.json and
    // return its document; the open event arrives asynchronously after the command.
    // Only used for editing an EXISTING user param (delete/reveal): adding a new one
    // writes via the `tasks` config instead, so a missing file never triggers the
    // workbench's "create tasks.json from template" picker (see addParamToUserTasks).
    private openUserDataDocument(): Promise<TextDocument> {
        const isUserTasks = (doc: TextDocument) => doc.uri.scheme === 'vscode-userdata' && path.posix.basename(doc.uri.path) === 'tasks.json';
        const open = workspace.textDocuments.find(isUserTasks);
        if (open) {
            return Promise.resolve(open);
        }
        return new Promise<TextDocument>((resolve, reject) => {
            const sub = workspace.onDidOpenTextDocument((doc) => {
                if (isUserTasks(doc)) {
                    cleanup();
                    resolve(doc);
                }
            });
            // don't let mutate() hang forever if the open event never arrives
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('Timed out waiting for the user tasks.json to open.'));
            }, JsonFile.OPEN_USER_TASKS_TIMEOUT_MS);
            const cleanup = () => {
                clearTimeout(timer);
                sub.dispose();
            };
            // trigger the open inside the promise so a failed command rejects here
            // (and cleans up) instead of leaving the listener/timer dangling
            Promise.resolve(commands.executeCommand('workbench.action.tasks.openUserTasks')).catch((err) => {
                cleanup();
                reject(err);
            });
        });
    }

    hasParams() {
        return this.params.length > 0;
    }

    getFileName() {
        return path.basename(this.uri.path);
    }

    getDescription() {
        if (this.workspaceFolder) {
            return this.workspaceFolder.name;
        }
        // stable friendly label for the user (global) tasks.json: its uri is a
        // placeholder remotely, and a noisy user-data path locally
        if (this.isUserTasks) {
            return 'User';
        }
        return this.uri.fsPath;
    }

    // default cwd for a command param's shell command: the json file's folder, with
    // a trailing `.vscode` stripped so `<root>/.vscode/tasks.json` resolves to `<root>`.
    // Shared by CommandValuesDelegate and the add-param prompt.
    getDefaultCwd(): string {
        // the user (global) tasks.json isn't tied to a folder, so default to the root
        if (this.useDocumentIO) {
            return '/';
        }
        // strip a trailing `.vscode` via path ops, not regex, so a file at a drive
        // root (`/.vscode/tasks.json`, `C:\.vscode\tasks.json`) resolves to the root
        const dir = path.dirname(this.uri.fsPath);
        return path.basename(dir) === '.vscode' ? path.dirname(dir) : dir;
    }

    getJsoncPaths() {
        const res: JsoncPaths = {
            versionPath: ['version'],
            tasksPath: ['tasks'],
            inputsPath: ['inputs'],
        };
        if (this.isCodeWorkspace) {
            res.versionPath.unshift('tasks');
            res.tasksPath.unshift('tasks');
            res.inputsPath.unshift('tasks');
        }
        return res;
    }

    // Every inputs array this file may define params in: a .code-workspace has one
    // under `tasks` and one under `launch`; everything else a single top-level
    // `inputs`. Each param records which it came from (Param.inputsPath).
    getInputsPaths(): JSONPath[] {
        if (this.isCodeWorkspace) {
            return [
                ['tasks', 'inputs'],
                ['launch', 'inputs'],
            ];
        }
        return [['inputs']];
    }

    // coalesce change events that arrive while onFileChange is running
    private async coalesceFileChange() {
        if (this.busy === true) {
            this.changeWhileBusy = true;
            return;
        }

        this.busy = true;
        await this.onFileChange();
        this.busy = false;

        if (this.changeWhileBusy === true) {
            this.changeWhileBusy = false;
            this.coalesceFileChange();
        }
    }

    private async onFileChange() {
        log.debug('onFileChange', this.uri.fsPath);
        // read before disposing the current params: a transient read failure (vs a
        // genuine not-found) must not be mistaken for a deletion and clear them
        let fileContent: string | undefined;
        if (!this.useDocumentIO) {
            try {
                fileContent = await this.readText();
            } catch (err) {
                console.error(err);
                window.showErrorMessage(`Failed to read ${this.getFileName()}: ${err instanceof Error ? err.message : String(err)}`);
                return; // keep the current params rather than dropping them on a read error
            }
        }
        const oldParamLength = this.params.length;
        this.disposeParams();
        this.params = [];
        if (this.useDocumentIO) {
            // read the user-level inputs via the `tasks` config (works from a remote host)
            const inputs = workspace.getConfiguration('tasks').inspect<unknown[]>('inputs')?.globalValue;
            if (Array.isArray(inputs)) {
                inputs.forEach((input) => this.addParamFromValue(input, ['inputs']));
            }
        } else if (fileContent !== undefined) {
            const rootNode = jsonc.parseTree(fileContent);
            // parseTree returns undefined for empty or unparseable files (jsonc-parser >=3)
            if (rootNode) {
                // parse every inputs section, tagging each param with the section
                // it came from so it can later be deleted from the right place
                this.getInputsPaths().forEach((inputsPath) => this.parseInputs(jsonc.findNodeAtLocation(rootNode, inputsPath), inputsPath));
            }
        } else {
            log.debug("File doesn't exist (yet)", this.uri.toString());
        }
        if (oldParamLength === 0 || this.params.length === 0) {
            this.changeEmitter.fire();
        } else {
            this.changeEmitter.fire(this);
        }
    }

    private parseInputs(inputs: jsonc.Node | undefined, inputsPath: JSONPath) {
        if (!inputs?.children) {
            return;
        }
        inputs.children.forEach((inputNode) => this.addParamFromValue(jsonc.getNodeValue(inputNode), inputsPath));
    }

    // build a Param from a parsed `input` value
    private addParamFromValue(input: unknown, inputsPath: JSONPath) {
        // derive from the file's priority so params show in order (see PRIORITY_STEP)
        const paramPriority = this.priority - this.params.length * JsonFile.PRIORITY_STEP;
        // ignore inputs not intended for this extension
        if (!validateStatusBarParamInput(input)) {
            return;
        }
        // command must be exactly `get.<id>`: the schema gate only checks the prefix,
        // but Copy/duplicate-detection derive it from id, so a mismatch is broken
        if (input.command !== `${Strings.EXTENSION_ID}.get.${input.id}`) {
            return;
        }

        // create specific param and add it to the status bar
        let valuesDelegate: ValuesDelegate;
        let options: Options;
        if (validateArrayOptionsInput(input.args)) {
            // the validator accepts both a bare array and the { values, ... } form;
            // wrap a bare array as { values } so ArrayValuesDelegate always gets an
            // ArrayOptions instead of crashing on undefined `arrayOptions.values`
            const arrayOptions: ArrayOptions = Array.isArray(input.args) ? { values: input.args } : input.args;
            valuesDelegate = new ArrayValuesDelegate(arrayOptions);
            options = arrayOptions;
        } else if (validateCommandOptionsInput(input.args)) {
            // determine the default path to execute the command from
            valuesDelegate = new CommandValuesDelegate(input.args, this.getDefaultCwd(), this.commandValuesCache, input.command);
            options = input.args;
        } else {
            return;
        }
        const param = new Param(input.id, input.command, options, paramPriority, inputsPath, this, valuesDelegate, this.config);
        // a duplicate id means another file's param already owns the retrieval
        // command: drop this one (disposing its status bar item) rather than leaving
        // a non-functional entry in the tree and status bar
        if (param.registrationFailed) {
            param.dispose();
            return;
        }
        this.params.push(param);

        // open param added before
        if (this.paramIdToEditOnCreate === input.id) {
            param.reveal();
            this.paramIdToEditOnCreate = '';
        }
    }

    update() {
        log.debug('update');
        this.params.forEach((param) => param.update());
    }

    disposeParams() {
        log.debug('disposeParams');
        while (this.params.length > 0) {
            const param = this.params.pop();
            if (param) {
                param.dispose();
            }
        }
        // callers fire the tree emitter; this avoids an intermediate empty-state
        // refresh in onFileChange, which fires once after re-parsing
    }

    dispose() {
        log.debug('dispose');
        // dispose the params' status bar items too, or they linger after the file
        // or its workspace folder is removed
        this.disposeParams();
        this.changeEmitter.fire();
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    // write a new parameter (and optionally a sample task) into this json file.
    // the interactive gathering of id/args/addSampleTask lives in commands.ts.
    async addParam(id: string, args: ArrayValue[] | ArrayOptions | CommandOptions, addSampleTask: boolean) {
        try {
            if (this.useDocumentIO) {
                // The user (global) tasks.json has no openable uri; the only way to open
                // it is the workbench's `openUserTasks` command, which pops VS Code's
                // "create tasks.json from template" picker whenever the file has no
                // tasks defined (and the picker overwrites the file, dropping our
                // inputs). So we add params by writing the `tasks` configuration (the
                // same channel inputs are read from) instead of opening the file, and
                // make sure the file is never left task-less. The re-parse on the
                // config change shows the new param; no reveal, since opening the file
                // is exactly what we are avoiding.
                await this.addParamToUserTasks(id, args, addSampleTask);
                return;
            }
            // set before mutating so the re-parse triggered by the write reveals it
            this.paramIdToEditOnCreate = id;
            await this.mutate((current) => this.withNewParam(current, id, args, addSampleTask));
        } catch (err) {
            console.error(err);
            this.paramIdToEditOnCreate = '';
            window.showErrorMessage(`Failed to add parameter '${id}': ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // add a parameter to the user (global) tasks.json via the `tasks` configuration,
    // appending to the inputs/tasks read from the Global scope (VS Code fills in the
    // file's `version` itself). Writing config rather than editing the opened document
    // avoids the template picker; the trade-off is no preserved formatting / tip comment.
    private async addParamToUserTasks(id: string, args: ArrayValue[] | ArrayOptions | CommandOptions, addSampleTask: boolean) {
        const tasksConfig = workspace.getConfiguration('tasks');
        const tasks = [...(tasksConfig.inspect<unknown[]>('tasks')?.globalValue ?? [])];
        // VS Code's task tooling treats a task-less tasks.json as "unconfigured": opening
        // it (our edit/reveal, or the user's own "Open User Tasks") then prompts to create
        // one from a template, which overwrites the file and loses our inputs. The user
        // file is only reachable through that command, so it must never be left task-less
        // — add the demo task when the file would otherwise have none.
        // write tasks before inputs so a failure midway leaves the file with a task
        // (still openable without the picker) rather than a task-less, inputs-only file
        const forcedTask = !addSampleTask && tasks.length === 0;
        if (addSampleTask || forcedTask) {
            tasks.push(JsonFile.buildSampleTask(id));
            await tasksConfig.update('tasks', tasks, ConfigurationTarget.Global);
        }
        // re-read from a fresh config snapshot (the one above predates the tasks write)
        // to narrow the window for clobbering a concurrent external `inputs` change
        const inputs = [...(workspace.getConfiguration('tasks').inspect<unknown[]>('inputs')?.globalValue ?? [])];
        inputs.push(JsonFile.buildInput(id, args));
        await workspace.getConfiguration('tasks').update('inputs', inputs, ConfigurationTarget.Global);
        if (forcedTask) {
            window.showInformationMessage(
                `Added a sample task for '${id}' to your user tasks.json — VS Code needs at least one task there, ` +
                    `otherwise opening the file prompts to create one from a template.`,
            );
        }
    }

    // remove a parameter's input from the user (global) tasks.json via the `tasks`
    // configuration. Like addParamToUserTasks, this edits config instead of opening the
    // file, so deleting the last param never drops the file into the task-less state
    // that makes the next openUserTasks pop the template picker. The user tasks.json is
    // never a .code-workspace, so its inputs are always the top-level `inputs` array.
    async deleteParamFromUserTasks(id: string): Promise<void> {
        const tasksConfig = workspace.getConfiguration('tasks');
        const inputs = (tasksConfig.inspect<Array<{ id?: string }>>('inputs')?.globalValue ?? []).filter((input) => input?.id !== id);
        await tasksConfig.update('inputs', inputs, ConfigurationTarget.Global);
    }

    // the extension's input entry: a command input that resolves via this param's
    // generated retrieval command. Shared by the text-edit and config write paths.
    private static buildInput(id: string, args: ArrayValue[] | ArrayOptions | CommandOptions) {
        return { id, type: 'command', command: `${Strings.EXTENSION_ID}.get.${id}`, args };
    }

    // a runnable example task that echoes the param's value, to show how `${input:id}`
    // is used. Shared by the text-edit and config write paths.
    private static buildSampleTask(id: string) {
        return {
            label: `echo value of ${id}`,
            type: 'shell',
            // single-quote so the JSON needs no escaped " (which would distract
            // from the `${input:...}` reference)
            command: `echo 'Current value of ${id} is \${input:${id}}.'`,
            problemMatcher: [],
        };
    }

    // return `fileContent` with the new input (and optional sample task) added
    // detect the file's indentation so inserts match it: jsonc-parser's default ({})
    // emits tabs and re-flows the touched property to column 0, mixing styles in a
    // space file. Fall back to 4-space (VS Code's default) for a flat/empty file.
    static detectFormatting(fileContent: string): jsonc.FormattingOptions {
        const indent = fileContent.match(/\n([ \t]+)\S/)?.[1];
        if (indent?.startsWith('\t')) {
            return { tabSize: 4, insertSpaces: false };
        }
        if (indent) {
            return { tabSize: indent.length, insertSpaces: true };
        }
        return { tabSize: 4, insertSpaces: true };
    }

    private withNewParam(fileContent: string, id: string, args: ArrayValue[] | ArrayOptions | CommandOptions, addSampleTask: boolean): string {
        // the parsed object is read-only scaffolding: it answers "does this key
        // already exist?" so we don't overwrite it. All persisted writes go through
        // jsonc.modify/applyEdits on the string below; mutations to rootNode/tasksRoot
        // here (e.g. `rootNode.tasks = {}`) only track that bookkeeping locally.
        const formattingOptions = JsonFile.detectFormatting(fileContent);
        let rootNode = jsonc.parse(fileContent);
        if (!rootNode) {
            rootNode = {};
        }
        let tasksRoot = rootNode;

        const jsoncPaths = this.getJsoncPaths();
        if (this.isCodeWorkspace) {
            if (!rootNode.tasks) {
                rootNode.tasks = {};
            }
            tasksRoot = rootNode.tasks;
        }

        if (!rootNode.version && !this.isLaunchJson) {
            fileContent = jsonc.applyEdits(fileContent, jsonc.modify(fileContent, jsoncPaths.versionPath, '2.0.0', { formattingOptions }));
        }
        if (addSampleTask) {
            if (!tasksRoot.tasks) {
                tasksRoot.tasks = [];
            }
            // derive the indexed path locally rather than mutating the shared struct
            const taskPath = [...jsoncPaths.tasksPath, tasksRoot.tasks.length];
            fileContent = jsonc.applyEdits(fileContent, jsonc.modify(fileContent, taskPath, JsonFile.buildSampleTask(id), { formattingOptions }));
            // label the task so it's clear it only demonstrates the parameter
            fileContent = this.withCommentAboveNode(fileContent, taskPath, `// Sample task demonstrating the use of the '${id}' parameter.`);
        }
        // deliberate asymmetry with getInputsPaths(): a .code-workspace's params are
        // read from both tasks.inputs and launch.inputs, but new ones are always
        // written to tasks.inputs (jsoncPaths.inputsPath), never launch.inputs
        if (!tasksRoot.inputs) {
            tasksRoot.inputs = [];
        }
        const isFirstInput = tasksRoot.inputs.length === 0;
        const input = JsonFile.buildInput(id, args);
        const inputPath = [...jsoncPaths.inputsPath, tasksRoot.inputs.length];
        const modifications = jsonc.modify(fileContent, inputPath, input, { formattingOptions });
        fileContent = jsonc.applyEdits(fileContent, modifications);
        // one-time hint, above the only configurable property (`args`), that it can
        // hold either a value array or an options object (command params, advanced
        // options) discoverable via JSON IntelliSense
        if (isFirstInput) {
            const comment =
                "// 'args' can be an array of values, or an object for command params\n" + '// and advanced options — start typing inside it for IntelliSense.';
            fileContent = this.withCommentAboveNode(fileContent, [...inputPath, 'args'], comment);
        }
        return fileContent;
    }

    // insert a `// ...` comment (one or more `\n`-separated lines) on its own
    // line(s) directly above the node at `path`, matching that line's indentation.
    // The node's offset sits on the line we want (the `{`/`[` of a value, or the
    // key of `"args": [`), so the comment lands above the whole entry. No-op if the
    // node isn't found.
    private withCommentAboveNode(fileContent: string, path: JSONPath, comment: string): string {
        const tree = jsonc.parseTree(fileContent);
        const node = tree && jsonc.findNodeAtLocation(tree, path);
        if (!node) {
            return fileContent;
        }
        const lineStart = fileContent.lastIndexOf('\n', node.offset - 1) + 1;
        const indent = fileContent.slice(lineStart, node.offset).match(/^[\t ]*/)?.[0] ?? '';
        // indent every line of the comment so a multi-line tip stays aligned
        const block = comment
            .split('\n')
            .map((line) => indent + line)
            .join('\n');
        return fileContent.slice(0, lineStart) + block + '\n' + fileContent.slice(lineStart);
    }
}
