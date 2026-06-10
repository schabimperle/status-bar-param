// Headless demo-GIF driver for code-server via a remote CDP browser.
//
// Connects to an existing CDP browser (connectOverCDP), loads the demo
// workspace served by code-server, drives the Status Bar Parameter flows
// through VS Code's DOM, and records each flow via CDP screencast -> mp4.
//
// Env:
//   CDP_URL   CDP endpoint              (default http://192.168.48.10:9222)
//   BASE_URL  code-server URL as seen FROM the browser (default http://192.168.48.1:8741)
//   FOLDER    abs workspace path inside code-server (default .../demo-workspace)
//   OUT_DIR   where to write <flow>.mp4 (default /tmp/sbp-demo)
//   FLOWS     comma list: add,select,retrieve,runtask,full  (default full -> README asset)
//
// Usage: node scripts/record-demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
    sleep, pause, waitForWorkbench, runCommand, waitForPrompt, typeQuick, acceptQuick,
    cleanChrome, glideClick, smoothMove, showTitle, Recorder,
} from './lib/vscode-web.mjs';
import { installOverlays } from './lib/mouse-helper.mjs';

const CDP_URL = process.env.CDP_URL || 'http://192.168.48.10:9222';
const BASE_URL = process.env.BASE_URL || 'http://192.168.48.1:8741';
const FOLDER = process.env.FOLDER || '/home/dev/status-bar-param/demo-workspace';
const OUT_DIR = process.env.OUT_DIR || '/tmp/sbp-demo';
const FLOWS = (process.env.FLOWS || 'full').split(',').map((s) => s.trim()).filter(Boolean);
const VIEW = { width: 1280, height: 720 };

const PARAM = { name: 'environment', values: ['development', 'staging', 'production'] };
// the demo selects values[PICK] to show navigating the value list with the keyboard
const PICK = 2;
// one consistent "beat" (ms) held between visible steps/sections so the pacing of
// the breaks is uniform across the GIF (functional waits below are separate)
const HOLD = 2500;

fs.mkdirSync(OUT_DIR, { recursive: true });

// --- flows ------------------------------------------------------------------

async function flowAdd(page) {
    // Start from the tree view: open the Status Bar Parameter activity-bar
    // container, then click its "Add Parameter" welcome button (empty view).
    const viewIcon = page.locator('.activitybar a.action-label[aria-label*="Status Bar Parameter" i]').first();
    await glideClick(page, viewIcon, { dur: 650 });
    const addBtn = page.locator('.monaco-button, a.monaco-button', { hasText: 'Add Parameter' }).first();
    await glideClick(page, addBtn, { dur: 600 });
    // 1) pick target json file with the KEYBOARD (cursor stays on the button):
    //    row 1 is the User tasks file, ArrowDown picks the workspace tasks.json.
    await waitForPrompt(page, 'file where the parameter');
    await acceptQuick(page, { downs: 1 });
    // 2) pick type -> Array (first)
    await waitForPrompt(page, 'type of the parameter');
    await acceptQuick(page);
    // 2b) value shape -> Plain values (first row). The wizard asks how the values
    //     are defined (plain / display labels / named outputs) right after the type
    //     and before the name; the demo param is a plain list, so accept the first.
    await waitForPrompt(page, 'how to define');
    await acceptQuick(page);
    // 3) name
    await waitForPrompt(page, 'name of the parameter');
    await typeQuick(page, PARAM.name);
    // 4) values, then empty to finish
    for (let i = 0; i < PARAM.values.length; i++) {
        await waitForPrompt(page, 'parameter value');
        await typeQuick(page, PARAM.values[i]);
    }
    await waitForPrompt(page, 'parameter value');
    await typeQuick(page, ''); // empty -> finish
    // 5) advanced options multi-select -> check only "Add a sample task" so the
    //    extension scaffolds a runnable task (section 3 customizes it); all other
    //    options are left unchecked at their defaults. Driven by the KEYBOARD only:
    //    ArrowDown to the "sample task" row (no typing/filtering), Space toggles its
    //    checkbox, then Shift+Tab moves focus to the OK button so Enter confirms.
    await waitForPrompt(page, 'advanced options');
    const sampleRow = page.locator('.quick-input-list .monaco-list-row', { hasText: 'Add a sample task' }).first();
    await sampleRow.waitFor({ state: 'visible', timeout: 8000 });
    await pause(1500); // let the option list be read AND let the value-finishing Enter
                       // badge retire (>1.3s) so the ArrowDown run reads as its own badge
    // Count the exact ArrowDown presses that land on the sample-task row, up front:
    // data-index is the row's logical position, and if the list opens with no row
    // focused the first press only activates row 0 (so we offset by one). Firing the
    // presses back-to-back (no per-step DOM round-trip) keeps them in ONE keystroke
    // badge instead of a long run plus a stray trailing arrow.
    const downs = await sampleRow.evaluate(el => {
        const target = Number(el.getAttribute('data-index'));
        const focused = el.closest('.monaco-list').querySelector('.monaco-list-row.focused');
        const from = focused ? Number(focused.getAttribute('data-index')) : -1;
        return target - from; // none focused (-1) -> first press lands on row 0
    });
    for (let i = 0; i < downs; i++) {
        await page.keyboard.press('ArrowDown'); // glide the active row down toward "Add a sample task"
        await pause(280);
    }
    await pause(500);
    await page.keyboard.press('Space'); // toggle the "Add a sample task" checkbox (Space isn't badged)
    // hold past the badge lifetime so the ArrowDown badge fully retires before the OK
    // gesture, keeping Shift+Tab as its own clean badge rather than trailing the arrows.
    await pause(1500);
    await page.keyboard.press('Shift+Tab'); // move focus from the list to the OK button
    await pause(900);
    await acceptQuick(page); // Enter activates the focused OK button, confirming the multi-select
    // wait for the new status bar item to appear (file scanned), then a consistent beat
    await page.locator('.statusbar-item', { hasText: PARAM.values[0] }).first().waitFor({ state: 'visible', timeout: 15000 });
    await pause(HOLD);
}

async function flowSelect(page) {
    // glide to our status bar item and click it (visible cursor + ripple)
    const item = page.locator('.statusbar-item', { hasText: PARAM.values[0] }).first();
    await glideClick(page, item, { dur: 700 });
    // The value quick-pick opens with the current value (values[0], top row)
    // highlighted. Pick a different value with ARROW KEYS rather than the mouse:
    // the list keeps PARAM order, so PICK (=2) downs land on values[PICK].
    const target = page.locator('.quick-input-list .monaco-list-row', { hasText: PARAM.values[PICK] }).first();
    await target.waitFor({ state: 'visible', timeout: 12000 });
    await pause(1200); // let the value list be read before navigating it
    await acceptQuick(page, { downs: PICK });
    // hold on the newly selected value in the status bar so this section reads as
    // its own step (not merged into the next), matching the other inter-step beats
    await pause(HOLD);
}

async function flowRetrieve(page) {
    await runCommand(page, 'Status Bar Parameter: Copy Reference');
    await pause(1500);
    // if a picker appears to choose which param, accept first
    if (await page.locator('.quick-input-widget').isVisible().catch(() => false)) {
        await acceptQuick(page);
    }
    await pause(2500);
}

// Label of the task the wizard scaffolds for an array param (see jsonFile.ts).
const TASK_LABEL = `echo value of ${PARAM.name}`;
// `${input:...}` reference the task command substitutes with the selected value.
const SUB = '${input:' + PARAM.name + '}';
// The new command string content (single-quoted, no escaped \" backslashes that
// would distract from the `${input:...}` reference). autoClosing* are off in the
// demo workspace settings, so the quotes/braces land literally when typed.
const NEW_CONTENT = `echo 'Deploying to ${SUB}'`;

// The "Add sample task?" step scaffolded a generic `echo 'Current value of … is
// …'` task and opened tasks.json. Edit it like a human would: drag-select just
// the string INSIDE the command's quotes (not the whole line) and type the new
// content over it. The drag endpoints come from the string token's geometry --
// the editor font is monospace, so column<->pixel is exact.
async function flowCustomizeTask(page) {
    // Monaco wraps a line's tokens in one outer <span>; its box == the line's
    // content box and its text == the whole line (incl. indentation), so
    // column<->pixel is exact (monospace font). Find the command value's quotes
    // in that text and drag-select just the string BETWEEN them.
    const lineSpan = page.locator('.view-line', { hasText: 'Current value of' })
        .locator('span', { hasText: 'Current value of' }).first();
    await lineSpan.scrollIntoViewIfNeeded();
    await lineSpan.waitFor({ state: 'visible', timeout: 12000 });
    const sb = await lineSpan.boundingBox();
    const lt = (await lineSpan.textContent()) || '';
    const charW = sb.width / lt.length;
    const open = lt.indexOf('"', lt.indexOf(':')); // value opening " (first " after the colon)
    const close = lt.lastIndexOf('"');             // value closing "
    const y = sb.y + sb.height / 2;
    // gaps just inside the quotes (nudge 0.25 col inward so it snaps the right way)
    const xStart = sb.x + (open + 1) * charW + charW * 0.25;
    const xEnd = sb.x + close * charW - charW * 0.25;
    // glide to the start (cursor continues from its last position), then drag to
    // the end to MARK the section inside the quotes.
    await smoothMove(page, xStart, y, 750);
    await pause(350);
    await page.mouse.down();
    await smoothMove(page, xEnd, y, 650);
    await page.mouse.up();
    await pause(800);
    await page.keyboard.type(NEW_CONTENT, { delay: 26 }); // type over the selection
    await pause(900);
    await page.keyboard.press('Control+s'); // save so Run Task uses the new command
    await pause(1800);
}

// Run the scaffolded (now customized) task, which echoes the selected value --
// shows the parameter actually being used.
async function flowRunTask(page) {
    // hold on the freshly selected value so it registers before we move on,
    // making the jump from "selected a value" to "run a task" easy to follow
    await pause(HOLD);
    await runCommand(page, 'Tasks: Run Task');
    await pause(1600);
    // our configured task is listed first and pre-highlighted -- confirm with the
    // KEYBOARD instead of reaching the mouse up into the picker.
    const taskRow = page.locator('.quick-input-list .monaco-list-row', { hasText: TASK_LABEL }).first();
    await taskRow.waitFor({ state: 'visible', timeout: 12000 });
    await pause(1200);
    await page.keyboard.press('Enter');
    // the task opens a terminal and echoes the value -- hold so it can be read
    await pause(5500);
}

// One guided demo covering all three use cases, with numbered title cards
// between the sections so a single GIF tells the whole story.
async function flowFull(page) {
    await showTitle(page, '1', 'Add a parameter');
    await flowAdd(page);
    await showTitle(page, '2', 'Select another value');
    await flowSelect(page);
    await showTitle(page, '3', 'Use the value in a task');
    await flowCustomizeTask(page);
    await flowRunTask(page);
}

const FLOW_FNS = { add: flowAdd, select: flowSelect, retrieve: flowRetrieve, runtask: flowRunTask, full: flowFull };

// --- main -------------------------------------------------------------------

async function main() {
    const browser = await chromium.connectOverCDP(CDP_URL);
    const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await installOverlays(page);
    const cdp = await ctx.newCDPSession(page);

    const url = `${BASE_URL}/?folder=${encodeURIComponent(FOLDER)}`;
    console.log('loading', url);
    await page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' });
    await waitForWorkbench(page);
    await sleep(6000); // extension host settle
    await cleanChrome(page);
    // park the cursor centre-screen so the overlay is visible from the start
    await page.mouse.move(VIEW.width / 2, VIEW.height / 2, { steps: 10 });
    await sleep(1000);

    for (const flow of FLOWS) {
        const fn = FLOW_FNS[flow];
        if (!fn) { console.warn('unknown flow', flow); continue; }
        console.log(`>> recording flow: ${flow}`);
        const rec = new Recorder(cdp, path.join(OUT_DIR, `frames-${flow}`), VIEW);
        await rec.start();
        try {
            await fn(page);
            console.log(`   flow '${flow}' returned`);
            await page.screenshot({ path: path.join(OUT_DIR, `after-${flow}.png`) }).catch(() => {});
        } catch (e) {
            await page.screenshot({ path: path.join(OUT_DIR, `error-${flow}.png`) }).catch(() => {});
            await rec.stop(path.join(OUT_DIR, `${flow}.mp4`)).catch(() => {});
            throw new Error(`flow '${flow}' failed: ${e.message}`);
        }
        const out = await rec.stop(path.join(OUT_DIR, `${flow}.mp4`));
        console.log(`   -> ${out} (${rec.frames.length} frames)`);
        await sleep(800);
    }

    // teardown: close only OUR context (shared browser stays up). Guard against
    // a slow CDP close hanging the process.
    await Promise.race([ctx.close().catch(() => {}), sleep(5000)]);
    console.log('done');
    process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
