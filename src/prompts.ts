import { EOL } from 'os';
import { QuickPickItem, window } from 'vscode';
import { ArrayValue, CommandOptions } from './schemas';
import { ArrayValuesDelegate, CommandValuesDelegate } from './valuesDelegate';
import type { JsonFile } from './jsonFile';

/**
 * Interactive prompts for creating a parameter. Each returns the gathered data,
 * or undefined when the user aborts (Escape). For optional inputs (separator/cwd)
 * undefined = abort, while an empty string = skip the setting and keep its default.
 */

export type ParamType = 'array' | 'command';

const arrayLabel = `\$(${ArrayValuesDelegate.ICON.id}) Array`;
const commandLabel = `\$(${CommandValuesDelegate.ICON.id}) Command`;
// carry the boolean on the item so handlers switch on it, not the display label
interface BoolItem extends QuickPickItem {
    value: boolean;
}
const boolItems: BoolItem[] = [
    { label: 'No', value: false },
    { label: 'Yes', value: true },
];

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

/** Gather the args for the chosen type. Returns undefined if the user aborts. */
export async function promptParamArgs(type: ParamType, defaultCwd: string): Promise<ArrayValue[] | CommandOptions | undefined> {
    return type === 'array' ? promptArrayValues() : promptCommandOptions(defaultCwd);
}

async function promptArrayValues(): Promise<ArrayValue[] | undefined> {
    // Optionally collect a separate display label per value. When declined,
    // values are stored as plain strings so the JSON stays minimal; only
    // values given a label become { value, displayValue } objects.
    const useDisplayValues = await promptUseDisplayValues();
    if (useDisplayValues === undefined) {
        return undefined;
    }
    const args: ArrayValue[] = [];
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
        if (!useDisplayValues) {
            args.push(value);
            continue;
        }
        // Escape aborts; an empty label keeps the raw value as the displayed one.
        const displayValue = await window.showInputBox({
            prompt: `Optional: Enter a display label for '${value}'. Leave empty to show the raw value.`,
            ignoreFocusOut: true,
            placeHolder: value,
        });
        if (displayValue === undefined) {
            return undefined;
        }
        args.push(displayValue ? { value, displayValue } : value);
    }
    return args;
}

/** Whether array values should carry separate display labels. Escape aborts. */
async function promptUseDisplayValues(): Promise<boolean | undefined> {
    const selection = await window.showQuickPick(boolItems, {
        placeHolder: 'Show custom display labels instead of the raw values?',
        ignoreFocusOut: true,
    });
    if (selection === undefined) {
        return undefined;
    }
    return selection.value;
}

async function promptCommandOptions(defaultCwd: string): Promise<CommandOptions | undefined> {
    const shellCmd = await window.showInputBox({
        prompt: `Enter a shell command that outputs parameter values to select from.`,
        ignoreFocusOut: true,
    });
    if (!shellCmd) {
        return undefined;
    }
    const options: CommandOptions = { shellCmd };
    // Escape returns undefined -> abort; an empty string is a deliberate "skip
    // this optional setting" and keeps the default.
    const separator = await window.showInputBox({
        prompt: `Optional: Enter a string to separate the command output to selectable values. Defaults to OS specific line separator.`,
        ignoreFocusOut: true,
        placeHolder: EOL.replace(/\n/g, '\\n').replace(/\r/g, '\\r'),
    });
    if (separator === undefined) {
        return undefined;
    }
    if (separator) {
        options.separator = separator;
    }
    const cwd = await window.showInputBox({
        prompt: `Optional: Enter the working directory to execute the shell command from. Defaults to '${defaultCwd}'.`,
        ignoreFocusOut: true,
        placeHolder: defaultCwd,
    });
    if (cwd === undefined) {
        return undefined;
    }
    if (cwd) {
        options.cwd = cwd;
    }
    return options;
}

/** Whether multiple selection should be enabled. Escape (undefined) aborts. */
export async function promptCanPickMany(): Promise<boolean | undefined> {
    const selection = await window.showQuickPick(boolItems, {
        placeHolder: 'Enable checkboxes for selection of multiple values?',
        ignoreFocusOut: true,
    });
    if (selection === undefined) {
        return undefined;
    }
    return selection.value;
}

/** Whether to add a sample task. Not offered for launch.json. Escape aborts. */
export async function promptAddSampleTask(isLaunchJson: boolean): Promise<boolean | undefined> {
    if (isLaunchJson) {
        return false;
    }
    const selection = await window.showQuickPick(boolItems, {
        placeHolder: 'Add sample task to demonstrate usage?',
        ignoreFocusOut: true,
    });
    if (selection === undefined) {
        return undefined;
    }
    return selection.value;
}
