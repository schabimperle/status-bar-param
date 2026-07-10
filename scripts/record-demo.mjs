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
    cleanChrome, glideClick, smoothMove, showTitle, breakKeys, Recorder,
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
// Tuned for a README GIF: brisk between beats, but never faster than the viewer can read.
// A prompt or a picker's options need real time; a cursor crossing the screen does not.
// Keystroke separation no longer depends on idling (see breakKeys), so a hold here is only
// ever about reading, never about badge bookkeeping.
const BEAT = { READ: 900, READ_LED: 500, RESULT: 700, MIDBEAT: 800, KEY: 150, FINAL: 2600 };

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
    // retire the value-finishing Enter badge explicitly, so the ArrowDown run below reads
    // as its own gesture without having to idle past the badge's grouping window
    await breakKeys(page);
    await pause(BEAT.READ); // let the option list be read
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
    await pause(320);
    await page.evaluate(() => window.__showNextBareSpace && window.__showNextBareSpace());
    await page.keyboard.press('Space'); // toggle the "Add a sample task" checkbox
    // retire the Space badge; the confirm below is a mouse gesture and raises none of its own
    await breakKeys(page);
    await pause(600); // let the ticked checkbox register before confirming
    // confirm the multi-select by clicking its OK button with the mouse -- a visible,
    // deliberate finish (the keyboard alternative was an unlabelled Shift+Tab -> Enter).
    const okBtn = page.locator('.quick-input-widget .monaco-button', { hasText: 'OK' }).first();
    await glideClick(page, okBtn, { dur: 520, settle: 260 });
    // wait for the new status bar item to appear (file scanned), then a consistent beat
    await page.locator('.statusbar-item', { hasText: PARAM.values[0] }).first().waitFor({ state: 'visible', timeout: 15000 });
    await pause(BEAT.RESULT);
}

async function flowSelect(page) {
    // glide to our status bar item and click it (visible cursor + ripple)
    const item = page.locator('.statusbar-item', { hasText: PARAM.values[0] }).first();
    await glideClick(page, item, { dur: 600, settle: 300 });
    // Leave the status bar at once. Resting on the item pops its hover popup over the
    // open picker, which reads as an accident rather than a feature (and, being sticky
    // in code-server, comes back). Park low-left: clear of the picker, so no row hovers.
    await smoothMove(page, VIEW.width * 0.16, VIEW.height * 0.78, 260);
    // The value quick-pick opens with the current value (values[0], top row)
    // highlighted. Pick a different value with ARROW KEYS rather than the mouse:
    // the list keeps PARAM order, so PICK (=2) downs land on values[PICK].
    const target = page.locator('.quick-input-list .monaco-list-row', { hasText: PARAM.values[PICK] }).first();
    await target.waitFor({ state: 'visible', timeout: 12000 });
    await pause(BEAT.READ); // let the value list be read before navigating it
    await acceptQuick(page, { downs: PICK });
    // Move the cursor off the status bar and click into the editor: a "done selecting, back to
    // the file" gesture that also shifts focus off the item. (The item's focus-driven hover
    // popup -- which code-server would otherwise pop here -- is suppressed globally in the
    // overlay CSS, so no Escape/timing dance is needed; see mouse-helper.mjs.)
    await smoothMove(page, VIEW.width * 0.5, VIEW.height * 0.38, 300);
    await page.mouse.click(VIEW.width * 0.5, VIEW.height * 0.38);
    // brief hold on the settled result before section 3 takes over
    await pause(BEAT.RESULT);
}

async function flowRetrieve(page) {
    await runCommand(page, 'Status Bar Parameter: Copy Reference');
    await pause(BEAT.RESULT);
    // if a picker appears to choose which param, accept first
    if (await page.locator('.quick-input-widget').isVisible().catch(() => false)) {
        await acceptQuick(page);
    }
    await pause(1400);
}

// The wizard scaffolds the sample task's label after the PARAMETER, not the command (see
// jsonFile.ts buildSampleTask) — deliberately, since users swap the command for a real build
// step. The demo does exactly that, so it also renames the label on-camera to reflect the
// ./build.sh action. NEW_LABEL is what the editor shows after the rename and what Run Task lists.
const NEW_LABEL = `build for ${PARAM.name}`;
// `${input:...}` reference the task substitutes with the selected value.
const SUB = '${input:' + PARAM.name + '}';
// What the scaffolded task's `command` is rewritten to. The wizard leaves the
// parameter wired up in `args`, so swapping the command alone turns the sample into
// the README's opening example: `./build.sh ${input:target}`. No quotes or braces are
// typed, so the demo workspace's autoClosing* settings can't interfere.
const NEW_COMMAND = './build.sh';

// Label of the pre-seeded task the short `usage` flow runs (see seedUsageWorkspace).
const USAGE_TASK = 'build';

// Monaco wraps a line's tokens in one outer <span>; its box == the line's content box and
// its text == the whole line (incl. indentation), so column<->pixel is exact (monospace).
// Drag-select the pixel span [x0,x1] on the line matching `lineRe`, computing the columns
// via `pick(lineText)` -> {open, close} (character indices of the selection's edge quotes).
// Leaves the range selected (mouse up); the caller either types over it or just holds it as
// a visual highlight.
async function markSpan(page, lineRe, pick, { moveDur = 600, dragDur = 520 } = {}) {
    const lineSpan = page.locator('.view-line', { hasText: lineRe })
        .locator('span', { hasText: lineRe }).first();
    await lineSpan.scrollIntoViewIfNeeded();
    await lineSpan.waitFor({ state: 'visible', timeout: 12000 });
    const sb = await lineSpan.boundingBox();
    const lt = (await lineSpan.textContent()) || '';
    const charW = sb.width / lt.length;
    const { open, close } = pick(lt);
    const y = sb.y + sb.height / 2;
    // gaps just inside the edge quotes (nudge 0.25 col inward so it snaps the right way)
    const xStart = sb.x + (open + 1) * charW + charW * 0.25;
    const xEnd = sb.x + close * charW - charW * 0.25;
    // glide to the start (cursor continues from its last position), then drag to the end
    await smoothMove(page, xStart, y, moveDur);
    await pause(220);
    await page.mouse.down();
    await smoothMove(page, xEnd, y, dragDur);
    await page.mouse.up();
    await pause(450);
}

// A `"key": "value"` line: select the string BETWEEN the value's quotes (first " after the
// key's colon .. the line's last "). The caller matches on the VALUE so a same-named key
// elsewhere (e.g. the inputs section's own `"command"`) can't be picked by accident.
const pickValueString = (lt) => ({ open: lt.indexOf('"', lt.indexOf(':')), close: lt.lastIndexOf('"') });

// The "Add sample task?" step scaffolded an `echo` task whose `args` already reference the
// parameter, and opened tasks.json. Customize it like a human would, top-to-bottom: rename
// the label to fit the build step, swap `echo` for ./build.sh, then point out the parameter
// reference in `args` -- the value that gets substituted at run time.
async function flowCustomizeTask(page) {
    // 1) rename the label to reflect the build the task will run. The wizard names it
    //    "sample task using target" (parameter-first); make it read like the ./build.sh action.
    //    Match the line on `"label":` alone: Monaco renders the value's internal spaces as
    //    NON-breaking spaces, so a literal `sample task using target` in the pattern never
    //    matches -- and the key + colon already identify the line uniquely (pickValueString
    //    then finds the value's quotes from the full line text, nbsp and all).
    await markSpan(page, /"label":/, pickValueString);
    await page.keyboard.type(NEW_LABEL, { delay: 34 }); // type over the selection
    await pause(450);
    // 2) swap the sample's `echo` command for ./build.sh (the README's opening example). The
    //    wizard left the parameter wired into `args`, so changing the command alone is enough.
    await markSpan(page, /"command":\s*"echo"/, pickValueString);
    await page.keyboard.type(NEW_COMMAND, { delay: 34 }); // type over the selection
    await pause(450);
    // 3) highlight where the selected value flows in: drag-select the `${input:target}`
    //    reference in `args` and hold it, marked, as a visual pointer (no edit). The selection
    //    survives the save below, so it's still visible when Run Task fires.
    await markSpan(page, new RegExp(`\\$\\{input:${PARAM.name}\\}`), (lt) => {
        const tok = SUB, i = lt.indexOf(tok);
        return { open: lt.lastIndexOf('"', i), close: lt.indexOf('"', i + tok.length) };
    });
    await pause(650);
    await page.keyboard.press('Control+s'); // save so Run Task uses the new label + command
    await pause(650);
}

// Run the scaffolded (now customized) task, which passes the selected value to
// build.sh -- shows the parameter actually being used.
async function flowRunTask(page) {
    // a breather on the freshly customized task before we run it, so the jump from
    // "edited the task" to "run it" is easy to follow (mid-section, not a boundary)
    await pause(BEAT.MIDBEAT);
    await runCommand(page, 'Tasks: Run Task');
    await pause(650);
    // our configured task is listed first and pre-highlighted -- confirm with the
    // KEYBOARD instead of reaching the mouse up into the picker.
    const taskRow = page.locator('.quick-input-list .monaco-list-row', { hasText: NEW_LABEL }).first();
    await taskRow.waitFor({ state: 'visible', timeout: 12000 });
    // two pickers, two answers: keep this Enter out of the badge that ran the palette command
    await breakKeys(page);
    await pause(550);
    await page.keyboard.press('Enter');
    // the task opens a terminal and build.sh echoes "Building for <target>" -- wait for the
    // substituted value to land, then use the mouse to highlight it in the output: the payoff,
    // the selected value arriving where the task runs.
    await highlightTerminalValue(page, PARAM.values[PICK]);
    await pause(BEAT.FINAL);
}

// Highlight the substituted value where it lands in the terminal output. VS Code renders the
// terminal to a <canvas>, so there are no per-character DOM nodes to target -- but xterm still
// handles mouse selection on that canvas. So drag-select the payoff line geometrically: take
// the screen box from the DOM and the cell size from the terminal's own font metrics; the
// output line is `Building for <value>` (row 0 is the "Executing task" echo, row 1 blank).
async function highlightTerminalValue(page, value) {
    const screen = page.locator('.xterm-screen').first();
    await screen.waitFor({ state: 'visible', timeout: 40000 });
    await sleep(1400); // let build.sh's output line paint
    const m = await page.evaluate(() => {
        const el = document.querySelector('.terminal.xterm') || document.querySelector('.xterm');
        const cs = getComputedStyle(el);
        const ctx = document.createElement('canvas').getContext('2d');
        // force a MONOSPACE family: the terminal's real cell size, not the (proportional) UI
        // font that `.xterm`'s computed style otherwise reports, which over-measures 'M'.
        ctx.font = `${cs.fontSize} monospace`;
        const charW = ctx.measureText('mmmmmmmmmmmmmmmmmmmm').width / 20;
        const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.2);
        const r = document.querySelector('.xterm-screen').getBoundingClientRect();
        return { charW, lh, sx: r.x, sy: r.y };
    });
    const line = 'Building for ' + value;               // the payoff line's full text
    const row = 2;                                        // exec-echo, blank, then this output
    const y = m.sy + (row + 0.5) * m.lh;
    const x0 = m.sx + 2;                                  // just left of the text
    // Drag ~0.8 cell past the last char: the measured cell slightly under-estimates the real
    // one, so ending exactly at line.length*charW lands on the last char's left edge and clips
    // it (the '4' of aarch64 went unselected). The overshoot stays within the value's own cell.
    const x1 = m.sx + (line.length + 0.8) * m.charW;
    await pause(600); // let the output be read before pointing at it
    await smoothMove(page, x0, y, 500);
    await pause(180);
    await page.mouse.down();
    await smoothMove(page, x1, y, 520);                   // drag across the line -> xterm selects it
    await page.mouse.up();
    await pause(450);
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
    await pause(400);
    await glideClick(page, item, { dur: 520, settle: 320 });
    // pick a different value ("aarch64") with the keyboard (list keeps PARAM order).
    // Slightly brisker than the guided demo -- this clip has no title cards to pause on --
    // but the value list still has to be readable before the ArrowDowns move through it.
    const target = page.locator('.quick-input-list .monaco-list-row', { hasText: PARAM.values[PICK] }).first();
    await target.waitFor({ state: 'visible', timeout: 12000 });
    await acceptQuick(page, { downs: PICK, read: 700, step: 190 });
    // Move the cursor off the status bar, then dismiss its hover popup with Escape. The
    // hover is STICKY in code-server (it re-appears even with the mouse away) and would
    // otherwise linger over the terminal payoff. The Escape is functional only -- its
    // on-camera badge is suppressed, so the visible sequence stays "↓ ↓ ↵" and nothing
    // else. Then retire the value-pick badge, so the palette chord below opens a fresh
    // "⌃⇧P" one instead of merging into a run-on badge.
    await smoothMove(page, VIEW.width / 2, VIEW.height * 0.45, 400);
    await page.evaluate(() => window.__suppressNextEscape && window.__suppressNextEscape());
    await page.keyboard.press('Escape');
    await breakKeys(page);
    await pause(700);
    // Run the seeded task, which passes the substituted `${input:target}` to build.sh
    // -- the payoff. If task enumeration hangs here forever, suspect the CDP browser:
    // an automation browser that patches `window.Worker` browser-wide kills VS Code's
    // web extension host, and the task service then waits on it forever. Everything
    // else records fine, which makes it look like a code-server or extension bug.
    await runCommand(page, 'Tasks: Run Task', { typeDelay: 34, pre: 340, post: 240, tail: 160, step: 85 });
    const taskRow = page.locator('.quick-input-list .monaco-list-row', { hasText: USAGE_TASK }).first();
    await taskRow.waitFor({ state: 'visible', timeout: 30000 });
    // The Enter that opened Run Task and the Enter that picks the task answer two different
    // pickers. They fall inside the badge's grouping window, so retire the first badge to
    // keep them apart -- otherwise one badge reads "↵ Enter ↵ Enter", as if one gesture.
    await breakKeys(page);
    await pause(650);
    await page.keyboard.press('Enter');
    // Target `.xterm-screen` (xterm's rendered surface, created only when the terminal
    // opens) and do NOT swallow the timeout: an earlier `.xterm, .terminal` locator matched
    // a hidden container, so the flow raced past and the clip ended before the payoff.
    await page.locator('.xterm-screen').first().waitFor({ state: 'visible', timeout: 40000 });
    await pause(800); // let build.sh echo the substituted value into the terminal
    // the terminal shows "Building for aarch64" -- the payoff; hold so it reads
    await pause(2600);
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
    // Seeding leaves a configured parameter behind, and the flows share one window and one
    // FOLDER. `full` opens on the tree view's empty-state "Add Parameter" button, which a
    // seeded workspace no longer shows -- so it dies seconds in, long after `usage` reported
    // success. Record the flows in separate runs, each against a fresh workspace copy.
    if (FLOWS.length > 1) {
        throw new Error(`the 'usage' flow seeds the workspace and cannot share a run with ${FLOWS.filter((f) => f !== 'usage').join(', ')}; record them one flow at a time`);
    }
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
