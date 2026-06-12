import { env, QuickPickItem, window, workspace } from 'vscode';
import * as jsonc from 'jsonc-parser';
import { JsonFile } from './jsonFile';
import { Param } from './param';
import { CommandValuesDelegate } from './valuesDelegate';
import { ArrayOptions, ArrayValue, CommandOptions } from './schemas';
import { Strings } from './strings';
import { ExtensionConfig } from './config';
import * as prompts from './prompts';
import * as log from './log';

/*
 * Command handlers, grouped by the object they act on. extension.ts only wires
 * these to vscode command ids; the behavior lives here.
 */

/* ── global commands ── */

/** Clear every stored selection (only this extension's keys) and re-evaluate all params. */
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

/** Interactively create a parameter and write it to a json file. */
export async function onAddParam(config: ExtensionConfig, jsonFiles: JsonFile[], jsonFile?: JsonFile) {
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
    // ids share a single global command namespace, so reject existing ones up front.
    // Collect every already-registered command id (each param's primary plus its
    // per-key secondary commands) so the wizard can reject a new id or output key that
    // would collide — e.g. a new id `foo.cc` vs an existing `foo` + key `cc` — instead
    // of writing a config entry whose command only fails to register afterwards.
    const existingParams = jsonFiles.flatMap((file) => file.params);
    const existingIds = existingParams.map((param) => param.id);
    const existingCommandIds = new Set<string>();
    for (const param of existingParams) {
        existingCommandIds.add(param.command);
        for (const key of param.valuesDelegate.getSecondaryKeys()) {
            existingCommandIds.add(`${param.command}.${key}`);
        }
    }
    // name the parameter right after its type — the core identity, asked before the value
    // details so the flow reads the way you'd say it: "an <type> called <id>, shaped …".
    const id = await prompts.promptParamId(existingIds, existingCommandIds);
    if (!id) {
        return;
    }
    // for an array, pick the value shape (plain / labelled / named) next — it reads as a
    // refinement of "Array" and decides what the value prompts ask (or which example is
    // seeded), so it's settled before the content rather than buried in the args step.
    let shape: prompts.ValueShape | undefined;
    if (type === 'array') {
        shape = await prompts.promptValueShape();
        if (!shape) {
            return;
        }
    }
    // with the parameter fully described (type, id, shape), fork on HOW to fill it in: be
    // led through the value/option prompts, or seed a complete example to edit in JSON.
    // The fork sits here, immediately before the paths diverge — not earlier, where both
    // branches would still share the id/shape questions.
    const mode = await prompts.promptCreationMode();
    if (!mode) {
        return;
    }
    // example path: seed a complete entry of the chosen shape (with this id) to edit in
    // JSON, skipping the value/advanced prompts, with a how-to note written above it.
    if (mode === 'example') {
        const args = prompts.buildExampleArgs(type, shape);
        // the named example's output keys are fixed (e.g. CC/CXX), so — unlike the guided
        // flow, which validates each key as it's typed — guard their `…get.<id>.<key>`
        // commands against the existing namespace here, before writing a config entry
        // whose named output would only fail to register afterwards.
        const command = Strings.getCommandId(id);
        const clash = JsonFile.secondaryKeysOf(args).find((key) => existingCommandIds.has(`${command}.${key}`));
        if (clash) {
            window.showErrorMessage(
                `Cannot insert the example: its '${clash}' output clashes with the command of another parameter. ` +
                    `Rename that parameter, or choose a different id for this one.`,
            );
            return;
        }
        // the sample task is the user's choice here just as in the guided flow, but the
        // example path skips the advanced step that hosts it, so ask a single yes/no
        // (default yes). launch.json never gets a task, so don't ask for it.
        let addSampleTask = false;
        if (!jsonFile.isLaunchJson) {
            const choice = await prompts.promptExampleSampleTask();
            if (choice === undefined) {
                return;
            }
            addSampleTask = choice;
        }
        await jsonFile.addParam(id, args, addSampleTask, exampleComment(id, args));
        return;
    }
    // the advanced step phrases its status-bar toggles relative to the current
    // global defaults, and folds in the sample-task choice (skipped for launch.json)
    const result = await prompts.promptParamArgs(
        type,
        {
            showNamesDefault: config.showNames,
            showSelectionsDefault: config.showSelections,
            offerSampleTask: !jsonFile.isLaunchJson,
        },
        shape,
        id,
        existingCommandIds,
    );
    if (!result) {
        return;
    }

    await jsonFile.addParam(id, result.args, result.addSampleTask);
}

// the how-to-edit/use note written above a seeded example. Shape-aware: a named value
// has no keyless reference, so it points at the per-key `…get.<id>.<key>` commands; any
// other shape uses the plain `${input:<id>}` (or cross-file `${command:…}`).
function exampleComment(id: string, args: ArrayValue[] | ArrayOptions | CommandOptions): string {
    const command = Strings.getCommandId(id);
    const keys = JsonFile.secondaryKeysOf(args);
    if (keys.length > 0) {
        return (
            `// Example parameter — edit the values in 'args', then read each named\n` +
            `// output with \${command:${command}.<key>} (keys: ${keys.join(', ')}).`
        );
    }
    return (
        `// Example parameter — edit the values in 'args', then use the selected\n` +
        `// value via \${input:${id}} (or \${command:${command}} from another file).`
    );
}

/* ── param commands ── */

/** Pick value(s) for a parameter via a quick pick, then persist the selection. */
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

/** Open the json file at the parameter's definition. */
export async function onEdit(param: Param) {
    log.debug('onEdit');
    await param.reveal();
}

/** Copy a parameter's `${input:…}` or `${command:…}` reference to the clipboard. */
export async function onCopyCmd(param: Param) {
    log.debug('onCopyCmd');
    const command = Strings.getCommandId(param.id);
    const secondaryKeys = param.valuesDelegate.getSecondaryKeys();
    // a named (map) value has no keyless value — `${input:id}` / `${command:…get.id}`
    // resolve to an empty string with a warning — so for a named param offer only the
    // per-key command references, which are the ones that actually resolve.
    const items: (QuickPickItem & { reference: string })[] =
        secondaryKeys.length > 0
            ? secondaryKeys.map((key) => ({
                  label: `Copy Command Reference (${key})`,
                  description: `The '${key}' output, to use across vscode configuration files.`,
                  reference: `\${command:${command}.${key}}`,
              }))
            : [
                  {
                      label: 'Copy Input Reference',
                      description: 'To use only in the vscode configuration file where the parameter is defined.',
                      reference: `\${input:${param.id}}`,
                  },
                  {
                      label: 'Copy Command Reference',
                      description: 'To use across vscode configuration files.',
                      reference: `\${command:${command}}`,
                  },
              ];
    const picked = await window.showQuickPick(items, {
        placeHolder: 'Select the reference you want to copy.',
    });
    if (picked) {
        await env.clipboard.writeText(picked.reference);
    }
}

/** Remove a parameter from its json file (after confirmation) and drop its selection. */
export async function onDelete(param: Param) {
    log.debug('onDelete');
    const items: (QuickPickItem & { confirmed: boolean })[] = [
        { label: 'No', confirmed: false },
        { label: 'Yes', confirmed: true },
    ];
    const selection = await window.showQuickPick(items, { placeHolder: `Do you really want to delete ${param.id}?` });
    if (selection?.confirmed) {
        try {
            if (param.jsonFile.useDocumentIO) {
                // the user (global) tasks.json is edited via the `tasks` config, not by
                // opening it — same as adding — so removing the last param never leaves
                // a task-less file that would make the next open pop the template picker
                await param.jsonFile.deleteParamFromUserTasks(param.id);
            } else {
                await param.jsonFile.mutate((current) => {
                    // locate the input by its (unique) id in the *current* text rather
                    // than a cached array index: the file may have changed since the tree
                    // was built, and a stale index would delete the wrong entry. Search
                    // the param's own inputs section (a .code-workspace has separate
                    // tasks.inputs and launch.inputs).
                    const root = jsonc.parseTree(current);
                    const inputs = root && jsonc.findNodeAtLocation(root, param.inputsPath);
                    const index = inputs?.children?.findIndex((node) => jsonc.findNodeAtLocation(node, ['id'])?.value === param.id) ?? -1;
                    if (index < 0) {
                        return current; // already gone; nothing to delete
                    }
                    const formattingOptions = JsonFile.detectFormatting(current);
                    return jsonc.applyEdits(current, jsonc.modify(current, [...param.inputsPath, index], undefined, { formattingOptions }));
                });
            }
            // drop the persisted selection so it doesn't linger for a removed param
            await param.deleteStoredSelection();
        } catch (err) {
            // surface failures (e.g. the user tasks.json open timing out) rather
            // than leaving an unhandled rejection
            window.showErrorMessage(`Failed to delete parameter '${param.id}': ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
