import { commands, Disposable, Range, StatusBarAlignment, StatusBarItem, ThemeColor, ThemeIcon, window, workspace } from 'vscode';
import { JSONPath } from 'jsonc-parser';
import { Strings } from './strings';
import { JsonFile } from './jsonFile';
import { ValuesDelegate } from './valuesDelegate';
import { DisplayableValue, Options } from './schemas';
import { ExtensionConfig } from './config';

/**
 * A single status-bar parameter: owns its `StatusBarItem`, registers the
 * `statusBarParam.get.<id>` retrieval command, and persists/restores the selected
 * value(s) in workspace state. Value resolution is delegated to a {@link ValuesDelegate}
 * (static array vs. shell command). One Param is rebuilt per parse of its JsonFile.
 */
export class Param {
    // a dimmed-but-readable grey for params with no selection, so an active
    // (selected) param keeps the normal status-bar foreground and visibly stands
    // out. `input.foreground` was wrong here — in many themes it is *brighter* than
    // the default, making empty params look more prominent than selected ones.
    private static readonly COLOR_INACTIVE = new ThemeColor('descriptionForeground');
    private readonly statusBarItem: StatusBarItem;
    private readonly disposables: Disposable[] = [];
    // bumped on each update() so a late-resolving refresh can detect a newer one
    // started and bow out instead of writing a stale result
    private updateGeneration = 0;
    // set when the retrieval command couldn't be registered (duplicate id, owned by
    // another file's param). The owning JsonFile then drops this param.
    registrationFailed = false;

    constructor(
        public readonly id: string,
        public readonly command: string,
        public readonly opts: Options,
        private readonly priority: number,
        public readonly jsonOffset: number,
        public readonly jsonArrayIndex: number,
        // JSONPath of the inputs array this param lives in (['inputs'], or
        // ['launch','inputs'] in a .code-workspace); used to delete the right entry
        public readonly inputsPath: JSONPath,
        public readonly jsonFile: JsonFile,
        public readonly valuesDelegate: ValuesDelegate,
        private readonly config: ExtensionConfig,
    ) {
        // create status bar item
        this.statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left, this.priority);
        this.statusBarItem.tooltip = this.id;
        this.disposables.push(this.statusBarItem);
        this.statusBarItem.command = {
            title: 'Select',
            command: Strings.COMMAND_SELECT,
            arguments: [this],
            tooltip: this.id,
        };
        try {
            // create command to retrieve the selected value (when input:<input_id> is used in json)
            this.disposables.push(commands.registerCommand(this.command, () => this.onGet()));
        } catch (err) {
            console.error(err);
            // registration fails on a duplicate id; name the param so it doesn't
            // silently never appear
            this.registrationFailed = true;
            const detail = err instanceof Error ? err.message : String(err);
            window.showErrorMessage(
                `Could not register parameter '${this.id}'. A parameter with this name may already exist — names must be unique. (${detail})`,
            );
            // bail before resolving values: this param will be dropped, and a
            // command-backed one must not run its shell command even once
            return;
        }
        // resolve values only after the retrieval command is registered
        this.update();
        this.statusBarItem.show();
    }

    /**
     * Re-resolve the selectable values and reconcile the stored selection against
     * them (dropping stale entries, applying `initialSelection`/first-value
     * defaults), then refresh the status-bar text. Concurrency-safe: a newer
     * update() supersedes one whose value resolution is still in flight.
     */
    async update() {
        const generation = ++this.updateGeneration;
        // loadSelectedValues() is synchronous; only getValues() needs awaiting
        let storedSelections = this.loadSelectedValues();
        const values = await this.getValues();
        // a newer update() began while getValues() was in flight: let it win
        if (generation !== this.updateGeneration) {
            return;
        }
        // undefined: values can't be determined now (untrusted workspace, or a
        // failing command) — keep the stored selection, restored once available
        // again. An empty array, by contrast, clears the selection.
        if (values === undefined) {
            this.setText(storedSelections ?? []);
            this.jsonFile.changeEmitter.fire(this);
            return;
        }
        // fall back to initialSelection when nothing was selected before
        if (!storedSelections) {
            const initial = this.opts.initialSelection;
            const asArray = initial === undefined ? [] : Array.isArray(initial) ? initial : [initial];
            // a single-select param must not seed multiple values (onGet would join
            // them into a multi-token substitution); keep only the first
            storedSelections = this.opts.canPickMany ? asArray : asArray.slice(0, 1);
        }
        // Map stored selections (raw values) to the currently selectable values,
        // dropping any that are no longer present.
        let availableSelections: DisplayableValue[] = [];
        storedSelections.forEach((storedSelection) => {
            const match = values.find((value) => value.value === storedSelection);
            if (match) {
                availableSelections.push(match);
            }
        });

        // Set default value if selection is empty and multiple selection is not used. For multiple selection, leave empty.
        if (availableSelections.length === 0 && !this.opts.canPickMany && values.length > 0) {
            availableSelections = [values[0]];
        }

        this.storeSelectedValues(availableSelections);
    }

    /** Persist the given selection (raw values) and update the status-bar text. */
    storeSelectedValues(values: DisplayableValue[]) {
        // persist the raw values, but display the (optional) display names
        this.config.workspaceState.update(
            this.command,
            values.map((value) => value.value),
        );
        this.setText(values.map((value) => value.displayValue));
        this.jsonFile.changeEmitter.fire(this);
    }

    /**
     * Render the status-bar item for the given display values, honoring the
     * showName/showSelection settings and greying out an empty/blank selection.
     */
    setText(selection: string[]) {
        const showName = this.opts.showName ?? this.config.showNames;
        const showSelection = this.opts.showSelection ?? this.config.showSelections;
        // "no selection" = an empty array or only blank values. A shell command can
        // emit a blank/whitespace line, which would otherwise render as a blank but
        // active-coloured item — visually indistinguishable from a real selection and
        // inconsistent with the grey shown when there is genuinely nothing selected.
        const selectionEmpty = selection.every((value) => value.trim() === '');
        // determine text
        let text = '';
        if (showName || (selectionEmpty && showSelection)) {
            text = this.id;
        }
        if (showSelection && !selectionEmpty) {
            if (showName) {
                text += ': ';
            }
            text += selection.join(' ');
        }
        // determine color
        if (selectionEmpty) {
            this.statusBarItem.color = Param.COLOR_INACTIVE;
        } else {
            // undefined resets the color to the default (vs '' which relies on unspecified behavior)
            this.statusBarItem.color = undefined;
        }
        this.statusBarItem.text = text;
    }

    // remove this param's persisted selection (its values outlive a plain delete otherwise)
    deleteStoredSelection(): Thenable<void> {
        return this.config.workspaceState.update(this.command, undefined);
    }

    /** Resolve the `${command:…get.<id>}` substitution: the selected value(s), space-joined. */
    onGet() {
        const selection = this.loadSelectedValues() ?? [];
        return selection.join(' ');
    }

    loadSelectedValues() {
        let values = this.config.workspaceState.get<string[]>(this.command);
        // to remain compatible for stored values of version 1.3.1 and before
        if (!values) {
            const oldKey = `${Strings.COMMAND_SELECT}.${this.id}`;
            const oldValues = this.config.workspaceState.get<string>(oldKey);
            if (oldValues) {
                values = [oldValues];
                // write the new key before removing the old (order matters if the
                // second write never lands), so onGet() can't drop the value mid-migrate
                this.config.workspaceState.update(this.command, values);
                this.config.workspaceState.update(oldKey, undefined);
            }
        }
        return values;
    }

    // open the json file at this param's definition (for edit and auto-open on create)
    async reveal() {
        // the user tasks.json has no directly-openable uri; let the workbench open it
        if (this.jsonFile.useDocumentIO) {
            await commands.executeCommand('workbench.action.tasks.openUserTasks');
            return;
        }
        const textDocument = await workspace.openTextDocument(this.jsonFile.uri);
        const position = textDocument.positionAt(this.jsonOffset);
        const selection = new Range(position, position);
        await window.showTextDocument(textDocument, { selection });
    }

    dispose() {
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    getValues(force = false): Promise<DisplayableValue[] | undefined> {
        return this.valuesDelegate.getValues(force);
    }

    getIcon(): ThemeIcon {
        return this.valuesDelegate.getIcon();
    }
}
