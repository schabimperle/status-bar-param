import { env, QuickPickItem, window, workspace } from 'vscode';
import * as jsonc from 'jsonc-parser';
import { JsonFile } from './jsonFile';
import { Param } from './param';
import { CommandValuesDelegate } from './valuesDelegate';
import { Strings } from './strings';
import { ExtensionConfig } from './config';
import { ArrayOptions, ArrayValue, CommandOptions } from './schemas';
import * as prompts from './prompts';
import * as log from './log';

/*
 * Command handlers, grouped by the object they act on. extension.ts only wires
 * these to vscode command ids; the behavior lives here.
 */

/* ── global commands ── */

// clear every stored selection and re-evaluate all params
export function onReset(config: ExtensionConfig, jsonFiles: JsonFile[]) {
    log.debug('onReset');
    // only clear this extension's own selection keys (`statusBarParam.*`), not the
    // whole Memento, so a future non-selection key wouldn't be wiped by a reset
    config.workspaceState
        .keys()
        .filter((key) => key.startsWith(`${Strings.EXTENSION_ID}.`))
        .forEach((key) => config.workspaceState.update(key, undefined));
    jsonFiles.forEach((jsonFile) => jsonFile.update());
}

/* ── json file commands ── */

// interactively create a parameter and write it to a json file
export async function onAddParam(jsonFiles: JsonFile[], jsonFile?: JsonFile) {
    log.debug('onAddParam');

    // select the target file if the command wasn't invoked on a specific one
    jsonFile ??= await prompts.promptJsonFile(jsonFiles);
    if (!jsonFile) {
        return;
    }

    const type = await prompts.promptParamType();
    if (!type) {
        return;
    }
    // ids share a single global command namespace, so reject existing ones up front
    const existingIds = jsonFiles.flatMap((file) => file.params).map((param) => param.id);
    const id = await prompts.promptParamId(existingIds);
    if (!id) {
        return;
    }
    let args: ArrayValue[] | ArrayOptions | CommandOptions | undefined = await prompts.promptParamArgs(type, jsonFile.getDefaultCwd());
    if (args === undefined) {
        return;
    }

    const canPickMany = await prompts.promptCanPickMany();
    if (canPickMany === undefined) {
        return;
    }
    if (canPickMany) {
        if (args instanceof Array) {
            args = { values: args };
        }
        args.canPickMany = true;
    }
    const addSampleTask = await prompts.promptAddSampleTask(jsonFile.isLaunchJson);
    if (addSampleTask === undefined) {
        return;
    }

    await jsonFile.addParam(id, args, addSampleTask);
}

/* ── param commands ── */

// pick value(s) for a parameter
export async function onSelect(param: Param) {
    log.debug('onSelect');
    // force a fresh run so the picker reflects the current command output
    const values = await param.getValues(true);
    // don't open an empty picker (confirming it would wipe the stored selection);
    // explain why when a command param is suppressed by trust
    if (!values || values.length === 0) {
        if (param.valuesDelegate instanceof CommandValuesDelegate && !workspace.isTrusted) {
            window.showInformationMessage(`'${param.id}' is defined by a shell command, which is not run in an untrusted workspace.`);
        } else {
            window.showInformationMessage(`No values available to select for '${param.id}'.`);
        }
        return;
    }
    const oldSelections = param.loadSelectedValues() ?? [];
    // preselect single selection
    if (!param.opts.canPickMany && oldSelections.length === 1) {
        const selectionIndex = values.findIndex((value) => value.value === oldSelections[0]);
        if (selectionIndex !== -1) {
            values.unshift(values.splice(selectionIndex, 1)[0]);
        }
    }
    // preselect multiple selection
    const items = values.map((value) => {
        return {
            label: value.displayValue,
            picked: oldSelections.includes(value.value),
            reference: value,
        };
    });
    const newSelections = await window.showQuickPick(items, { canPickMany: param.opts.canPickMany, ignoreFocusOut: param.opts.canPickMany });
    if (newSelections !== undefined) {
        param.storeSelectedValues(Array.isArray(newSelections) ? newSelections.map((newSelection) => newSelection.reference) : [newSelections.reference]);
    }
}

// open the json file at the parameter's definition
export async function onEdit(param: Param) {
    log.debug('onEdit');
    await param.reveal();
}

// copy the input/command retrieval string of a parameter
export async function onCopyCmd(param: Param) {
    log.debug('onCopyCmd');
    const items: (QuickPickItem & { target: 'input' | 'command' })[] = [
        {
            target: 'input',
            label: 'Copy Input String',
            description: 'To use only in the vscode configuration file where the parameter is defined.',
        },
        {
            target: 'command',
            label: 'Copy Command String',
            description: 'To use across vscode configuration files.',
        },
    ];
    const copyType = await window.showQuickPick(items, {
        placeHolder: 'Select the string you want to copy.',
    });
    if (copyType?.target === 'input') {
        await env.clipboard.writeText(`\${input:${param.id}}`);
    } else if (copyType?.target === 'command') {
        await env.clipboard.writeText(`\${command:${Strings.EXTENSION_ID}.get.${param.id}}`);
    }
}

// remove a parameter from its json file
export async function onDelete(param: Param) {
    log.debug('onDelete');
    const items: (QuickPickItem & { confirmed: boolean })[] = [
        { label: 'No', confirmed: false },
        { label: 'Yes', confirmed: true },
    ];
    const selection = await window.showQuickPick(items, { placeHolder: `Do you really want to delete ${param.id}?` });
    if (selection?.confirmed) {
        try {
            await param.jsonFile.mutate((current) => {
                // delete from the param's own inputs section (a .code-workspace has
                // separate tasks.inputs and launch.inputs), not a recomputed default
                const jsoncInputsPath = [...param.inputsPath, param.jsonArrayIndex];
                return jsonc.applyEdits(current, jsonc.modify(current, jsoncInputsPath, undefined, { formattingOptions: {} }));
            });
            // drop the persisted selection so it doesn't linger for a removed param
            await param.deleteStoredSelection();
        } catch (err) {
            // surface failures (e.g. the user tasks.json open timing out) rather
            // than leaving an unhandled rejection
            window.showErrorMessage(`Failed to delete parameter '${param.id}': ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
