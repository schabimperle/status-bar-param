import * as vscode from 'vscode';
import * as prompts from '../../prompts';
import * as commands from '../../commands';
import { JsonFile } from '../../jsonFile';
import { Param } from '../../param';
import { ExtensionConfig } from '../../config';
import { ArrayValuesDelegate, CommandValuesDelegate } from '../../valuesDelegate';
import { DisplayableValue } from '../../schemas';

jest.mock('../../prompts');

const showQuickPick = vscode.window.showQuickPick as jest.Mock;
const showInformationMessage = vscode.window.showInformationMessage as jest.Mock;
const writeText = vscode.env.clipboard.writeText as jest.Mock;

const A: DisplayableValue = { value: 'a', displayValue: 'a' };
const B: DisplayableValue = { value: 'b', displayValue: 'b' };

describe('onReset', () => {
    it("clears only this extension's selection keys and refreshes each file", () => {
        const update = jest.fn();
        const keys = ['statusBarParam.get.k1', 'statusBarParam.select.k2', 'unrelated.key'];
        const config = { workspaceState: { keys: () => keys, update } } as unknown as ExtensionConfig;
        const files = [{ update: jest.fn() }, { update: jest.fn() }] as unknown as JsonFile[];

        commands.onReset(config, files);

        // current and legacy selection keys are cleared
        expect(update).toHaveBeenCalledWith('statusBarParam.get.k1', undefined);
        expect(update).toHaveBeenCalledWith('statusBarParam.select.k2', undefined);
        // a foreign key in the same Memento is left untouched
        expect(update).not.toHaveBeenCalledWith('unrelated.key', undefined);
        files.forEach((file) => expect(file.update).toHaveBeenCalled());
    });
});

describe('onAddParam', () => {
    let jsonFile: JsonFile & { addParam: jest.Mock };
    const config = { showNames: false, showSelections: true } as unknown as ExtensionConfig;

    beforeEach(() => {
        jsonFile = {
            uri: { path: '/ws/.vscode/tasks.json' },
            isLaunchJson: false,
            addParam: jest.fn(),
        } as unknown as JsonFile & { addParam: jest.Mock };

        (prompts.promptParamType as jest.Mock).mockResolvedValue('array');
        // the creation mode is the last pick before the content fork; default to guided
        (prompts.promptCreationMode as jest.Mock).mockResolvedValue('guided');
        // the value shape is gathered after the id, before the creation mode
        (prompts.promptValueShape as jest.Mock).mockResolvedValue('plain');
        (prompts.promptParamId as jest.Mock).mockResolvedValue('myId');
        // promptParamArgs now returns the args plus the sample-task choice
        (prompts.promptParamArgs as jest.Mock).mockResolvedValue({ args: ['a', 'b'], addSampleTask: false });
    });

    it('writes the gathered parameter and passes the wizard context and value shape', async () => {
        await commands.onAddParam(config, [], jsonFile);
        // the global defaults + sample-task offer + chosen value shape are threaded into the prompt
        expect(prompts.promptParamArgs).toHaveBeenCalledWith(
            'array',
            { showNamesDefault: false, showSelectionsDefault: true, offerSampleTask: true },
            'plain',
            'myId',
            expect.any(Set),
        );
        expect(jsonFile.addParam).toHaveBeenCalledWith('myId', ['a', 'b'], false);
    });

    it('preflights the new id against existing primary and secondary command ids', async () => {
        const existing = [
            { id: 'compiler', command: 'statusBarParam.get.compiler', valuesDelegate: { getSecondaryKeys: () => ['cc', 'cxx'] } },
        ] as unknown as Param[];
        const fileWithParams = { params: existing } as unknown as JsonFile;
        await commands.onAddParam(config, [fileWithParams], jsonFile);
        expect(prompts.promptParamId).toHaveBeenCalledWith(
            ['compiler'],
            new Set(['statusBarParam.get.compiler', 'statusBarParam.get.compiler.cc', 'statusBarParam.get.compiler.cxx']),
        );
    });

    it('orders the array wizard as type → id → shape → creation mode', async () => {
        await commands.onAddParam(config, [], jsonFile);
        const order = (m: jest.Mock) => m.mock.invocationCallOrder[0];
        const type = order(prompts.promptParamType as jest.Mock);
        const id = order(prompts.promptParamId as jest.Mock);
        const shape = order(prompts.promptValueShape as jest.Mock);
        const mode = order(prompts.promptCreationMode as jest.Mock);
        // name the parameter right after its type, then refine the array's value shape,
        // then fork on how to fill it in — the fork sits immediately before the content
        expect(type).toBeLessThan(id);
        expect(id).toBeLessThan(shape);
        expect(shape).toBeLessThan(mode);
    });

    it('does not ask for a value shape for a command param', async () => {
        (prompts.promptParamType as jest.Mock).mockResolvedValue('command');
        await commands.onAddParam(config, [], jsonFile);
        expect(prompts.promptValueShape).not.toHaveBeenCalled();
        // a command param threads no shape (undefined) into the args step
        expect(prompts.promptParamArgs).toHaveBeenCalledWith('command', expect.any(Object), undefined, 'myId', expect.any(Set));
    });

    it('forwards the sample-task choice from the advanced step', async () => {
        (prompts.promptParamArgs as jest.Mock).mockResolvedValue({ args: ['a'], addSampleTask: true });
        await commands.onAddParam(config, [], jsonFile);
        expect(jsonFile.addParam).toHaveBeenCalledWith('myId', ['a'], true);
    });

    it('does not offer a sample task for launch.json', async () => {
        (jsonFile as unknown as { isLaunchJson: boolean }).isLaunchJson = true;
        await commands.onAddParam(config, [], jsonFile);
        expect(prompts.promptParamArgs).toHaveBeenCalledWith('array', expect.objectContaining({ offerSampleTask: false }), 'plain', 'myId', expect.any(Set));
    });

    it('asks for a file when invoked without one and aborts if none is chosen', async () => {
        (prompts.promptJsonFile as jest.Mock).mockResolvedValue(undefined);
        await commands.onAddParam(config, [jsonFile]);
        expect(prompts.promptJsonFile).toHaveBeenCalled();
        expect(jsonFile.addParam).not.toHaveBeenCalled();
    });

    describe('example mode', () => {
        beforeEach(() => {
            (prompts.promptCreationMode as jest.Mock).mockResolvedValue('example');
            // the sample task is a single yes/no in example mode; default to yes
            (prompts.promptExampleSampleTask as jest.Mock).mockResolvedValue(true);
        });

        it('seeds an example of the chosen shape (with the entered id) and skips the value/advanced prompts', async () => {
            (prompts.promptValueShape as jest.Mock).mockResolvedValue('named');
            const args = { values: [{ displayValue: 'GCC', value: { CC: 'gcc' } }] };
            (prompts.buildExampleArgs as jest.Mock).mockReturnValue(args);

            await commands.onAddParam(config, [], jsonFile);

            // the example is built for the chosen type + shape
            expect(prompts.buildExampleArgs).toHaveBeenCalledWith('array', 'named');
            // example mode never runs the guided value/advanced gathering
            expect(prompts.promptParamArgs).not.toHaveBeenCalled();
            // the chosen sample task plus a how-to comment (pointing at the named per-key
            // commands, using the user's own id) go in alongside the example
            expect(jsonFile.addParam).toHaveBeenCalledWith('myId', args, true, expect.stringContaining('statusBarParam.get.myId.<key>'));
        });

        it('omits the sample task when the user declines it', async () => {
            (prompts.promptExampleSampleTask as jest.Mock).mockResolvedValue(false);
            (prompts.buildExampleArgs as jest.Mock).mockReturnValue({ values: ['debug', 'release'] });

            await commands.onAddParam(config, [], jsonFile);

            expect(jsonFile.addParam).toHaveBeenCalledWith('myId', { values: ['debug', 'release'] }, false, expect.anything());
        });

        it('aborts (without writing) when the sample-task prompt is cancelled', async () => {
            (prompts.promptExampleSampleTask as jest.Mock).mockResolvedValue(undefined);
            (prompts.buildExampleArgs as jest.Mock).mockReturnValue({ values: ['debug', 'release'] });

            await commands.onAddParam(config, [], jsonFile);

            expect(jsonFile.addParam).not.toHaveBeenCalled();
        });

        it('aborts (without writing) when a named example output clashes with an existing command id', async () => {
            (prompts.promptValueShape as jest.Mock).mockResolvedValue('named');
            (prompts.buildExampleArgs as jest.Mock).mockReturnValue({ values: [{ displayValue: 'GCC', value: { CC: 'gcc' } }] });
            // an existing param whose primary command is `…get.myId.CC` — the fixed example
            // key CC would register the same command id, which the guided flow would reject
            const clashing = { id: 'myId.CC', command: 'statusBarParam.get.myId.CC', valuesDelegate: { getSecondaryKeys: () => [] } } as unknown as Param;
            const fileWithParam = { params: [clashing] } as unknown as JsonFile;

            await commands.onAddParam(config, [fileWithParam], jsonFile);

            expect(jsonFile.addParam).not.toHaveBeenCalled();
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("'CC' output clashes"));
        });

        it('comments a non-named example with its ${input:<id>} reference and adds no task for launch.json', async () => {
            (jsonFile as unknown as { isLaunchJson: boolean }).isLaunchJson = true;
            (prompts.buildExampleArgs as jest.Mock).mockReturnValue({ values: ['debug', 'release'] });

            await commands.onAddParam(config, [], jsonFile);

            // launch.json gets no task, so its sample-task prompt is never shown
            expect(prompts.promptExampleSampleTask).not.toHaveBeenCalled();
            expect(jsonFile.addParam).toHaveBeenCalledWith('myId', { values: ['debug', 'release'] }, false, expect.stringContaining('${input:myId}'));
        });
    });

    it.each([
        ['type', () => (prompts.promptParamType as jest.Mock).mockResolvedValue(undefined)],
        ['creation mode', () => (prompts.promptCreationMode as jest.Mock).mockResolvedValue(undefined)],
        ['value shape', () => (prompts.promptValueShape as jest.Mock).mockResolvedValue(undefined)],
        ['id', () => (prompts.promptParamId as jest.Mock).mockResolvedValue(undefined)],
        ['args', () => (prompts.promptParamArgs as jest.Mock).mockResolvedValue(undefined)],
    ])('aborts without writing when %s is cancelled', async (_label, arrange) => {
        arrange();
        await commands.onAddParam(config, [], jsonFile);
        expect(jsonFile.addParam).not.toHaveBeenCalled();
    });
});

function fakeParam(over: Partial<Record<string, unknown>>): Param {
    return {
        id: 'myId',
        opts: {},
        valuesDelegate: new ArrayValuesDelegate({ values: [] }),
        getValues: jest.fn(),
        loadSelectedValues: jest.fn(() => []),
        storeSelectedValues: jest.fn(),
        ...over,
    } as unknown as Param;
}

describe('onSelect', () => {
    it('shows an info message and stores nothing when there are no values', async () => {
        const param = fakeParam({ getValues: jest.fn(async () => []) });
        await commands.onSelect(param);
        expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('No values available'));
        expect(param.storeSelectedValues).not.toHaveBeenCalled();
    });

    it('explains the trust restriction for an unavailable command param', async () => {
        (vscode.workspace as { isTrusted: boolean }).isTrusted = false;
        const param = fakeParam({
            valuesDelegate: new CommandValuesDelegate({ shellCmd: 'ls' }, '/ws', new Map(), 'statusBarParam.get.ls'),
            getValues: jest.fn(async () => undefined),
        });
        await commands.onSelect(param);
        expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('shell command'));
        (vscode.workspace as { isTrusted: boolean }).isTrusted = true;
    });

    it('stores a single picked value', async () => {
        const param = fakeParam({ getValues: jest.fn(async () => [A, B]), loadSelectedValues: jest.fn(() => []) });
        showQuickPick.mockResolvedValueOnce({ reference: A });
        await commands.onSelect(param);
        expect(param.storeSelectedValues).toHaveBeenCalledWith([A]);
    });

    it('stores multiple picked values for canPickMany', async () => {
        const param = fakeParam({
            opts: { canPickMany: true },
            getValues: jest.fn(async () => [A, B]),
        });
        showQuickPick.mockResolvedValueOnce([{ reference: A }, { reference: B }]);
        await commands.onSelect(param);
        expect(param.storeSelectedValues).toHaveBeenCalledWith([A, B]);
    });

    it('stores nothing when the picker is cancelled', async () => {
        const param = fakeParam({ getValues: jest.fn(async () => [A, B]) });
        showQuickPick.mockResolvedValueOnce(undefined);
        await commands.onSelect(param);
        expect(param.storeSelectedValues).not.toHaveBeenCalled();
    });
});

describe('onEdit', () => {
    it('reveals the parameter', async () => {
        const reveal = jest.fn();
        await commands.onEdit(fakeParam({ reveal }));
        expect(reveal).toHaveBeenCalled();
    });
});

describe('onCopyCmd', () => {
    // resolve the quick pick to the offered item whose label matches
    const pickByLabel = (label: string) =>
        showQuickPick.mockImplementationOnce(async (items: Array<{ label: string }>) => items.find((item) => item.label === label));

    it('offers and copies the input reference for a plain param', async () => {
        pickByLabel('Copy Input Reference');
        await commands.onCopyCmd(fakeParam({}));
        expect(writeText).toHaveBeenCalledWith('${input:myId}');
    });

    it('offers and copies the command reference for a plain param', async () => {
        pickByLabel('Copy Command Reference');
        await commands.onCopyCmd(fakeParam({}));
        expect(writeText).toHaveBeenCalledWith('${command:statusBarParam.get.myId}');
    });

    it('offers a per-key command reference for a named param (not the broken keyless ones)', async () => {
        const param = fakeParam({ valuesDelegate: { getSecondaryKeys: () => ['cc', 'cxx'] } });
        let offered: Array<{ reference: string }> = [];
        showQuickPick.mockImplementationOnce(async (items: Array<{ reference: string }>) => {
            offered = items;
            return items[0];
        });
        await commands.onCopyCmd(param);
        expect(offered.map((item) => item.reference)).toEqual(['${command:statusBarParam.get.myId.cc}', '${command:statusBarParam.get.myId.cxx}']);
        expect(writeText).toHaveBeenCalledWith('${command:statusBarParam.get.myId.cc}');
    });

    it('copies nothing when cancelled', async () => {
        showQuickPick.mockResolvedValueOnce(undefined);
        await commands.onCopyCmd(fakeParam({}));
        expect(writeText).not.toHaveBeenCalled();
    });
});

describe('onDelete', () => {
    const content = '{\n  "inputs": [\n    { "id": "myId", "type": "command", "command": "x", "args": ["a"] }\n  ]\n}';
    const readFile = vscode.workspace.fs.readFile as jest.Mock;
    const writeFile = vscode.workspace.fs.writeFile as jest.Mock;

    function deletableParam(over: Partial<Record<string, unknown>> = {}, uriPath = '/ws/.vscode/tasks.json'): Param {
        const uri = vscode.Uri.file(uriPath);
        return {
            id: 'myId',
            inputsPath: ['inputs'],
            deleteStoredSelection: jest.fn(),
            jsonFile: {
                uri,
                // mirror JsonFile.mutate's file-scheme path so the workspace.fs mocks
                // below still observe the read/write
                mutate: async (transform: (current: string) => string) => {
                    const current = (await vscode.workspace.fs.readFile(uri)).toString();
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(transform(current)));
                },
            },
            ...over,
        } as unknown as Param;
    }

    beforeEach(() => {
        readFile.mockResolvedValue(Buffer.from(content));
        writeFile.mockResolvedValue(undefined);
    });

    it('deletes the parameter and its stored selection when confirmed', async () => {
        showQuickPick.mockResolvedValueOnce({ confirmed: true });
        const param = deletableParam();
        await commands.onDelete(param);
        expect(writeFile).toHaveBeenCalled();
        const written = (writeFile.mock.calls[0][1] as Buffer).toString();
        expect(written).not.toContain('myId');
        expect(param.deleteStoredSelection).toHaveBeenCalled();
    });

    it('deletes a user (global) tasks param via the tasks config, not by opening the file', async () => {
        // useDocumentIO files must be edited through the `tasks` config so deleting the
        // last param never leaves a task-less file that re-triggers the template picker
        showQuickPick.mockResolvedValueOnce({ confirmed: true });
        const deleteParamFromUserTasks = jest.fn();
        const mutate = jest.fn();
        const param = deletableParam({ jsonFile: { useDocumentIO: true, deleteParamFromUserTasks, mutate } });
        await commands.onDelete(param);
        expect(deleteParamFromUserTasks).toHaveBeenCalledWith('myId');
        expect(mutate).not.toHaveBeenCalled();
        expect(param.deleteStoredSelection).toHaveBeenCalled();
    });

    it('does NOT delete when the user picks "No"', async () => {
        showQuickPick.mockResolvedValueOnce({ confirmed: false });
        const param = deletableParam();
        await commands.onDelete(param);
        expect(writeFile).not.toHaveBeenCalled();
        expect(param.deleteStoredSelection).not.toHaveBeenCalled();
    });

    it('does NOT delete when the picker is cancelled', async () => {
        showQuickPick.mockResolvedValueOnce(undefined);
        const param = deletableParam();
        await commands.onDelete(param);
        expect(writeFile).not.toHaveBeenCalled();
        expect(param.deleteStoredSelection).not.toHaveBeenCalled();
    });

    it('deletes from the launch.inputs section of a .code-workspace, leaving tasks.inputs intact', async () => {
        // a .code-workspace has two independent inputs arrays; a param defined in
        // launch.inputs must be removed from there, not from tasks.inputs at the
        // same index (which would corrupt the wrong section)
        const workspaceContent = JSON.stringify({
            tasks: { version: '2.0.0', inputs: [{ id: 'taskParam', type: 'command', command: 'x', args: ['t'] }] },
            launch: { inputs: [{ id: 'launchParam', type: 'command', command: 'y', args: ['l'] }] },
        });
        readFile.mockResolvedValue(Buffer.from(workspaceContent));
        showQuickPick.mockResolvedValueOnce({ confirmed: true });

        await commands.onDelete(deletableParam({ id: 'launchParam', inputsPath: ['launch', 'inputs'] }, '/ws/test.code-workspace'));

        const written = JSON.parse((writeFile.mock.calls.at(-1)![1] as Buffer).toString());
        expect(written.launch.inputs).toHaveLength(0); // launch param removed
        expect(written.tasks.inputs).toHaveLength(1); // task param untouched
        expect(written.tasks.inputs[0].id).toBe('taskParam');
    });
});
