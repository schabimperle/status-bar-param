import { QuickPickItem, window } from 'vscode';
import { ArrayOptions, ArrayValue, CommandOptions, MapValueObject, Options, StringValueObject } from './schemas';
import { ArrayValuesDelegate, CommandValuesDelegate } from './valuesDelegate';
import { interpretEscapes } from './escapes';
import { Strings } from './strings';
import type { JsonFile } from './jsonFile';

/**
 * Interactive prompts for creating a parameter. The flow describes the parameter
 * first (target file, type, id, then — for an array — the value shape), then forks
 * on how to fill it in (guided prompts vs. a seeded example), then gathers the
 * content; everything optional (multi-select, initial selection, status-bar display,
 * cwd/separator, and adding a sample task) is offered via a single multi-select whose
 * items are phrased so an unchecked box always means "keep the default" — selecting
 * none keeps the minimal defaults. The shape of an array's values (plain, labelled,
 * or named outputs) is its own dedicated step, offered after the id so it reads as a
 * refinement of "Array" and the user always knows what they are typing — it can't be
 * a checkbox answered after the values are already entered.
 * Anything not surfaced here stays discoverable through JSON IntelliSense (a tip
 * comment is written next to the new parameter). Each prompt returns the gathered
 * data, or undefined when the user aborts (Escape).
 */

// Characters allowed in a parameter id and in a named-output key: both are
// embedded verbatim into a `${input:<id>}` / `${command:…get.<id>.<key>}`
// reference, so a `}`, newline, tab, etc. would produce an entry the user can't
// write. Kept in sync with array_options_schema.json's `propertyNames` pattern.
const ID_KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;

// names that would clash with JS object internals when a named-output key is used
// to index a plain map (e.g. `secondaryValues['__proto__']`), so they're rejected
// here and in the schema's `propertyNames` rather than relying on runtime guards alone.
// Only relevant for output keys (which index a map), not for ids (which don't).
const RESERVED_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

// Validate the shared character set of a parameter id / named-output key. Returns an
// error message for an invalid value, or undefined when it's acceptable (an empty
// value is "no input yet" — callers decide what empty means). Kept in sync with
// array_options_schema.json's `propertyNames`.
function validateNameChars(value: string): string | undefined {
    if (value && !ID_KEY_PATTERN.test(value)) {
        return 'Only letters, digits, and _ . - are allowed.';
    }
    return undefined;
}

// Validate a named-output key: the character set plus the reserved map-key names. An
// id needs only validateNameChars (it isn't used to index a plain object), so the
// reserved-name rule would reject harmless ids like `constructor` for no reason.
function validateOutputKey(value: string): string | undefined {
    return validateNameChars(value) ?? (value && RESERVED_NAMES.has(value) ? `'${value}' is reserved and cannot be used.` : undefined);
}

export type ParamType = 'array' | 'command';

const arrayLabel = `\$(${ArrayValuesDelegate.ICON.id}) Array`;
const commandLabel = `\$(${CommandValuesDelegate.ICON.id}) Command`;

/**
 * Context the advanced-options step needs to phrase its toggles. The status-bar
 * visibility toggles are phrased as the *opposite* of the current global default,
 * so an unchecked box reflects the default and a checked box sets the override.
 */
export interface WizardContext {
    showNamesDefault: boolean;
    showSelectionsDefault: boolean;
    /** false for launch.json, which gets no sample task. */
    offerSampleTask: boolean;
}

/** Everything the add-param flow gathers: the input's `args` plus the sample-task choice. */
export interface ParamArgs {
    args: ArrayValue[] | ArrayOptions | CommandOptions;
    addSampleTask: boolean;
}

/** Pick the json file the parameter should be saved to. */
export async function promptJsonFile(jsonFiles: JsonFile[]): Promise<JsonFile | undefined> {
    const items = jsonFiles
        .map((jsonFile) => {
            return {
                label: jsonFile.getFileName(),
                description: jsonFile.getDescription(),
                jsonFile,
            };
        })
        // local config files first, then the .code-workspace, then the user tasks.json
        // last; a stable sort keeps files within a tier in their original order
        .sort((a, b) => a.jsonFile.displayRank - b.jsonFile.displayRank);
    let placeHolder = 'Select the file where the parameter should be saved.';
    if (jsonFiles.length <= 1) {
        placeHolder += ' Open a workspace or folder to extend this list.';
    }
    const res = await window.showQuickPick(items, { placeHolder });
    return res?.jsonFile;
}

/** Pick the parameter type (array of values vs. shell command). */
export async function promptParamType(): Promise<ParamType | undefined> {
    const items: (QuickPickItem & { type: ParamType })[] = [
        {
            type: 'array',
            label: arrayLabel,
            description: 'A list of parameter values to select from.',
        },
        {
            type: 'command',
            label: commandLabel,
            description: 'A shell command that outputs parameter values to select from.',
        },
    ];
    const paramType = await window.showQuickPick(items, {
        placeHolder: 'Select the type of the parameter.',
        ignoreFocusOut: true,
    });
    return paramType?.type;
}

/**
 * Enter the parameter name/id (no spaces, unique). Empty/Escape returns undefined.
 * `existingIds` are rejected because ids share a single global command namespace;
 * `existingCommandIds` additionally rejects a (dotted) id whose retrieval command
 * would collide with another parameter's named-output command (e.g. id `foo.cc` vs
 * id `foo` + key `cc`), which would otherwise only fail at registration time.
 */
export async function promptParamId(existingIds: string[], existingCommandIds: Set<string> = new Set()): Promise<string | undefined> {
    const taken = new Set(existingIds);
    const id = await window.showInputBox({
        prompt: 'Enter the name of the parameter.',
        ignoreFocusOut: true,
        validateInput: (value: string) => {
            const base = validateNameChars(value);
            if (base) {
                return base;
            }
            if (taken.has(value)) {
                return `A parameter named '${value}' already exists.`;
            }
            if (value && existingCommandIds.has(Strings.getCommandId(value))) {
                return `'${value}' clashes with a named output of another parameter.`;
            }
            return undefined;
        },
    });
    return id || undefined;
}

/**
 * Gather the args for the chosen type: the core values/command, then an optional
 * pass over the advanced options (which also covers the sample-task choice).
 * Returns undefined if the user aborts. The args are kept minimal — a bare value
 * array when no options are set — so simple parameters produce simple JSON.
 */
export async function promptParamArgs(
    type: ParamType,
    ctx: WizardContext,
    shape?: ValueShape,
    id?: string,
    existingCommandIds: Set<string> = new Set(),
): Promise<ParamArgs | undefined> {
    // the value shape is gathered by the caller (after the id, before this content step);
    // only array params have one — command output is always plain strings. id and
    // existingCommandIds flow on so the named shape can preflight its output-key commands.
    return type === 'array' ? promptArrayArgs(ctx, shape ?? 'plain', id, existingCommandIds) : promptCommandArgs(ctx);
}

/** Collect plain string values until an empty entry. Escape aborts. */
async function promptArrayValues(): Promise<string[] | undefined> {
    const values: string[] = [];
    let i = 1;
    while (true) {
        const value = await window.showInputBox({
            prompt: `Enter the ${i++}. parameter value, leave empty when finished.`,
            ignoreFocusOut: true,
        });
        if (value === '') {
            break;
        } else if (value === undefined) {
            return undefined;
        }
        values.push(value);
    }
    return values;
}

/**
 * Array flow for the already-chosen value `shape`: values (in that shape) → optional
 * advanced options → minimal args shape. The shape was picked earlier (after the id,
 * before this step), so the user enters values already knowing whether they are typing
 * plain values, value+label pairs, or named outputs — never discovering after the
 * fact that what they typed meant something else.
 */
async function promptArrayArgs(
    ctx: WizardContext,
    shape: ValueShape,
    id?: string,
    existingCommandIds: Set<string> = new Set(),
): Promise<ParamArgs | undefined> {
    const values = shape === 'named' ? await promptNamedValues(id, existingCommandIds) : await promptShapedValues(shape);
    if (values === undefined) {
        return undefined;
    }
    // the sample task is offered for the named shape too: buildSampleTask references
    // each `…get.<id>.<key>` for a named value (rather than the keyless `${input:<id>}`,
    // which would resolve to an empty string for a map)
    const advanced = await promptAdvancedOptions('array', ctx);
    if (advanced === undefined) {
        return undefined;
    }
    const opts = await collectOptions(advanced, ctx, () => promptInitialSelectionFromValues(values, advanced.includes('canPickMany')));
    if (opts === undefined) {
        return undefined;
    }
    // keep the JSON minimal: a bare array unless an option was actually set
    const args = Object.keys(opts).length === 0 ? values : { values, ...opts };
    return { args, addSampleTask: advanced.includes('sampleTask') };
}

/** How an array's values are entered. A param's values are wholly one shape. */
export type ValueShape = 'plain' | 'labelled' | 'named';

/**
 * Pick how an array's values are defined. Called after the id (and before the
 * creation-mode fork), so it reads as a refinement of "Array" and is decided before any
 * value is entered. "Named outputs" is surfaced here (not as a post-hoc advanced toggle)
 * precisely because it changes what the user types: a named value has no single
 * string, so the typed entry is a label plus one value per output key. A param is
 * wholly one shape — plain and named entries can't be mixed, since a keyless
 * `${command:…get.<id>}` substitution has no meaning for a named entry (see the
 * schema's valueArray).
 */
export async function promptValueShape(): Promise<ValueShape | undefined> {
    const items: (QuickPickItem & { shape: ValueShape })[] = [
        { shape: 'plain', label: 'Plain values', description: 'A list of values; the value itself is shown in the status bar.' },
        { shape: 'labelled', label: 'Values with display labels', description: 'Show a custom label per value instead of the raw value.' },
        {
            shape: 'named',
            label: 'Named outputs',
            description: 'Each selection sets several variables (e.g. a compiler pick feeding CC and CXX), read via ${command:…get.<id>.<key>}.',
        },
    ];
    const picked = await window.showQuickPick(items, {
        placeHolder: 'Choose how to define the parameter values.',
        ignoreFocusOut: true,
    });
    return picked?.shape;
}

/** Collect plain values, then (for the labelled shape) a display label per value. */
async function promptShapedValues(shape: 'plain' | 'labelled'): Promise<(string | StringValueObject)[] | undefined> {
    const rawValues = await promptArrayValues();
    if (rawValues === undefined) {
        return undefined;
    }
    if (shape === 'plain') {
        return rawValues;
    }
    return promptDisplayLabels(rawValues);
}

/** Command flow: shell command → optional advanced options (incl. cwd/separator). */
async function promptCommandArgs(ctx: WizardContext): Promise<ParamArgs | undefined> {
    const shellCmd = await window.showInputBox({
        prompt: `Enter a shell command that outputs parameter values to select from.`,
        ignoreFocusOut: true,
    });
    if (!shellCmd) {
        return undefined;
    }
    const advanced = await promptAdvancedOptions('command', ctx);
    if (advanced === undefined) {
        return undefined;
    }
    const opts = await collectOptions(advanced, ctx, () => promptCommandInitialSelection(advanced.includes('canPickMany')));
    if (opts === undefined) {
        return undefined;
    }
    const result: CommandOptions = { shellCmd, ...opts };
    if (advanced.includes('cwd')) {
        const cwd = await promptOptionalInput('Enter the working directory to run the command from.');
        if (cwd === undefined) {
            return undefined;
        }
        if (cwd !== '') {
            result.cwd = cwd;
        }
    }
    if (advanced.includes('separator')) {
        const separator = await promptOptionalInput('Enter the separator that splits the command output into values (use \\n for newline, \\t for tab).');
        if (separator === undefined) {
            return undefined;
        }
        if (separator !== '') {
            // interpret escape sequences so a typed "\n"/"\t" becomes a real newline
            // /tab — the literal backslash-n string would never match the output
            result.separator = interpretEscapes(separator);
        }
    }
    return { args: result, addSampleTask: advanced.includes('sampleTask') };
}

/** The advanced option keys, each phrased in the menu as the action it performs. */
type AdvancedKey = 'canPickMany' | 'initialSelection' | 'showName' | 'showSelection' | 'cwd' | 'separator' | 'sampleTask';

/**
 * One optional multi-select of advanced options applicable to the type. Returns the
 * picked keys (possibly empty → use defaults), or undefined when the user escapes.
 * The menu is the gate: there is no preceding yes/no question. The status-bar
 * visibility items are phrased as the opposite of the current global default, so an
 * unchecked box always means "keep the default".
 */
async function promptAdvancedOptions(type: ParamType, ctx: WizardContext): Promise<AdvancedKey[] | undefined> {
    const items: (QuickPickItem & { key: AdvancedKey })[] = [];
    items.push(
        { key: 'canPickMany', label: 'Allow selecting multiple values', description: 'Add checkboxes to select more than one value.' },
        { key: 'initialSelection', label: 'Set an initial selection', description: 'Preselect a value the first time the parameter loads.' },
        {
            key: 'showName',
            label: ctx.showNamesDefault ? 'Hide the parameter name in the status bar' : 'Show the parameter name in the status bar',
            description: 'Whether the name is shown in front of the selected value.',
        },
        {
            key: 'showSelection',
            label: ctx.showSelectionsDefault ? 'Hide the selected value in the status bar' : 'Show the selected value in the status bar',
            description: 'Whether the selected value is shown in the status bar.',
        },
    );
    // a join separator is *not* offered here: it only affects how several selected
    // values are combined, so it would be meaningless on a single-select param.
    // collectOptions prompts for it as a follow-up to enabling "select multiple values".
    if (type === 'command') {
        items.push(
            { key: 'cwd', label: 'Set the working directory', description: 'The directory to run the command from.' },
            { key: 'separator', label: 'Set a custom separator', description: 'The string that splits the command output into values.' },
        );
    }
    if (ctx.offerSampleTask) {
        items.push({ key: 'sampleTask', label: 'Add a sample task', description: 'Scaffold a runnable task that demonstrates using the parameter.' });
    }
    const picked = await window.showQuickPick(items, {
        placeHolder: 'Configure advanced options, or select none to use the defaults.',
        canPickMany: true,
        ignoreFocusOut: true,
    });
    return picked?.map((item) => item.key);
}

/**
 * Apply the picked boolean toggles and (if picked) the initial selection. The
 * status-bar toggles set the value opposite the global default (so a checked box is
 * always a real override). Returns the gathered Options, or undefined if a
 * sub-prompt was aborted.
 */
async function collectOptions(
    advanced: AdvancedKey[],
    ctx: WizardContext,
    promptInitial: () => Promise<string | string[] | undefined>,
): Promise<Options | undefined> {
    const opts: Options = {};
    if (advanced.includes('canPickMany')) {
        opts.canPickMany = true;
        // the join separator only applies when several values can be selected, so it's
        // asked here as a follow-up to enabling multi-select rather than as a standalone
        // advanced toggle (which could be picked for a single-select param, where it has
        // no effect). Empty keeps the default (a space).
        const joinSeparator = await promptOptionalInput(
            'Enter the separator used to join the selected values (use \\n for newline, \\t for tab). Press Enter to keep the default (a space).',
        );
        if (joinSeparator === undefined) {
            return undefined; // aborted
        }
        // interpret escapes at wizard time and store the real character, so the written
        // JSON matches what the user typed (a typed `\t` becomes a tab, not the literal
        // `\\t`) — the same handling as the command `separator` above. onGet still
        // interprets escapes too, which covers a hand-edited `"\\t"` and is a no-op on
        // an already-real character.
        if (joinSeparator !== '') {
            opts.joinSeparator = interpretEscapes(joinSeparator);
        }
    }
    if (advanced.includes('showName')) {
        opts.showName = !ctx.showNamesDefault;
    }
    if (advanced.includes('showSelection')) {
        opts.showSelection = !ctx.showSelectionsDefault;
    }
    if (advanced.includes('initialSelection')) {
        const initial = await promptInitial();
        if (initial === undefined) {
            return undefined; // aborted
        }
        // an empty pick/entry means "no initial selection" — only set when present
        if (initial !== '' && !(Array.isArray(initial) && initial.length === 0)) {
            opts.initialSelection = initial;
        }
    }
    return opts;
}

/** Prompt a display label for each value; an empty label keeps the plain string. */
async function promptDisplayLabels(rawValues: string[]): Promise<(string | StringValueObject)[] | undefined> {
    const labelled: (string | StringValueObject)[] = [];
    for (const value of rawValues) {
        const displayValue = await window.showInputBox({
            prompt: `Enter a display label for '${value}', or leave empty to show the value itself.`,
            ignoreFocusOut: true,
        });
        if (displayValue === undefined) {
            return undefined; // aborted
        }
        labelled.push(displayValue === '' ? value : { value, displayValue });
    }
    return labelled;
}

/**
 * Named-outputs flow: define the output keys once (the columns, e.g. CC/CXX), then a
 * row per selectable value — a display label plus a value for each key. Produces
 * {@link MapValueObject} entries. Returns undefined on Escape; an empty result (no
 * keys, or no rows) means the user backed out without defining anything.
 */
async function promptNamedValues(id?: string, existingCommandIds: Set<string> = new Set()): Promise<MapValueObject[] | undefined> {
    const keys = await promptOutputKeys(id, existingCommandIds);
    if (keys === undefined) {
        return undefined;
    }
    const values: MapValueObject[] = [];
    // a named value has no scalar value, so its label doubles as the handle used to
    // preselect it (`initialSelection`); reject duplicates so that handle is unambiguous
    const usedLabels = new Set<string>();
    let i = 1;
    while (true) {
        const displayValue = await window.showInputBox({
            prompt: `Enter a label for the ${i++}. value (shown in the status bar), leave empty when finished.`,
            ignoreFocusOut: true,
            validateInput: (value: string) => (value && usedLabels.has(value) ? `A value labelled '${value}' already exists.` : undefined),
        });
        if (displayValue === undefined) {
            return undefined; // aborted
        }
        if (displayValue === '') {
            break;
        }
        usedLabels.add(displayValue);
        const map: { [key: string]: string } = {};
        for (const key of keys) {
            const output = await window.showInputBox({
                prompt: `Enter the '${key}' output for '${displayValue}'.`,
                ignoreFocusOut: true,
            });
            if (output === undefined) {
                return undefined; // aborted
            }
            map[key] = output;
        }
        values.push({ displayValue, value: map });
    }
    // keys were defined but no value rows entered: the result would register no
    // named commands, so treat it as a back-out (like an empty key set) rather than
    // writing a parameter with no usable outputs
    if (values.length === 0) {
        return undefined;
    }
    return values;
}

/**
 * Collect the named-output key names (the same set across every value). At least one
 * key is required — with none there are no outputs to set — so an immediate empty
 * entry aborts the named flow. Duplicates are ignored so the keys stay unique.
 */
async function promptOutputKeys(id?: string, existingCommandIds: Set<string> = new Set()): Promise<string[] | undefined> {
    const keys: string[] = [];
    while (true) {
        const key = await window.showInputBox({
            prompt: `Enter the name of output ${keys.length + 1} (e.g. CC), leave empty when finished.`,
            ignoreFocusOut: true,
            // a key becomes part of a `${command:…get.<id>.<key>}` reference and is
            // used to index the value map, so it shares the id's rules (an empty value
            // finishes). Also preflight its command id against the existing namespace,
            // so an output whose `…get.<id>.<key>` collides with another parameter's
            // command (e.g. an existing id `foo.cc`) is caught here, not at registration.
            validateInput: (value: string) => {
                const base = validateOutputKey(value);
                if (base || !value || id === undefined) {
                    return base;
                }
                return existingCommandIds.has(`${Strings.getCommandId(id)}.${value}`)
                    ? `Output '${value}' clashes with the command of another parameter.`
                    : undefined;
            },
        });
        if (key === undefined) {
            return undefined; // aborted
        }
        if (key === '') {
            // need at least one key for a named value; an empty first entry is a back-out
            if (keys.length === 0) {
                return undefined;
            }
            break;
        }
        if (!keys.includes(key)) {
            keys.push(key);
        }
    }
    return keys;
}

/** Pick the initial selection from the known array values (multi when canPickMany). */
async function promptInitialSelectionFromValues(values: ArrayValue[], canPickMany: boolean): Promise<string | string[] | undefined> {
    const items = values.map((value) => {
        if (typeof value === 'string') {
            return { label: value, value };
        }
        // a named (map) value has no scalar value, so it's preselected by its display
        // label (unique among the values) rather than its opaque canonical-JSON
        // identity — keeping the written initialSelection readable. Param.update()
        // matches a named value by label as well as by identity.
        if (typeof value.value === 'object') {
            const map = value as MapValueObject;
            return { label: map.displayValue, value: map.displayValue };
        }
        const str = value as StringValueObject;
        return { label: str.displayValue ?? str.value, value: str.value };
    });
    const res = await window.showQuickPick(items, {
        placeHolder: 'Select the value(s) to preselect on first load.',
        canPickMany,
        ignoreFocusOut: true,
    });
    if (res === undefined) {
        return undefined;
    }
    return Array.isArray(res) ? res.map((item) => item.value) : res.value;
}

/**
 * Initial selection for a command param, whose values are only known at runtime so
 * a free-text entry is used. With canPickMany, collect several values (one per
 * entry) so multiple initial selections can be set; otherwise a single value.
 * Empty/empty-first means "no initial selection"; Escape aborts (undefined).
 */
async function promptCommandInitialSelection(canPickMany: boolean): Promise<string | string[] | undefined> {
    if (!canPickMany) {
        return promptOptionalInput('Enter the value to preselect on first load.');
    }
    const values: string[] = [];
    while (true) {
        const value = await window.showInputBox({
            prompt: `Enter initial value ${values.length + 1} to preselect, leave empty when finished.`,
            ignoreFocusOut: true,
        });
        if (value === undefined) {
            return undefined; // aborted
        }
        if (value === '') {
            break;
        }
        values.push(value);
    }
    return values;
}

/** A free-text input where empty means "skip" (not abort); Escape aborts (undefined). */
async function promptOptionalInput(prompt: string): Promise<string | undefined> {
    return window.showInputBox({ prompt, ignoreFocusOut: true });
}

/** How the values/options are provided: prompted step-by-step, or seeded from an example. */
export type CreationMode = 'guided' | 'example';

/**
 * Once the parameter is described (type, id, and — for an array — shape), fork the flow:
 * be led through the value/option prompts, or drop a complete, working example into the
 * file to edit in JSON. The example path reuses the id + shape already gathered — it only
 * replaces the value/advanced prompts — so the inserted example carries the user's own id
 * and is the chosen shape. Returns the picked mode, or undefined when the user escapes.
 */
export async function promptCreationMode(): Promise<CreationMode | undefined> {
    const items: (QuickPickItem & { mode: CreationMode })[] = [
        { mode: 'guided', label: 'Guide me through it', description: 'Answer prompts for the values and options.' },
        {
            mode: 'example',
            label: 'Insert an example to edit',
            description: 'Drop a complete, working parameter into the file to tweak directly in JSON.',
        },
    ];
    const picked = await window.showQuickPick(items, {
        placeHolder: 'How do you want to define this parameter?',
        ignoreFocusOut: true,
    });
    return picked?.mode;
}

/**
 * Example mode's single yes/no for the sample task. The guided flow offers this inside
 * its advanced multi-select (opt-in, default off); the example path skips that step, so
 * ask once here — defaulting to yes, since a runnable task that uses the parameter is
 * part of a complete, working demo. Only non-launch files reach this (launch.json gets
 * no task). Returns the choice, or undefined when the user escapes.
 */
export async function promptExampleSampleTask(): Promise<boolean | undefined> {
    const items: (QuickPickItem & { add: boolean })[] = [
        { add: true, label: 'Yes', description: 'Also add a runnable task that uses the parameter.' },
        { add: false, label: 'No', description: 'Insert only the parameter.' },
    ];
    const picked = await window.showQuickPick(items, {
        placeHolder: 'Also add a sample task that uses the parameter?',
        ignoreFocusOut: true,
    });
    return picked?.add;
}

/**
 * A fully-populated, schema-valid `args` for the chosen type/shape, used by the
 * example path. A command example ignores `shape` (command output is always plain
 * strings); the named example is the headline case, since its value×key matrix is the
 * shape the guided flow handles least comfortably.
 */
export function buildExampleArgs(type: ParamType, shape: ValueShape = 'plain'): ArrayValue[] | ArrayOptions | CommandOptions {
    if (type === 'command') {
        // list the filesystem root, one value per line — an always-populated command
        // to edit to taste, picked per-OS so it runs on the host the extension lives
        // on (`exec` uses cmd.exe on Windows, /bin/sh elsewhere)
        return { shellCmd: process.platform === 'win32' ? 'dir /b C:\\' : 'ls /' };
    }
    switch (shape) {
        case 'plain':
            // the object form (not a bare array) so the seeded example is a launchpad:
            // typing inside the braces, alongside `values`, surfaces IntelliSense for the
            // options (canPickMany, initialSelection, …) a bare `[…]` gives no hint of —
            // and it matches the labelled/named examples below. (The guided flow still
            // emits a minimal bare array; this richer shape is only for editing.)
            return { values: ['debug', 'release'] };
        case 'labelled':
            // One pick → a bundle of compiler flags substituted together as a single
            // ${input:<id>} (e.g. `g++ ${input:<id>} main.cpp` in a shell task, where the
            // shell splits them into args). Unlike the named-outputs example below, whose
            // parts are read one by one, the flags travel as one value — the label names
            // the otherwise-cryptic combination.
            return {
                values: [
                    { value: '-O0 -g', displayValue: 'Debug' },
                    { value: '-O2 -DNDEBUG', displayValue: 'Release' },
                    { value: '-O2 -g -pg', displayValue: 'Profiling' },
                ],
            };
        case 'named':
            return {
                values: [
                    { displayValue: 'GCC', value: { CC: 'gcc', CXX: 'g++' } },
                    { displayValue: 'Clang', value: { CC: 'clang', CXX: 'clang++' } },
                ],
            };
    }
}
