import * as fs from 'fs';
import * as path from 'path';
import { window } from 'vscode';
import * as commands from '../../commands';
import { JsonFile } from '../../jsonFile';
import { ExtensionConfig } from '../../config';

/**
 * Anti-drift guard for the demo GIF (images/full_demo.gif).
 *
 * The GIF is recorded by scripts/record-demo.mjs driving the real add-parameter
 * wizard step by step. When a wizard picker is added, removed, or reworded, the
 * recording silently desyncs and the GIF goes stale — exactly what happened when
 * the 1.9.0 "guided vs. insert an example" creation-mode picker was added.
 *
 * This suite, unlike commands.test.ts, uses the REAL prompts module (no
 * jest.mock('../../prompts')), so it exercises the actual quick-pick sequence the
 * user sees. It pins that sequence to a golden list, and checks the demo script
 * waits for every entry — so a wizard change fails CI here, with a pointer to
 * re-record, instead of shipping a misleading GIF.
 */

const showQuickPick = window.showQuickPick as jest.Mock;
const showInputBox = window.showInputBox as jest.Mock;

// The ordered quick-pick prompts the GUIDED ARRAY add-flow shows (after the file
// pick, which the demo reaches by clicking and is asserted separately). Keep this
// in lockstep with the wizard: if this list changes, update it AND re-record the
// demo GIF — `scripts/record-headless.sh --install full`.
const GUIDED_ARRAY_QUICKPICKS = [
    'Select the type of the parameter.',
    'How do you want to define this parameter?',
    'Choose how to define the parameter values.',
    'Configure advanced options, or select none to use the defaults.',
];

const RERECORD_HINT = 'Wizard prompts changed — update GUIDED_ARRAY_QUICKPICKS and re-record the demo GIF: scripts/record-headless.sh --install full';

describe('demo GIF stays in sync with the wizard', () => {
    it('drives the guided array add-flow through exactly the golden quick-pick sequence', async () => {
        const placeholders: string[] = [];
        showQuickPick.mockImplementation(async (items: unknown, options: { placeHolder?: string; canPickMany?: boolean } = {}) => {
            placeholders.push(options.placeHolder ?? '<no placeHolder>');
            const list = (await items) as unknown[];
            // mirror the demo: take the first row, or select none for a multi-select
            return options.canPickMany ? [] : list[0];
        });
        // name, then one value, then empty to finish the value loop
        const inputs = ['demoId', 'a', ''];
        showInputBox.mockImplementation(async () => inputs.shift());

        const jsonFile = {
            uri: { path: '/ws/.vscode/tasks.json' },
            isLaunchJson: false,
            params: [],
            addParam: jest.fn(),
        } as unknown as JsonFile & { addParam: jest.Mock };
        const config = { showNames: false, showSelections: true } as unknown as ExtensionConfig;

        // pass the file explicitly so the flow under test starts at the type pick
        await commands.onAddParam(config, [jsonFile], jsonFile);

        expect(jsonFile.addParam).toHaveBeenCalled(); // the flow ran to completion
        expect(placeholders).toEqual(GUIDED_ARRAY_QUICKPICKS); // ...via the golden sequence
    });

    it('has the demo script wait for every wizard picker, in order', () => {
        const demoPath = path.resolve(__dirname, '../../../scripts/record-demo.mjs');
        const demo = fs.readFileSync(demoPath, 'utf8');
        // isolate flowAdd (the wizard-driving flow) so a stray waitForPrompt elsewhere can't mask a gap
        const flowAdd = demo.slice(demo.indexOf('async function flowAdd'), demo.indexOf('async function flowSelect'));
        const waited = [...flowAdd.matchAll(/waitForPrompt\(page,\s*'([^']+)'/g)].map((m) => m[1].toLowerCase());

        // each golden quick-pick must be awaited by a matching (substring) waitForPrompt,
        // in order — so a newly added picker the demo doesn't handle fails here
        const matched: string[] = [];
        let from = 0;
        for (const prompt of GUIDED_ARRAY_QUICKPICKS) {
            const idx = waited.findIndex((substr, i) => i >= from && prompt.toLowerCase().includes(substr));
            if (idx < 0) {
                throw new Error(`${RERECORD_HINT}\n  demo never waits for: "${prompt}"`);
            }
            matched.push(prompt);
            from = idx + 1;
        }
        expect(matched).toEqual(GUIDED_ARRAY_QUICKPICKS); // all golden pickers handled, in order
    });
});
