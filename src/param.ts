import { commands, Disposable, MarkdownString, Range, StatusBarAlignment, StatusBarItem, TextDocument, ThemeColor, ThemeIcon, window, workspace } from 'vscode';
import * as jsonc from 'jsonc-parser';
import { JSONPath } from 'jsonc-parser';
import { Strings } from './strings';
import { JsonFile } from './jsonFile';
import { ValuesDelegate } from './valuesDelegate';
import { DisplayableValue, Options } from './schemas';
import { ExtensionConfig } from './config';

// Escape user text for raw HTML rendered via MarkdownString.supportHtml, then flatten
// newlines (table cells can't contain one). `$(icon)` product-icon syntax is handled
// separately by renderTooltipValue \u2014 this only escapes literal text.
function escapeTooltipHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/[\r\n]+/g, ' ');
}

function iconSpan(icon: string): string {
    return `<span class="codicon codicon-${icon}"></span>`;
}

// Render a tooltip value: turn VS Code `$(icon)` product-icon syntax into codicon spans
// (the status bar and picker render these natively; supportThemeIcons is off on this HTML
// tooltip, so we reproduce them ourselves) and HTML-escape everything around them. The name
// charset mirrors VS Code's own ThemeIcon expression, so a value renders identically in the
// bar and in the hover; being restricted to [A-Za-z0-9-] it also keeps the emitted class free
// of user-controlled markup. See https://code.visualstudio.com/api/references/icons-in-labels.
function renderTooltipValue(text: string): string {
    const iconPattern = /\$\(([A-Za-z0-9-]+)(?:~([A-Za-z0-9-]+))?\)/g;
    let html = '';
    let last = 0;
    for (let match = iconPattern.exec(text); match !== null; match = iconPattern.exec(text)) {
        html += escapeTooltipHtml(text.slice(last, match.index));
        const modifier = match[2] ? ` codicon-modifier-${match[2]}` : '';
        html += `<span class="codicon codicon-${match[1]}${modifier}"></span>`;
        last = match.index + match[0].length;
    }
    return html + escapeTooltipHtml(text.slice(last));
}

function indentedIconSpan(icon: string): string {
    return `&nbsp;${iconSpan(icon)}&nbsp;&nbsp;`;
}

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
    // cap the value list in the hover tooltip so a command param with hundreds of
    // stdout lines doesn't render an unbounded panel; the rest collapse to a count
    private static readonly MAX_TOOLTIP_VALUES = 15;
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
    // the values last resolved by update()/a picker, kept only to render the hover
    // tooltip's value list — reading it never re-runs a command (undefined until the
    // first successful resolution; a transient unavailable result keeps the old list)
    private lastResolvedValues: DisplayableValue[] | undefined;
    // the current hover tooltip (status-bar item + tree node), rebuilt on every
    // setText. An empty placeholder until the first render (don't reference this.id
    // in the field initializer — it may run before the parameter property is set).
    private tooltip: MarkdownString = new MarkdownString('');

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
        // build a real, non-empty tooltip up front rather than leaving the empty
        // placeholder until the first async update() lands: VS Code's hover service
        // shows nothing for an empty MarkdownString and can cache that empty result,
        // so a hover in that window would silently produce no popup at all
        this.tooltip = this.buildTooltip([]);
        this.statusBarItem.tooltip = this.tooltip;
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
        // remember the resolved list for the tooltip. Guard on !== undefined, not
        // truthiness: an empty array is a valid result (clears the selection below),
        // whereas undefined means "unavailable" and should keep the previous list.
        if (values !== undefined) {
            // copy for the same reason rememberResolvedValues does: callers reorder the
            // resolved list in place, which must not disturb the tooltip's snapshot
            this.lastResolvedValues = [...values];
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
        // rebuild the hover tooltip from the same display selection (and the last
        // resolved value list); the tree node reads it via getTooltip()
        this.tooltip = this.buildTooltip(selection);
        this.statusBarItem.tooltip = this.tooltip;
    }

    /**
     * Build the hover tooltip as raw, sanitized HTML. Real HTML tables avoid the
     * mandatory Markdown table header row that created a large visual gap between the
     * parameter name and its values. The title and value list are separate tables so
     * the heading can keep the parameter type icon right-aligned without squeezing the
     * selectable values. User text is HTML-escaped before insertion. The value list is
     * drawn from lastResolvedValues, so hovering never re-runs a command.
     */
    private buildTooltip(selection: string[]): MarkdownString {
        const md = new MarkdownString();
        md.supportHtml = true;
        const rows: string[] = [];

        // blank/whitespace-only selection counts as none, matching the status bar.
        // Only what update()/the picker already resolved is used — never forces a run.
        const active = selection.filter((value) => value.trim() !== '');
        // markers and the truncation window key off the canonical stored value, not the
        // display label: two values can share a displayValue, so matching by label would
        // mark (and anchor the window on) the wrong — or several — rows. loadSelectedValues()
        // is the authoritative selection identity and never re-runs a command. A blank/
        // whitespace display value never counts as active, matching the status bar (which
        // greys such a selection out as "none") — otherwise the "(empty)" row would carry a
        // filled marker the status bar contradicts.
        const selectedRaw = this.loadSelectedValues() ?? [];
        const isSelected = (value: DisplayableValue) => value.displayValue.trim() !== '' && selectedRaw.includes(value.value);
        const values = this.lastResolvedValues;
        const multi = this.opts.canPickMany === true;
        // a multi-select carries its selection count in the heading, e.g. "id (3 selected)",
        // so the total stays visible even when the value list is truncated or the active
        // rows are scrolled off. Count against the resolved list when we have one; otherwise
        // fall back to the stored selection (a blank/whitespace value never counts, matching
        // the status bar). Single-select needs no badge — the one filled marker says it all.
        const activeCount = values && values.length > 0 ? values.filter(isSelected).length : selectedRaw.filter((value) => value.trim() !== '').length;
        const countBadge = multi ? ` (${activeCount} selected)` : '';
        if (values && values.length > 0) {
            const activeIndex = values.findIndex(isSelected);
            const start = activeIndex >= Param.MAX_TOOLTIP_VALUES ? Math.min(activeIndex, Math.max(0, values.length - Param.MAX_TOOLTIP_VALUES)) : 0;
            const shown = values.slice(start, start + Param.MAX_TOOLTIP_VALUES);
            if (start > 0) {
                rows.push(`<tr><td></td><td><em>…${start} more above</em></td></tr>`);
            }
            for (const value of shown) {
                const isActive = isSelected(value);
                // matched large glyphs so all markers read as the same size: a filled dot
                // (single-select radio) or a checked dot (multi-select) when active, an
                // outline dot when not. pass-filled matches the large circles' size, so the
                // checked marker stays consistent with them (codicons only come in
                // small/standard/large — there is no size between standard and large)
                const marker = isActive ? (multi ? 'pass-filled' : 'circle-large-filled') : 'circle-large-outline';
                // a shell command can emit a blank line; show an explicit placeholder
                // rather than an invisible, confusing empty row. The placeholder is a
                // fixed, safe literal, so only real user values are run through the escaper.
                const cell = value.displayValue.trim() === '' ? '(empty)' : renderTooltipValue(value.displayValue);
                rows.push(`<tr><td>${indentedIconSpan(marker)}</td><td>${cell}</td></tr>`);
            }
            const remaining = values.length - start - shown.length;
            if (remaining > 0) {
                const label = start === 0 ? `…and ${remaining} more` : `…${remaining} more below`;
                rows.push(`<tr><td></td><td><em>${label}</em></td></tr>`);
            }
        } else if (active.length > 0) {
            // no resolvable value list (command param untrusted / failing / not yet run):
            // still surface the current selection so the hover isn't empty
            rows.push(`<tr><td></td><td>Selected: ${renderTooltipValue(active.join(' '))}</td></tr>`);
        } else {
            rows.push('<tr><td></td><td><em>No selection</em></td></tr>');
        }
        // Minimal bottom padding inside VS Code's fixed hover margins.
        rows.push('<tr><td></td><td></td></tr>');
        md.appendMarkdown(
            `<table width="100%"><tbody><tr><td><h3>${escapeTooltipHtml(this.id)}${countBadge}</h3></td><td align="right"><h3>&nbsp;&nbsp;&nbsp;${iconSpan(this.getIcon().id)}</h3></td></tr></tbody></table><table><tbody>${rows.join('')}</tbody></table>`,
        );
        return md;
    }

    /** The current hover tooltip, for the tree node to mirror the status-bar item. */
    getTooltip(): MarkdownString {
        return this.tooltip;
    }

    /**
     * Remember a freshly resolved value list (e.g. from the picker, which forces a
     * re-run) so the tooltip's value list reflects it instead of lagging behind the
     * last silent update(). Takes a copy — callers reorder the array in place.
     */
    rememberResolvedValues(values: DisplayableValue[]) {
        this.lastResolvedValues = [...values];
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
        try {
            if (this.jsonFile.useDocumentIO) {
                // the user tasks.json has no directly-openable uri; have the workbench
                // open it and await the *real* document. Reading window.activeTextEditor
                // right after the command races the async open: the still-active
                // previous editor gets captured and re-shown below, leaving the user on
                // the wrong file (a brief flash of tasks.json before it loses focus).
                document = await this.jsonFile.openUserDataDocument();
            } else {
                document = await workspace.openTextDocument(this.jsonFile.uri);
            }
        } catch (err) {
            window.showErrorMessage(`Failed to open ${this.jsonFile.getFileName()}: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        if (!document) {
            return;
        }
        // resolve the offset from the document's *current* text (the file or an
        // unsaved buffer may have changed since this Param was parsed); if the input
        // can't be located, just show the document without moving the cursor.
        // showTextDocument here is the last open, so it focuses the tasks.json (the
        // earlier openUserTasks open can't leave another editor active).
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
