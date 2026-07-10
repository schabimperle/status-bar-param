// Helpers for driving VS Code (code-server) in a browser via Playwright,
// plus a CDP-screencast recorder. Designed for a remote CDP browser
// (connectOverCDP), where Playwright's built-in recordVideo is unavailable.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Navigation pacing: slows mouse glides and inter-step pauses (NOT typing).
// Override with NAV_PACE env (1 = original speed, 2 = half speed).
export const NAV = Number(process.env.NAV_PACE || 1);
/** A navigation pause that scales with NAV (use for "settle" waits, not typing). */
export const pause = (ms) => sleep(ms * NAV);

/**
 * Retire the live keystroke badge, so the next press opens a fresh one. Each helper below
 * calls this before its FIRST press: a helper is one gesture (answer this prompt, run this
 * command), and a gesture is one badge. Without it, gestures whose presses happen to fall
 * within the badge's ~1.3s grouping window merge into a single run-on badge — three separate
 * value confirmations rendering as "↵ Enter ↵ Enter ↵ Enter" on one line, rather than each
 * badge retiring downward as the next replaces it.
 */
export const breakKeys = (page) => page.evaluate(() => window.__breakKeys && window.__breakKeys());

/**
 * A short, deliberate break before confirming, so the filled state is readable: just long
 * enough to see WHAT is being confirmed (the highlighted row, the typed text). Callers that
 * need the prompt read first already held for that, so this stays short — it used to be
 * 700ms and double-counted their hold on every single Enter.
 */
export async function pressEnter(page, { pre = 300 } = {}) {
    await pause(pre);
    await page.keyboard.press('Enter');
}

// track the cursor position so glides ease from where it actually is
let _mx = 640, _my = 360;

/** Wait for the workbench shell and a settled extension host. */
export async function waitForWorkbench(page, timeout = 60000) {
    await page.waitForSelector('.monaco-workbench', { timeout });
    // status bar present == shell laid out
    await page.waitForSelector('.statusbar', { timeout });
}

// Command Palette chord: Cmd+Shift+P on macOS, Ctrl+Shift+P elsewhere.
const PALETTE_CHORD = process.platform === 'darwin' ? 'Meta+Shift+KeyP' : 'Control+Shift+KeyP';

/** Open the Command Palette and run a command by its exact visible title. */
// Pacing knobs let a clip deviate from the default rhythm where it needs to. The defaults
// aim at "legible but never idle": typing is fast enough to skim, and only the moments that
// must be READ get a hold (see BEAT in record-demo.mjs).
export async function runCommand(page, title, { typeDelay = 38, pre = 380, post = 260, tail = 180, step = 90 } = {}) {
    // The chord opens the palette already in command mode ('>' prefilled), so we
    // don't type the '>' ourselves. Reset the value to a bare '>' to drop any
    // remembered query (e.g. a previous command) while staying in command mode.
    await breakKeys(page); // the chord starts a new gesture, whatever preceded it
    await page.keyboard.press(PALETTE_CHORD);
    const input = page.locator('.quick-input-box input');
    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.fill('>');
    await page.waitForTimeout(pre); // let the palette register before typing
    // last segment is the most distinctive part (e.g. "Add Parameter")
    const needle = (title.includes(':') ? title.split(':').pop().trim() : title).toLowerCase();
    await page.keyboard.type(title, { delay: typeDelay }); // readable typing cadence
    const rows = page.locator('.quick-input-list .monaco-list-row');
    await rows.first().waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(post);
    // Drive the palette with the KEYBOARD only -- never click a row, so the
    // cursor can't jump up into the picker. Fuzzy ranking can put the exact
    // command below the top, so arrow down to the matching row, then Enter.
    const count = await rows.count();
    let idx = 0;
    for (; idx < count; idx++) {
        const txt = ((await rows.nth(idx).textContent().catch(() => '')) || '').toLowerCase();
        if (txt.includes(needle)) break;
    }
    if (idx >= count) idx = 0; // not found among rendered rows: fall back to the top hit
    for (let i = 0; i < idx; i++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(step);
    }
    await page.waitForTimeout(tail);
    // opening the palette and confirming the command are two gestures, two badges
    await breakKeys(page);
    await page.keyboard.press('Enter');
}

/** Current Quick Input prompt text (message or placeholder), for sequencing. */
export async function quickPrompt(page) {
    const w = page.locator('.quick-input-widget');
    await w.waitFor({ state: 'visible', timeout: 10000 });
    const ph = await page.locator('.quick-input-box input').getAttribute('placeholder').catch(() => '');
    const msg = await page.locator('.quick-input-message').textContent().catch(() => '');
    return ((ph || '') + ' ' + (msg || '')).trim();
}

/** Wait until the quick-input prompt contains `substr` (case-insensitive). */
export async function waitForPrompt(page, substr, timeout = 10000) {
    const needle = substr.toLowerCase();
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const t = (await quickPrompt(page)).toLowerCase();
        if (t.includes(needle)) {
            console.log(`   prompt: "${substr}"`);
            return true;
        }
        await sleep(150);
    }
    throw new Error(`quick-input prompt never contained: "${substr}"`);
}

/** Type into the quick-input box with human cadence, then optionally Enter. */
export async function typeQuick(page, text, { enter = true, delay = 46, read = 560 } = {}) {
    const input = page.locator('.quick-input-box input');
    await input.waitFor({ state: 'visible', timeout: 10000 });
    await pause(read); // let the prompt be read before text appears
    await page.keyboard.type(text, { delay });
    // typed characters raise no badge, so the previous answer's Enter is still the live one
    if (enter) await breakKeys(page);
    if (enter) await pressEnter(page);
    else await pause(300);
}

/** Accept the currently highlighted quick-pick item (first by default). */
export async function acceptQuick(page, { downs = 0, read = 950, step = 180 } = {}) {
    await breakKeys(page); // this answer is its own gesture: ArrowDowns + Enter, one badge
    await pause(read); // give time to read the question before answering
    for (let i = 0; i < downs; i++) {
        await page.keyboard.press('ArrowDown');
        await pause(step); // keep ArrowDown + Enter within one keystroke badge
    }
    await pressEnter(page);
}

/** Show a numbered full-screen title card, hold, then fade it out. */
export async function showTitle(page, num, text, { hold = 1400 } = {}) {
    await page.evaluate(([n, t]) => window.__showTitle && window.__showTitle(n, t), [String(num), text]);
    await sleep(380 + hold); // fade-in + hold
    await page.evaluate(() => window.__hideTitle && window.__hideTitle());
    await sleep(420); // fade-out
}

/** Eased, time-based mouse glide so motion reads naturally (scaled by NAV). */
export async function smoothMove(page, x, y, durMs = 520) {
    const d = durMs * NAV * 0.5; // ~2x faster pointer travel
    const steps = Math.max(14, Math.round(d / 18));
    const x0 = _mx, y0 = _my;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
        await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
        await sleep(d / steps);
    }
    _mx = x; _my = y;
}

/** Glide the cursor to an element's centre and click it (visible cursor + ripple). */
export async function glideClick(page, locator, { dur = 520, settle = 300 } = {}) {
    await locator.waitFor({ state: 'visible', timeout: 12000 });
    const b = await locator.boundingBox();
    if (!b) throw new Error('glideClick: element has no bounding box');
    await smoothMove(page, b.x + b.width / 2, b.y + b.height / 2, dur);
    await pause(settle);
    await locator.click();
    await pause(settle);
}

/** Strip distractions: clear notifications + hide the secondary (chat) side bar. */
export async function cleanChrome(page) {
    // close any open notifications/toasts
    await page.keyboard.press('Escape');
    await runCommand(page, 'Notifications: Clear All Notifications');
    await sleep(400);
    // hide the secondary side bar (chat) if it is showing
    const aux = page.locator('.part.auxiliarybar');
    if (await aux.isVisible().catch(() => false)) {
        await runCommand(page, 'View: Toggle Secondary Side Bar Visibility');
        await sleep(400);
    }
    await page.keyboard.press('Escape');
}

// ---------------------------------------------------------------------------
// CDP screencast recorder: collects JPEG frames with timestamps, then muxes
// them into a correctly-timed mp4 via ffmpeg (pauses become long frames).
// ---------------------------------------------------------------------------
export class Recorder {
    constructor(cdp, framesDir, { width = 1280, height = 720 } = {}) {
        this.cdp = cdp;
        this.dir = framesDir;
        this.width = width;
        this.height = height;
        this.frames = [];
        this._onFrame = null;
    }

    async start() {
        fs.rmSync(this.dir, { recursive: true, force: true });
        fs.mkdirSync(this.dir, { recursive: true });
        this.frames = [];
        this._onFrame = async (e) => {
            const file = path.join(this.dir, `f${String(this.frames.length).padStart(5, '0')}.png`);
            try {
                fs.writeFileSync(file, Buffer.from(e.data, 'base64'));
                this.frames.push({ file, t: e.metadata.timestamp });
                await this.cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId });
            } catch { /* frame dropped */ }
        };
        this.cdp.on('Page.screencastFrame', this._onFrame);
        // PNG = lossless capture (no JPEG artifacts on the dark UI / text)
        await this.cdp.send('Page.startScreencast', {
            format: 'png', everyNthFrame: 1,
            maxWidth: this.width, maxHeight: this.height,
        });
    }

    /** Stop and mux to `outMp4`. Returns the mp4 path (or null if no frames). */
    async stop(outMp4) {
        console.log('   [rec] stopping screencast...');
        try { await this.cdp.send('Page.stopScreencast'); } catch { /* */ }
        if (this._onFrame) this.cdp.off('Page.screencastFrame', this._onFrame);
        console.log(`   [rec] muxing ${this.frames.length} frames -> ${outMp4}`);
        if (this.frames.length < 2) return null;

        // Build a concat list with per-frame durations from frame timestamps, so the clip
        // plays back at the speed it was driven at. The floor only guards a zero/negative
        // delta (identical timestamps): a 1/30s floor looks harmless but silently STRETCHES
        // every burst faster than 30fps -- and Chrome screencasts motion at up to ~60fps, so
        // cursor glides and typing were replayed at half speed, inflating a 40s take to 52s.
        const lines = ['ffconcat version 1.0'];
        for (let i = 0; i < this.frames.length; i++) {
            const cur = this.frames[i];
            const next = this.frames[i + 1];
            const dur = next ? Math.max(1 / 240, next.t - cur.t) : 0.7; // tail hold
            lines.push(`file '${path.resolve(cur.file)}'`);
            lines.push(`duration ${dur.toFixed(4)}`);
        }
        // repeat last frame so its duration is honored
        lines.push(`file '${path.resolve(this.frames.at(-1).file)}'`);
        const listPath = path.join(this.dir, 'concat.txt');
        fs.writeFileSync(listPath, lines.join('\n'));

        const r = spawnSync('ffmpeg', [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'concat', '-safe', '0', '-i', listPath,
            '-vf', 'fps=15,format=yuv420p',
            '-movflags', '+faststart',
            outMp4,
        ], { stdio: 'inherit' });
        if (r.status !== 0) throw new Error('ffmpeg mux failed');
        return outMp4;
    }
}
