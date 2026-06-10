import { QuickPickItem, window } from 'vscode';
import { ArrayOptions, ArrayValue, CommandOptions, MapValueObject, Options, StringValueObject } from './schemas';
import { ArrayValuesDelegate, canonicalKey, CommandValuesDelegate } from './valuesDelegate';
import { interpretEscapes } from './escapes';
import type { JsonFile } from './jsonFile';

/**
 * Interactive prompts for creating a parameter. The core flow (target file, type,
 * id, values/command) is short; everything optional (multi-select, initial
 * selection, status-bar display, cwd/separator, and adding a sample task) is offered
 * via a single multi-select whose items are phrased so an unchecked box always means
 * "keep the default" — selecting none keeps the minimal defaults. The shape of an
 * array's values (plain, labelled, or named outputs) is its own dedicated step,
 * offered right after the type pick (before the id) so it reads as a refinement of
 * "Array" and the user always knows what they are typing — it can't be a checkbox
 * answered after the values are already entered.
 * Anything not surfaced here stays discoverable through JSON IntelliSense (a tip
 * comment is written next to the new parameter). Each prompt returns the gathered
 * data, or undefined when the user aborts (Escape).
 */

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
    const items = jsonFiles.map((jsonFile) => {
        return {
            label: jsonFile.getFileName(),
            description: jsonFile.getDescription(),
            jsonFile,
        };
    });
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
 * `existingIds` are rejected because ids share a single global command namespace.
 */
export async function promptParamId(existingIds: string[]): Promise<string | undefined> {
    const taken = new Set(existingIds);
    // the id is embedded verbatim into `${input:<id>}` / `${command:…get.<id>}`,
    // so restrict it to characters that can't break that syntax (a `}`, newline,
    // tab, etc. would produce unusable task/launch entries)
    const allowed = /^[A-Za-z0-9_.-]+$/;
    const id = await window.showInputBox({
        prompt: 'Enter the name of the parameter.',
        ignoreFocusOut: true,
        validateInput: (value: string) => {
            if (value && !allowed.test(value)) {
                return 'Only letters, digits, and _ . - are allowed.';
            }
            if (taken.has(value)) {
                return `A parameter named '${value}' already exists.`;
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
export async function promptParamArgs(type: ParamType, ctx: WizardContext, shape?: ValueShape): Promise<ParamArgs | undefined> {
    // the value shape is gathered by the caller (right after the type pick, before the
    // id); only array params have one — command output is always plain strings
    return type === 'array' ? promptArrayArgs(ctx, shape ?? 'plain') : promptCommandArgs(ctx);
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
 * advanced options → minimal args shape. The shape was picked right after the type
 * (before the id), so the user enters values already knowing whether they are typing
 * plain values, value+label pairs, or named outputs — never discovering after the
 * fact that what they typed meant something else.
 */
async function promptArrayArgs(ctx: WizardContext, shape: ValueShape): Promise<ParamArgs | undefined> {
    const values = shape === 'named' ? await promptNamedValues() : await promptShapedValues(shape);
    if (values === undefined) {
        return undefined;
    }
    // the sample task echoes the keyless `${input:<id>}`, which has no value for a
    // named (map) selection — so don't offer it for the named shape (it would
    // scaffold a demo task that resolves to an empty string with a warning)
    const advancedCtx = shape === 'named' ? { ...ctx, offerSampleTask: false } : ctx;
    const advanced = await promptAdvancedOptions('array', advancedCtx);
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
 * Pick how an array's values are defined. Called right after the type pick and before
 * the id, so it reads as a refinement of "Array" and is decided before any value is
 * entered. "Named outputs" is surfaced here (not as a post-hoc advanced toggle)
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
type AdvancedKey = 'canPickMany' | 'initialSelection' | 'showName' | 'showSelection' | 'joinSeparator' | 'cwd' | 'separator' | 'sampleTask';

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
        {
            key: 'joinSeparator',
            label: 'Set a custom value separator',
            description: 'The string used to join multiple selected values when substituted into a task (defaults to a space).',
        },
    );
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
    if (advanced.includes('joinSeparator')) {
        const joinSeparator = await promptOptionalInput(
            'Enter the separator used to join multiple selected values (use \\n for newline, \\t for tab). Defaults to a space.',
        );
        if (joinSeparator === undefined) {
            return undefined; // aborted
        }
        // store the literal the user typed (escapes are interpreted in onGet, so a
        // hand-edited "\n" behaves the same); empty keeps the default space.
        if (joinSeparator !== '') {
            opts.joinSeparator = joinSeparator;
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
async function promptNamedValues(): Promise<MapValueObject[] | undefined> {
    const keys = await promptOutputKeys();
    if (keys === undefined) {
        return undefined;
    }
    const values: MapValueObject[] = [];
    let i = 1;
    while (true) {
        const displayValue = await window.showInputBox({
            prompt: `Enter a label for the ${i++}. value (shown in the status bar), leave empty when finished.`,
            ignoreFocusOut: true,
        });
        if (displayValue === undefined) {
            return undefined; // aborted
        }
        if (displayValue === '') {
            break;
        }
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
async function promptOutputKeys(): Promise<string[] | undefined> {
    const keys: string[] = [];
    while (true) {
        const key = await window.showInputBox({
            prompt: `Enter the name of output ${keys.length + 1} (e.g. CC), leave empty when finished.`,
            ignoreFocusOut: true,
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
        // a named (map) value is stored under its canonical-key identity, not its
        // label, so the initial selection must match that same string
        if (typeof value.value === 'object') {
            const map = value as MapValueObject;
            return { label: map.displayValue, value: canonicalKey(map.value) };
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
