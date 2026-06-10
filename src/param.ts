import { commands, Disposable, Range, StatusBarAlignment, StatusBarItem, TextDocument, ThemeColor, ThemeIcon, window, workspace } from 'vscode';
import * as jsonc from 'jsonc-parser';
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
    // dedupe the "keyless access to a named-value map" warning so a repeatedly-run
    // task doesn't spam it (reset on the param rebuild that follows a config change)
    private keylessMapWarned = false;
    // the display strings of the current selection (what the status bar shows),
    // surfaced via getSelectionText for the tree/quick-pick without re-resolving
    private displayText: string[] = [];

    constructor(
        public readonly id: string,
        public readonly command: string,
        public readonly opts: Options,
        private readonly priority: number,
        // JSONPath of the inputs array this param lives in (['inputs'], or
        // ['launch','inputs'] in a .code-workspace); used to locate it for reveal/delete
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
        // register a retrieval command per named-output key, so one selection can feed
        // several `${command:…get.<id>.<key>}` substitutions. Like the primary command,
        // these rely on the old Param being disposed before the rebuild on each save
        // (JsonFile.disposeParams runs first); a clash only drops that one key.
        this.valuesDelegate.getSecondaryKeys().forEach((key) => {
            try {
                this.disposables.push(commands.registerCommand(`${this.command}.${key}`, () => this.onGetSecondary(key)));
            } catch (err) {
                console.error(err);
                // a named-output command id (`…get.<id>.<key>`) can collide with the
                // primary command of a param whose id literally contains that dotted
                // suffix (id `foo.cc` vs id `foo` + key `cc`). Unlike a primary clash
                // we keep the param — its other outputs work — but surface the lost key
                // so a `${command:…get.<id>.<key>}` reference that silently never
                // resolves doesn't look like a typo.
                const detail = err instanceof Error ? err.message : String(err);
                window.showErrorMessage(
                    `Could not register named output '${key}' for parameter '${this.id}': the command id '${this.command}.${key}' is already in use (does another parameter's id collide with it?). References to \${command:${this.command}.${key}} will not resolve. (${detail})`,
                );
            }
        });
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
        const seedingFromInitial = !storedSelections;
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
            const match = values.find(
                (value) =>
                    value.value === storedSelection ||
                    // a named (map) value has no scalar value, so its initialSelection is
                    // given as the display label (what the picker/status bar show); match
                    // that too — but only when seeding from initialSelection, never when
                    // reconciling a persisted selection (which always stores the canonical
                    // identity), so a label can't shadow another value's stored identity.
                    (seedingFromInitial && value.secondaryValues !== undefined && value.displayValue === storedSelection),
            );
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
        // remember the display strings for getSelectionText (tree/quick-pick labels)
        this.displayText = selection;
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

    // the current selection's display label(s), for tree/quick-pick descriptions —
    // unlike onGet it never warns or resolves a map, and stays synchronous
    getSelectionText(): string {
        return this.displayText.join(' ');
    }

    /**
     * Resolve the `${command:…get.<id>}` substitution: the selected value(s) joined
     * with `joinSeparator` (a space by default). The separator is used verbatim — like
     * the command `separator`, any backslash escapes are interpreted once when written
     * (by the wizard) or via JSON's own escaping, never re-interpreted here.
     * A map (named-output) entry has no single keyless value, so it warns and is
     * skipped — the user must reference one of its keys via `…get.<id>.<key>`.
     */
    onGet(): string | Promise<string> {
        const selection = this.loadSelectedValues() ?? [];
        const separator = this.opts.joinSeparator ?? ' ';
        // fast path: without named-output keys, no entry can be a map, so the stored
        // strings are the values verbatim (the common case, kept synchronous)
        if (this.valuesDelegate.getSecondaryKeys().length === 0) {
            return selection.join(separator);
        }
        return this.onGetResolved(selection, separator);
    }

    // resolve a selection that may contain map entries: skip each map entry (warning
    // once) and keep the plain values — including a deliberate empty string, unlike a
    // blanket filter, so a string entry's value is never silently dropped
    private async onGetResolved(selection: string[], separator: string): Promise<string> {
        const values = (await this.getValues()) ?? [];
        const parts: string[] = [];
        for (const selected of selection) {
            const match = values.find((value) => value.value === selected);
            if (match?.secondaryValues) {
                this.warnKeylessMapAccess();
                continue;
            }
            // a string entry, or an unknown stored id (kept as-is, as before)
            parts.push(match?.value ?? selected);
        }
        return parts.join(separator);
    }

    /**
     * Resolve the `${command:…get.<id>.<key>}` substitution: the selected value(s)'
     * named output for `key`, joined like onGet. A selection that doesn't define
     * `key` contributes nothing; one that defines it as an empty string keeps its
     * separator position (an explicit empty output is distinct from an absent one).
     */
    async onGetSecondary(key: string): Promise<string> {
        const selection = this.loadSelectedValues() ?? [];
        if (selection.length === 0) {
            return '';
        }
        const separator = this.opts.joinSeparator ?? ' ';
        // unforced: array values are static, so this never re-runs a shell command
        const values = (await this.getValues()) ?? [];
        const parts: string[] = [];
        for (const selected of selection) {
            const secondary = values.find((value) => value.value === selected)?.secondaryValues;
            // hasOwnProperty (not `key in secondary`) so a set-but-empty value is kept
            // while a missing key is dropped — without matching inherited names like
            // `toString`/`constructor`, which `in` would treat as present and push
            // their prototype function instead of dropping them
            if (secondary && Object.prototype.hasOwnProperty.call(secondary, key)) {
                parts.push(secondary[key]);
            }
        }
        return parts.join(separator);
    }

    // warn once that a named-value (map) selection was read without a key
    private warnKeylessMapAccess() {
        if (this.keylessMapWarned) {
            return;
        }
        this.keylessMapWarned = true;
        const keys = this.valuesDelegate.getSecondaryKeys().join(', ');
        window.showWarningMessage(`Parameter '${this.id}' has named values — reference one with ` + `\${command:${this.command}.<key>} (keys: ${keys}).`);
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
        let document: TextDocument | undefined;
        if (this.jsonFile.useDocumentIO) {
            // the user tasks.json has no directly-openable uri; the workbench opens
            // it, then we position within the editor it activated
            await commands.executeCommand('workbench.action.tasks.openUserTasks');
            document = window.activeTextEditor?.document;
        } else {
            document = await workspace.openTextDocument(this.jsonFile.uri);
        }
        if (!document) {
            return;
        }
        // resolve the offset from the document's *current* text (the file or an
        // unsaved buffer may have changed since this Param was parsed); if the input
        // can't be located, just show the document without moving the cursor
        const offset = this.findInputOffset(document.getText());
        if (offset === undefined) {
            await window.showTextDocument(document);
            return;
        }
        const position = document.positionAt(offset);
        await window.showTextDocument(document, { selection: new Range(position, position) });
    }

    // locate this param's input object in the given json text by its (globally
    // unique) id, returning the byte offset of its opening brace, or undefined if
    // not found. Matching by id — not a cached array index — survives reordering.
    private findInputOffset(text: string): number | undefined {
        const root = jsonc.parseTree(text);
        const inputs = root && jsonc.findNodeAtLocation(root, this.inputsPath);
        const match = inputs?.children?.find((node) => jsonc.findNodeAtLocation(node, ['id'])?.value === this.id);
        return match?.offset;
    }

    dispose() {
        this.disposables.forEach((disposable) => disposable.dispose());
    }

    /** Resolve the selectable values via the delegate. `force` re-runs a command param. */
    getValues(force = false): Promise<DisplayableValue[] | undefined> {
        return this.valuesDelegate.getValues(force);
    }

    /** The tree-view icon for this param's type (array vs. command). */
    getIcon(): ThemeIcon {
        return this.valuesDelegate.getIcon();
    }
}
