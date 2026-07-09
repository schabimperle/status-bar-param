// Headless demo-GIF driver for code-server via a remote CDP browser.
//
// Connects to an existing CDP browser (connectOverCDP), loads the demo
// workspace served by code-server, drives the Status Bar Parameter flows
// through VS Code's DOM, and records each flow via CDP screencast -> mp4.
//
// Env:
//   CDP_URL   CDP endpoint              (default $CDP_ENDPOINT, else http://127.0.0.1:9222)
//   BASE_URL  code-server URL as seen FROM the browser (required) — if the browser is
//             not on this host, loopback won't do; see scripts/record-headless.sh
//   FOLDER    abs workspace path inside code-server (default .../demo-workspace)
//   OUT_DIR   where to write <flow>.mp4 (default /tmp/sbp-demo)
//   FLOWS     comma list: add,select,retrieve,runtask,full,usage (default full -> README asset)
//
// Usage: node scripts/record-demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsonc from 'jsonc-parser';
import { chromium } from 'playwright';
import {
    sleep, pause, waitForWorkbench, runCommand, waitForPrompt, typeQuick, acceptQuick,
    cleanChrome, glideClick, smoothMove, showTitle, Recorder,
} from './lib/vscode-web.mjs';
import { installOverlays } from './lib/mouse-helper.mjs';

const CDP_URL = process.env.CDP_URL || process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
// No sane default: only the caller knows which address of this host the CDP browser can
// reach (record-headless.sh works it out). A loopback guess would silently be unreachable
// whenever the browser runs elsewhere.
const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) throw new Error('BASE_URL is required (code-server URL as reachable from the CDP browser)');
// default to the repo's own demo-workspace (scripts/ -> ../demo-workspace), so the
// direct `node scripts/record-demo.mjs` usage isn't pinned to one machine's checkout
const REPO_WORKSPACE = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'demo-workspace');
const FOLDER = process.env.FOLDER || REPO_WORKSPACE;
const OUT_DIR = process.env.OUT_DIR || '/tmp/sbp-demo';
const FLOWS = (process.env.FLOWS || 'full').split(',').map((s) => s.trim()).filter(Boolean);
const VIEW = { width: 1280, height: 720 };

// A cross-compile target: the parameter's raw value is exactly what a build script
// wants as an argument, which is the shape the README's opening example teaches.
const PARAM = { name: 'target', values: ['x86_64', 'armv7', 'aarch64'] };
// the demo selects values[PICK] to show navigating the value list with the keyboard
const PICK = 2;
// Cosmetic "beats" (ms): the stillness held at each KIND of moment, so the GIF's
// rhythm is uniform and tunable in ONE place. Functional waits (waitForPrompt, the
// `waitFor visible` calls) are separate and don't count toward pacing. Named by the
// moment rather than the duration, so the intent stays legible:
//   READ      absorb a freshly-shown prompt/question before acting on it
//   READ_LED  same, but the picker was reached by a CLICK whose settle already gave
//             a reading beat — so this doesn't double-count it (fixes the long hold
//             after "Add Parameter": glideClick.settle + READ was ~1.85s of dead air)
//   RESULT    let an action's outcome register, briefly, before a section title card
//             covers it — the card itself is the section break, so this stays short
//   MIDBEAT   a breather WITHIN a section (not at a section boundary)
//   KEY       between keypresses in a visible run (e.g. an ArrowDown glide)
//   FINAL     terminal output at the end of the full demo; held longer because
//             there is no following title card to give the result more screen time
const BEAT = { READ: 1000, READ_LED: 550, RESULT: 1200, MIDBEAT: 1400, KEY: 260, FINAL: 5000 };

fs.mkdirSync(OUT_DIR, { recursive: true });

// --- flows ------------------------------------------------------------------

async function flowAdd(page) {
    // Start from the tree view: open the Status Bar Parameter activity-bar
    // container, then click its "Add Parameter" welcome button (empty view).
    const viewIcon = page.locator('.activitybar a.action-label[aria-label*="Status Bar Parameter" i]').first();
    await glideClick(page, viewIcon, { dur: 650 });
    const addBtn = page.locator('.monaco-button, a.monaco-button', { hasText: 'Add Parameter' }).first();
    await glideClick(page, addBtn, { dur: 600 });
    // 1) pick the target json file with the KEYBOARD (cursor stays on the button).
    //    Target the WORKSPACE tasks.json by content, not a fixed offset: the list is
    //    local-first and registers launch.json right after the workspace tasks.json,
    //    so a magic ArrowDown count silently lands on the wrong file when the order
    //    shifts (it did). Compute the presses that reach the 'tasks.json' row that
    //    isn't the 'User (Global)' one. READ_LED: the click that opened this picker
    //    already settled, so don't stack a full READ on top (the long-hold-after-
    //    "Add Parameter" gap).
    await waitForPrompt(page, 'file where the parameter');
    const fileRow = page.locator('.quick-input-list .monaco-list-row', { hasText: 'tasks.json' })
        .filter({ hasNotText: 'User (Global)' }).first();
    await fileRow.waitFor({ state: 'visible', timeout: 8000 });
    const fileDowns = await fileRow.evaluate((el) => {
        const target = Number(el.getAttribute('data-index'));
        const focused = el.closest('.monaco-list').querySelector('.monaco-list-row.focused');
        const from = focused ? Number(focused.getAttribute('data-index')) : -1; // none focused -> first press lands on row 0
        return target - from;
    });
    await acceptQuick(page, { downs: Math.max(0, fileDowns), read: BEAT.READ_LED });
    // 2) pick type -> Array (first)
    await waitForPrompt(page, 'type of the parameter');
    await acceptQuick(page, { read: BEAT.READ });
    // 3) name the parameter (right after the type — the wizard's identity-first order)
    await waitForPrompt(page, 'name of the parameter');
    await typeQuick(page, PARAM.name);
    // 4) value shape -> Plain values (first row). The wizard asks how the values are
    //    defined (plain / display labels / named outputs) after the name; plain list here.
    await waitForPrompt(page, 'how to define');
    await acceptQuick(page, { read: BEAT.READ });
    // 5) creation mode -> "Guide me through it" (first row). The wizard forks between
    //    being guided and dropping an example to edit; the demo shows the guided flow.
    await waitForPrompt(page, 'want to define');
    await acceptQuick(page, { read: BEAT.READ });
    // 6) values, then empty to finish
    for (let i = 0; i < PARAM.values.length; i++) {
        await waitForPrompt(page, 'parameter value');
        await typeQuick(page, PARAM.values[i]);
    }
    await waitForPrompt(page, 'parameter value');
    await typeQuick(page, ''); // empty -> finish
    // 7) advanced options multi-select -> check only "Add a sample task" so the
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
        await pause(BEAT.KEY);
    }
    await pause(500);
    await page.evaluate(() => window.__showNextBareSpace && window.__showNextBareSpace());
    await page.keyboard.press('Space'); // toggle the "Add a sample task" checkbox
    // hold past the badge lifetime so the ArrowDown badge fully retires before the OK
    // gesture, keeping Shift+Tab as its own clean badge rather than trailing the arrows.
    await pause(1500);
    await page.keyboard.press('Shift+Tab'); // move focus from the list to the OK button
    await pause(120);
    await page.keyboard.press('Enter'); // confirm the multi-select as one Shift+Tab -> Enter gesture
    // wait for the new status bar item to appear (file scanned), then a consistent beat
    await page.locator('.statusbar-item', { hasText: PARAM.values[0] }).first().waitFor({ state: 'visible', timeout: 15000 });
    await pause(BEAT.RESULT);
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
    // brief hold on the newly selected value before the next section's title card
    // takes over (the card is the real section break, so this stays short)
    await pause(BEAT.RESULT);
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
// `${input:...}` reference the task substitutes with the selected value.
const SUB = '${input:' + PARAM.name + '}';
// What the scaffolded task's `command` is rewritten to. The wizard leaves the
// parameter wired up in `args`, so swapping the command alone turns the sample into
// the README's opening example: `./build.sh ${input:target}`. No quotes or braces are
// typed, so the demo workspace's autoClosing* settings can't interfere.
const NEW_COMMAND = './build.sh';

// Label of the pre-seeded task the short `usage` flow runs (see seedUsageWorkspace).
const USAGE_TASK = 'build';

// The "Add sample task?" step scaffolded an `echo` task whose `args` already reference
// the parameter, and opened tasks.json. Edit it like a human would: drag-select just the
// command string INSIDE its quotes (not the whole line) and type the new command over it.
// The drag endpoints come from the string token's geometry -- the editor font is
// monospace, so column<->pixel is exact.
async function flowCustomizeTask(page) {
    // Monaco wraps a line's tokens in one outer <span>; its box == the line's
    // content box and its text == the whole line (incl. indentation), so
    // column<->pixel is exact (monospace font). Find the command value's quotes
    // in that text and drag-select just the string BETWEEN them. Match on the VALUE
    // (`"echo"`), since the inputs section further down has a `"command"` key too.
    const commandLine = /"command":\s*"echo"/;
    const lineSpan = page.locator('.view-line', { hasText: commandLine })
        .locator('span', { hasText: commandLine }).first();
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
    await page.keyboard.type(NEW_COMMAND, { delay: 26 }); // type over the selection
    await pause(900);
    await page.keyboard.press('Control+s'); // save so Run Task uses the new command
    await pause(1800);
}

// Run the scaffolded (now customized) task, which passes the selected value to
// build.sh -- shows the parameter actually being used.
async function flowRunTask(page) {
    // a breather on the freshly customized task before we run it, so the jump from
    // "edited the task" to "run it" is easy to follow (mid-section, not a boundary)
    await pause(BEAT.MIDBEAT);
    await runCommand(page, 'Tasks: Run Task');
    await pause(1600);
    // our configured task is listed first and pre-highlighted -- confirm with the
    // KEYBOARD instead of reaching the mouse up into the picker.
    const taskRow = page.locator('.quick-input-list .monaco-list-row', { hasText: TASK_LABEL }).first();
    await taskRow.waitFor({ state: 'visible', timeout: 12000 });
    await pause(1200);
    await page.keyboard.press('Enter');
    // the task opens a terminal and build.sh echoes the value -- hold so it can be read
    await pause(BEAT.FINAL);
}

// Short hero flow: how an ALREADY-configured parameter is USED (no wizard). The
// workspace is pre-seeded (seedUsageWorkspace) with a `target` param at its default
// value and a `build` task passing `${input:target}` to build.sh. Beats: click the
// status-bar item -> pick another value -> run the task -> read the substituted value
// in the terminal. Kept tight; no title cards.
async function flowUsage(page) {
    // the configured `target` parameter sits in the status bar at its default value
    // (the first, "x86_64"); glide over and click it to open the value picker
    const item = page.locator('.statusbar-item', { hasText: PARAM.values[0] }).first();
    await item.waitFor({ state: 'visible', timeout: 15000 });
    await pause(300);
    await glideClick(page, item, { dur: 500, settle: 300 });
    // pick a different value ("aarch64") with the keyboard (list keeps PARAM order).
    // Brisk picker pacing: short read before, and quick steps between the ArrowDowns.
    const target = page.locator('.quick-input-list .monaco-list-row', { hasText: PARAM.values[PICK] }).first();
    await target.waitFor({ state: 'visible', timeout: 12000 });
    await acceptQuick(page, { downs: PICK, read: 250, step: 150 });
    // Move the cursor off the status bar, then dismiss its hover popup with Escape. The
    // hover is STICKY in code-server (it re-appears even with the mouse away) and would
    // otherwise linger over the terminal payoff. The Escape is functional only -- its
    // on-camera badge is suppressed, so the visible sequence stays "↓ ↓ ↵" and nothing
    // else. Hold longer than the badge's 1.3s group window so the value-pick keystrokes
    // retire into their OWN badge before the palette chord starts a fresh "⌃⇧P" one
    // (otherwise the two runs merge into one run-on badge).
    await smoothMove(page, VIEW.width / 2, VIEW.height * 0.45, 400);
    await page.evaluate(() => window.__suppressNextEscape && window.__suppressNextEscape());
    await page.keyboard.press('Escape');
    await pause(1500);
    // Run the seeded task, which passes the substituted `${input:target}` to build.sh
    // -- the payoff. If task enumeration hangs here forever, suspect the CDP browser
    // rather than code-server or this extension: see CONTRIBUTING.md's "Demo GIFs".
    await runCommand(page, 'Tasks: Run Task', { typeDelay: 20, pre: 260, post: 180, tail: 110, step: 70 });
    const taskRow = page.locator('.quick-input-list .monaco-list-row', { hasText: USAGE_TASK }).first();
    await taskRow.waitFor({ state: 'visible', timeout: 30000 });
    await pause(400);
    await page.keyboard.press('Enter');
    // Target `.xterm-screen` (xterm's rendered surface, created only when the terminal
    // opens) and do NOT swallow the timeout: an earlier `.xterm, .terminal` locator matched
    // a hidden container, so the flow raced past and the clip ended before the payoff.
    await page.locator('.xterm-screen').first().waitFor({ state: 'visible', timeout: 40000 });
    await pause(600); // let build.sh echo the substituted value into the terminal
    // the terminal shows "Building for aarch64" -- the payoff; hold so it reads
    await pause(2000);
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

const FLOW_FNS = { add: flowAdd, select: flowSelect, retrieve: flowRetrieve, runtask: flowRunTask, full: flowFull, usage: flowUsage };

// Off-camera warm-ups, run AFTER the window settles but BEFORE the recorder starts.
// The first `Tasks: Run Task` on a cold window spends seconds enumerating tasks; in a
// hero clip meant to last a few seconds that wait would dominate. Fetch the list once
// and dismiss the picker (never Enter -- running it here would leave the terminal open
// at clip start), so the on-camera invocation opens instantly.
async function warmUsageTasks(page) {
    await runCommand(page, 'Tasks: Run Task');
    await page.locator('.quick-input-list .monaco-list-row', { hasText: USAGE_TASK }).first().waitFor({ state: 'visible', timeout: 40000 });
    await page.keyboard.press('Escape');
    await sleep(800);
}

const FLOW_WARMUPS = { usage: warmUsageTasks };

// Pre-configure the workspace for the `usage` flow: a `target` param (shown
// with its name, defaulting to its first value) plus a `build` task that passes
// the selected value to build.sh. Written into the throwaway workspace copy BEFORE the window
// loads, so the flow starts from a ready parameter without running the wizard. The
// repo's demo-workspace ships `tasks: []` (which the `full` flow needs), so seeding
// it in place would clobber tracked files: refuse, and make the caller stage a copy.
function seedUsageWorkspace() {
    if (path.resolve(FOLDER) === REPO_WORKSPACE) {
        throw new Error("the 'usage' flow rewrites FOLDER's .vscode/; point FOLDER at a throwaway copy of demo-workspace (record-headless.sh does)");
    }
    const tasksPath = path.join(FOLDER, '.vscode', 'tasks.json');
    const seed = {
        version: '2.0.0',
        // Exactly one task, and deliberately without a `group: build` binding (despite the
        // label): the flow shows the plain Run Task picker, where this is then the only row,
        // rather than the Ctrl+Shift+B shortcut -- a less universal gesture to demo.
        // `process` + `args` is the substitution shape the README's opening example
        // teaches: one array element, one argument. demo-workspace/build.sh echoes
        // the argument back, so the terminal shows the selected value verbatim.
        tasks: [
            {
                label: USAGE_TASK,
                type: 'process',
                command: './build.sh',
                args: [SUB],
                problemMatcher: [],
            },
        ],
        inputs: [
            {
                id: PARAM.name,
                type: 'command',
                command: `statusBarParam.get.${PARAM.name}`,
                args: { values: PARAM.values, showName: true },
            },
        ],
    };
    fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
    fs.writeFileSync(tasksPath, JSON.stringify(seed, null, 4) + '\n');

    // Turn OFF task auto-detection in the throwaway copy. Otherwise opening the picker
    // first enumerates every task provider ("Fetching build tasks…" for several
    // seconds), which leaves dead air in a GIF meant to be short. With it off, only the
    // seeded `build` task exists and the picker opens instantly.
    // The settings file is jsonc (comments), so parse it accordingly; the copy is
    // throwaway, so re-emitting it as plain JSON loses nothing.
    const settingsPath = path.join(FOLDER, '.vscode', 'settings.json');
    let settings = {};
    try {
        settings = jsonc.parse(fs.readFileSync(settingsPath, 'utf8')) ?? {};
    } catch {
        settings = {};
    }
    Object.assign(settings, { 'task.autoDetect': 'off', 'npm.autoDetect': 'off', 'typescript.tsc.autoDetect': 'off' });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n');
    console.log('seeded usage workspace ->', tasksPath);
}

// --- main -------------------------------------------------------------------

async function main() {
    // seed the pre-configured parameter for the `usage` flow before the window loads --
    // and before connecting, so a bad FOLDER fails instantly instead of after a browser wake
    if (FLOWS.includes('usage')) seedUsageWorkspace();

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
        const warm = FLOW_WARMUPS[flow];
        if (warm) {
            console.log(`   warming up '${flow}' off-camera`);
            await warm(page);
        }
        // wipe any keystroke badge left over from the off-camera warm-up, so the clip
        // doesn't open on stray keycaps (the badge lingers ~1.3s after the last press)
        await page.evaluate(() => window.__clearKeys && window.__clearKeys());
        console.log(`>> recording flow: ${flow}`);
        const rec = new Recorder(cdp, path.join(OUT_DIR, `frames-${flow}`), VIEW);
        await rec.start();
        try {
            await fn(page);
            console.log(`   flow '${flow}' returned`);
        } catch (e) {
            await page.screenshot({ path: path.join(OUT_DIR, `error-${flow}.png`) }).catch(() => {});
            await rec.stop(path.join(OUT_DIR, `${flow}.mp4`)).catch(() => {});
            throw new Error(`flow '${flow}' failed: ${e.message}`);
        }
        const out = await rec.stop(path.join(OUT_DIR, `${flow}.mp4`));
        // AFTER stopping: a screenshot over CDP takes a moment, and taken while recording
        // it tacked that dead time onto the end of every clip.
        await page.screenshot({ path: path.join(OUT_DIR, `after-${flow}.png`) }).catch(() => {});
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
