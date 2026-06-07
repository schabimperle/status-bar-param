import * as vscode from 'vscode';
import * as prompts from '../../prompts';
import { JsonFile } from '../../jsonFile';
import { CommandOptions } from '../../schemas';

const showQuickPick = vscode.window.showQuickPick as jest.Mock;
const showInputBox = vscode.window.showInputBox as jest.Mock;

describe('promptJsonFile', () => {
    const files = [
        { getFileName: () => 'tasks.json', getDescription: () => 'ws' },
        { getFileName: () => 'launch.json', getDescription: () => 'ws' },
    ] as unknown as JsonFile[];

    it('returns the picked file', async () => {
        showQuickPick.mockImplementationOnce((items: { jsonFile: JsonFile }[]) => Promise.resolve(items[1]));
        await expect(prompts.promptJsonFile(files)).resolves.toBe(files[1]);
    });

    it('returns undefined when cancelled', async () => {
        showQuickPick.mockResolvedValueOnce(undefined);
        await expect(prompts.promptJsonFile(files)).resolves.toBeUndefined();
    });
});

describe('promptParamType', () => {
    it('maps the first item to array and the second to command', async () => {
        showQuickPick.mockImplementationOnce((items: unknown[]) => Promise.resolve(items[0]));
        await expect(prompts.promptParamType()).resolves.toBe('array');
        showQuickPick.mockImplementationOnce((items: unknown[]) => Promise.resolve(items[1]));
        await expect(prompts.promptParamType()).resolves.toBe('command');
    });

    it('returns undefined when cancelled', async () => {
        showQuickPick.mockResolvedValueOnce(undefined);
        await expect(prompts.promptParamType()).resolves.toBeUndefined();
    });
});

describe('promptParamId', () => {
    it('returns the entered id', async () => {
        showInputBox.mockResolvedValueOnce('myId');
        await expect(prompts.promptParamId([])).resolves.toBe('myId');
    });

    it('returns undefined for an empty id or when cancelled', async () => {
        showInputBox.mockResolvedValueOnce('');
        await expect(prompts.promptParamId([])).resolves.toBeUndefined();
        showInputBox.mockResolvedValueOnce(undefined);
        await expect(prompts.promptParamId([])).resolves.toBeUndefined();
    });

    it('rejects ids with substitution-hostile characters or already in use via validateInput', async () => {
        showInputBox.mockResolvedValueOnce('ok');
        await prompts.promptParamId(['taken']);
        const { validateInput } = showInputBox.mock.calls.at(-1)![0];
        expect(validateInput('has space')).toBeTruthy();
        // characters that would break ${input:<id>} / ${command:…get.<id>} strings
        expect(validateInput('with}brace')).toBeTruthy();
        expect(validateInput('with\ttab')).toBeTruthy();
        expect(validateInput('with\nnewline')).toBeTruthy();
        expect(validateInput('taken')).toBeTruthy();
        // the allow-list still accepts letters, digits, and _ . -
        expect(validateInput('ok_id.1-2')).toBeUndefined();
        expect(validateInput('nospace')).toBeUndefined();
    });
});

describe('promptParamArgs (array)', () => {
    // the first quick pick is the "use display labels?" toggle
    const declineDisplayValues = () => showQuickPick.mockResolvedValueOnce({ label: 'No', value: false });
    const useDisplayValues = () => showQuickPick.mockResolvedValueOnce({ label: 'Yes', value: true });

    it('collects plain string values until an empty entry', async () => {
        declineDisplayValues();
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValueOnce('');
        await expect(prompts.promptParamArgs('array', '/ws')).resolves.toEqual(['a', 'b']);
    });

    it('aborts (undefined) when an entry is escaped', async () => {
        declineDisplayValues();
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce(undefined);
        await expect(prompts.promptParamArgs('array', '/ws')).resolves.toBeUndefined();
    });

    it('aborts (undefined) when the display-label toggle is escaped', async () => {
        showQuickPick.mockResolvedValueOnce(undefined);
        await expect(prompts.promptParamArgs('array', '/ws')).resolves.toBeUndefined();
    });

    it('captures a display label and keeps unlabeled values as plain strings', async () => {
        useDisplayValues();
        showInputBox
            .mockResolvedValueOnce('v1')
            .mockResolvedValueOnce('Label one') // labeled
            .mockResolvedValueOnce('v2')
            .mockResolvedValueOnce('') // empty label -> plain
            .mockResolvedValueOnce(''); // finished
        await expect(prompts.promptParamArgs('array', '/ws')).resolves.toEqual([{ value: 'v1', displayValue: 'Label one' }, 'v2']);
    });

    it('aborts (undefined) when a display label is escaped', async () => {
        useDisplayValues();
        showInputBox.mockResolvedValueOnce('v1').mockResolvedValueOnce(undefined);
        await expect(prompts.promptParamArgs('array', '/ws')).resolves.toBeUndefined();
    });
});

describe('promptParamArgs (command)', () => {
    it('aborts when no shell command is entered', async () => {
        showInputBox.mockResolvedValueOnce('');
        await expect(prompts.promptParamArgs('command', '/ws')).resolves.toBeUndefined();
    });

    it('aborts when Escape is pressed on the optional separator prompt', async () => {
        showInputBox.mockResolvedValueOnce('ls').mockResolvedValueOnce(undefined);
        await expect(prompts.promptParamArgs('command', '/ws')).resolves.toBeUndefined();
    });

    it('aborts when Escape is pressed on the optional cwd prompt', async () => {
        showInputBox.mockResolvedValueOnce('ls').mockResolvedValueOnce('').mockResolvedValueOnce(undefined);
        await expect(prompts.promptParamArgs('command', '/ws')).resolves.toBeUndefined();
    });

    it('skips optional values left empty', async () => {
        showInputBox.mockResolvedValueOnce('ls').mockResolvedValueOnce('').mockResolvedValueOnce('');
        await expect(prompts.promptParamArgs('command', '/ws')).resolves.toEqual({ shellCmd: 'ls' });
    });

    it('captures provided separator and cwd', async () => {
        showInputBox.mockResolvedValueOnce('ls').mockResolvedValueOnce(',').mockResolvedValueOnce('sub');
        await expect(prompts.promptParamArgs('command', '/ws')).resolves.toEqual<CommandOptions>({
            shellCmd: 'ls',
            separator: ',',
            cwd: 'sub',
        });
    });
});

describe('promptCanPickMany', () => {
    it('returns true/false for Yes/No and undefined on Escape', async () => {
        showQuickPick.mockResolvedValueOnce({ label: 'Yes', value: true });
        await expect(prompts.promptCanPickMany()).resolves.toBe(true);
        showQuickPick.mockResolvedValueOnce({ label: 'No', value: false });
        await expect(prompts.promptCanPickMany()).resolves.toBe(false);
        showQuickPick.mockResolvedValueOnce(undefined);
        await expect(prompts.promptCanPickMany()).resolves.toBeUndefined();
    });
});

describe('promptAddSampleTask', () => {
    it('returns false without prompting for launch.json', async () => {
        await expect(prompts.promptAddSampleTask(true)).resolves.toBe(false);
        expect(showQuickPick).not.toHaveBeenCalled();
    });

    it('returns true/false for Yes/No and undefined on Escape', async () => {
        showQuickPick.mockResolvedValueOnce({ label: 'Yes', value: true });
        await expect(prompts.promptAddSampleTask(false)).resolves.toBe(true);
        showQuickPick.mockResolvedValueOnce({ label: 'No', value: false });
        await expect(prompts.promptAddSampleTask(false)).resolves.toBe(false);
        showQuickPick.mockResolvedValueOnce(undefined);
        await expect(prompts.promptAddSampleTask(false)).resolves.toBeUndefined();
    });
});
