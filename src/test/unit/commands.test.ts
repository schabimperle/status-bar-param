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
        (prompts.promptParamId as jest.Mock).mockResolvedValue('myId');
        // promptParamArgs now returns the args plus the sample-task choice
        (prompts.promptParamArgs as jest.Mock).mockResolvedValue({ args: ['a', 'b'], addSampleTask: false });
    });

    it('writes the gathered parameter and passes the wizard context', async () => {
        await commands.onAddParam(config, [], jsonFile);
        // the global defaults + sample-task offer are threaded into the prompt
        expect(prompts.promptParamArgs).toHaveBeenCalledWith('array', { showNamesDefault: false, showSelectionsDefault: true, offerSampleTask: true });
        expect(jsonFile.addParam).toHaveBeenCalledWith('myId', ['a', 'b'], false);
    });

    it('forwards the sample-task choice from the advanced step', async () => {
        (prompts.promptParamArgs as jest.Mock).mockResolvedValue({ args: ['a'], addSampleTask: true });
        await commands.onAddParam(config, [], jsonFile);
        expect(jsonFile.addParam).toHaveBeenCalledWith('myId', ['a'], true);
    });

    it('does not offer a sample task for launch.json', async () => {
        (jsonFile as unknown as { isLaunchJson: boolean }).isLaunchJson = true;
        await commands.onAddParam(config, [], jsonFile);
        expect(prompts.promptParamArgs).toHaveBeenCalledWith('array', expect.objectContaining({ offerSampleTask: false }));
    });

    it('asks for a file when invoked without one and aborts if none is chosen', async () => {
        (prompts.promptJsonFile as jest.Mock).mockResolvedValue(undefined);
        await commands.onAddParam(config, [jsonFile]);
        expect(prompts.promptJsonFile).toHaveBeenCalled();
        expect(jsonFile.addParam).not.toHaveBeenCalled();
    });

    it.each([
        ['type', () => (prompts.promptParamType as jest.Mock).mockResolvedValue(undefined)],
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
    it('copies the input reference', async () => {
        showQuickPick.mockResolvedValueOnce({ target: 'input' });
        await commands.onCopyCmd(fakeParam({}));
        expect(writeText).toHaveBeenCalledWith('${input:myId}');
    });

    it('copies the command reference', async () => {
        showQuickPick.mockResolvedValueOnce({ target: 'command' });
        await commands.onCopyCmd(fakeParam({}));
        expect(writeText).toHaveBeenCalledWith('${command:statusBarParam.get.myId}');
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
