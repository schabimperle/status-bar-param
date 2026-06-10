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

// default wizard context: global showNames off, showSelections on, sample task offered
const CTX: prompts.WizardContext = { showNamesDefault: false, showSelectionsDefault: true, offerSampleTask: true };
// pick nothing in the advanced multi-select (the common path)
const noAdvanced = () => showQuickPick.mockResolvedValueOnce([]);
// pick the given advanced option keys (canPickMany, displayValue, ...)
const advanced = (...keys: string[]) => showQuickPick.mockResolvedValueOnce(keys.map((key) => ({ key })));

describe('promptParamArgs (array)', () => {
    it('collects plain string values and returns a bare array when no advanced options are picked', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValueOnce('');
        noAdvanced();
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toEqual({ args: ['a', 'b'], addSampleTask: false });
    });

    it('aborts (undefined) when a value entry is escaped', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce(undefined);
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toBeUndefined();
    });

    it('aborts when the advanced options menu is escaped', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('');
        showQuickPick.mockResolvedValueOnce(undefined);
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toBeUndefined();
    });

    it('wraps the values in an options object when canPickMany is picked', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValueOnce('');
        advanced('canPickMany');
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toEqual({ args: { values: ['a', 'b'], canPickMany: true }, addSampleTask: false });
    });

    it('sets the status-bar toggles to the opposite of the global default', async () => {
        // global: showNames false, showSelections true → picking both flips each
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('');
        advanced('showName', 'showSelection');
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toEqual({
            args: { values: ['a'], showName: true, showSelection: false },
            addSampleTask: false,
        });
    });

    it('flips the toggles the other way when the global defaults are inverted', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('');
        advanced('showName', 'showSelection');
        const inverted: prompts.WizardContext = { showNamesDefault: true, showSelectionsDefault: false, offerSampleTask: true };
        await expect(prompts.promptParamArgs('array', inverted)).resolves.toEqual({
            args: { values: ['a'], showName: false, showSelection: true },
            addSampleTask: false,
        });
    });

    it('reports addSampleTask when the sample-task box is checked', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('');
        advanced('sampleTask');
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toEqual({ args: ['a'], addSampleTask: true });
    });

    it('collects per-value display labels, keeping an empty label as a plain string', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValueOnce('');
        advanced('displayValue');
        showInputBox.mockResolvedValueOnce('Apple').mockResolvedValueOnce('');
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toEqual({ args: [{ value: 'a', displayValue: 'Apple' }, 'b'], addSampleTask: false });
    });

    it('aborts when a display label is escaped', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('');
        advanced('displayValue');
        showInputBox.mockResolvedValueOnce(undefined);
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toBeUndefined();
    });

    it('sets a single initialSelection from a pick of the values', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValueOnce('');
        advanced('initialSelection');
        showQuickPick.mockResolvedValueOnce({ value: 'b' });
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toEqual({ args: { values: ['a', 'b'], initialSelection: 'b' }, addSampleTask: false });
    });

    it('sets a multi initialSelection when canPickMany is also picked', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValueOnce('');
        advanced('canPickMany', 'initialSelection');
        showQuickPick.mockResolvedValueOnce([{ value: 'a' }, { value: 'b' }]);
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toEqual({
            args: { values: ['a', 'b'], canPickMany: true, initialSelection: ['a', 'b'] },
            addSampleTask: false,
        });
    });

    it('treats an empty initial-selection pick as "no selection" (not abort)', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('');
        advanced('canPickMany', 'initialSelection');
        showQuickPick.mockResolvedValueOnce([]); // picked none
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toEqual({ args: { values: ['a'], canPickMany: true }, addSampleTask: false });
    });

    it('aborts when the initial-selection pick is escaped', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('');
        advanced('initialSelection');
        showQuickPick.mockResolvedValueOnce(undefined);
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toBeUndefined();
    });

    it('collects a custom joinSeparator (stored as the literal the user typed)', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValueOnce('');
        advanced('canPickMany', 'joinSeparator');
        showInputBox.mockResolvedValueOnce('\\n'); // user typed backslash-n; stored literally
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toEqual({
            args: { values: ['a', 'b'], canPickMany: true, joinSeparator: '\\n' },
            addSampleTask: false,
        });
    });

    it('skips an empty joinSeparator entry, keeping the default', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('');
        advanced('joinSeparator');
        showInputBox.mockResolvedValueOnce(''); // empty → keep default
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toEqual({ args: ['a'], addSampleTask: false });
    });

    it('aborts when the joinSeparator entry is escaped', async () => {
        showInputBox.mockResolvedValueOnce('a').mockResolvedValueOnce('');
        advanced('joinSeparator');
        showInputBox.mockResolvedValueOnce(undefined); // escaped
        await expect(prompts.promptParamArgs('array', CTX)).resolves.toBeUndefined();
    });
});

describe('promptParamArgs (command)', () => {
    it('aborts when no shell command is entered', async () => {
        showInputBox.mockResolvedValueOnce('');
        await expect(prompts.promptParamArgs('command', CTX)).resolves.toBeUndefined();
    });

    it('returns the shell command when no advanced options are picked', async () => {
        showInputBox.mockResolvedValueOnce('ls');
        noAdvanced();
        await expect(prompts.promptParamArgs('command', CTX)).resolves.toEqual({ args: { shellCmd: 'ls' } as CommandOptions, addSampleTask: false });
    });

    it('adds cwd and separator when picked', async () => {
        showInputBox.mockResolvedValueOnce('ls');
        advanced('cwd', 'separator');
        showInputBox.mockResolvedValueOnce('/tmp').mockResolvedValueOnce(',');
        await expect(prompts.promptParamArgs('command', CTX)).resolves.toEqual({
            args: { shellCmd: 'ls', cwd: '/tmp', separator: ',' } as CommandOptions,
            addSampleTask: false,
        });
    });

    it('interprets backslash escapes in the separator (\\n -> newline)', async () => {
        showInputBox.mockResolvedValueOnce('ls');
        advanced('separator');
        showInputBox.mockResolvedValueOnce('\\n'); // user typed backslash-n
        const result = (await prompts.promptParamArgs('command', CTX)) as { args: CommandOptions };
        expect(result.args.separator).toBe('\n'); // a real newline, not the 2-char string
    });

    it('collects a joinSeparator on a command param too', async () => {
        showInputBox.mockResolvedValueOnce('ls');
        advanced('canPickMany', 'joinSeparator');
        showInputBox.mockResolvedValueOnce(', '); // joinSeparator entered in collectOptions
        await expect(prompts.promptParamArgs('command', CTX)).resolves.toEqual({
            args: { shellCmd: 'ls', canPickMany: true, joinSeparator: ', ' } as CommandOptions,
            addSampleTask: false,
        });
    });

    it('skips an empty optional command input without aborting', async () => {
        showInputBox.mockResolvedValueOnce('ls');
        advanced('cwd');
        showInputBox.mockResolvedValueOnce(''); // empty cwd → skip
        await expect(prompts.promptParamArgs('command', CTX)).resolves.toEqual({ args: { shellCmd: 'ls' } as CommandOptions, addSampleTask: false });
    });

    it('aborts when an optional command input is escaped', async () => {
        showInputBox.mockResolvedValueOnce('ls');
        advanced('separator');
        showInputBox.mockResolvedValueOnce(undefined); // separator escaped
        await expect(prompts.promptParamArgs('command', CTX)).resolves.toBeUndefined();
    });

    it('sets a single free-text initialSelection for a command param', async () => {
        showInputBox.mockResolvedValueOnce('ls');
        advanced('initialSelection');
        showInputBox.mockResolvedValueOnce('main'); // free-text initial selection
        await expect(prompts.promptParamArgs('command', CTX)).resolves.toEqual({
            args: { shellCmd: 'ls', initialSelection: 'main' } as CommandOptions,
            addSampleTask: false,
        });
    });

    it('collects multiple free-text initial selections when canPickMany is picked', async () => {
        showInputBox.mockResolvedValueOnce('ls');
        advanced('canPickMany', 'initialSelection');
        showInputBox.mockResolvedValueOnce('main').mockResolvedValueOnce('dev').mockResolvedValueOnce(''); // two values then finish
        await expect(prompts.promptParamArgs('command', CTX)).resolves.toEqual({
            args: { shellCmd: 'ls', canPickMany: true, initialSelection: ['main', 'dev'] } as CommandOptions,
            addSampleTask: false,
        });
    });

    it('does not offer a sample task when offerSampleTask is false (launch.json)', async () => {
        showInputBox.mockResolvedValueOnce('ls');
        // the menu has no sampleTask item to pick; selecting nothing yields no task
        noAdvanced();
        const noSample: prompts.WizardContext = { ...CTX, offerSampleTask: false };
        await expect(prompts.promptParamArgs('command', noSample)).resolves.toEqual({ args: { shellCmd: 'ls' } as CommandOptions, addSampleTask: false });
    });
});
