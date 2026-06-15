// Injects two visual overlays that render into CDP screencast frames (where the
// OS cursor and key presses are otherwise invisible):
//   1. an arrow cursor that tracks the real mouse events Playwright dispatches,
//      with a click ripple;
//   2. a keystroke badge (bottom-centre) that flashes special keys / chords.
//
// Adapted from the classic puppeteer "mouse-helper" approach.

const HELPER = String.raw`
(() => {
  if (window.self !== window.top) return;            // skip webview iframes
  if (window.__overlaysInstalled) return;
  window.__overlaysInstalled = true;

  const install = () => {
    const style = document.createElement('style');
    style.textContent = ` + '`' + `
      /* Freeze the blinking text caret in quick-input boxes / inputs so a static
         hold collapses to one GIF frame instead of one per blink (the editor and
         terminal carets are frozen via the demo-workspace settings). Purely visual
         — typing/filtering still works; the typed text appears as before. */
      * { caret-color: transparent !important; }
      .__cursor {
        position: fixed; top: 0; left: 0; z-index: 2147483647;
        width: 20px; height: 28px; margin: 0; pointer-events: none;
        transition: transform .06s ease, opacity .3s ease; transform-origin: 0 0;
        filter: drop-shadow(1px 1px 1.5px rgba(0,0,0,.5));
      }
      .__cursor.__down { transform: scale(0.82); }
      .__ripple {
        position: fixed; z-index: 2147483646; pointer-events: none;
        width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%;
        border: 2px solid #4aa3ff; opacity: .9;
        animation: __rip .5s ease-out forwards;
      }
      @keyframes __rip { to { transform: scale(3); opacity: 0; } }
      @keyframes __pop { from { transform: scale(1.3); opacity: .45; } to { transform: scale(1); opacity: 1; } }
      .__keys {
        position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
        z-index: 2147483647; pointer-events: none;
        display: flex; gap: 8px; opacity: 1;
        transition: transform .45s ease, opacity .45s ease;
        font: 600 18px/1 -apple-system, Segoe UI, Roboto, sans-serif;
      }
      /* an old badge slides down and fades as the next one takes its place */
      .__keys.__exit { transform: translate(-50%, calc(-50% + 90px)); opacity: 0; }
      .__keycap {
        background: rgba(20,22,28,.92); color: #fff;
        border: 1px solid rgba(255,255,255,.25);
        border-bottom-width: 3px; border-radius: 8px;
        padding: 10px 14px; min-width: 14px; text-align: center;
        box-shadow: 0 4px 14px rgba(0,0,0,.45);
      }
      .__title {
        position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;
        display: flex; flex-direction: column; gap: 16px;
        align-items: center; justify-content: center;
        background: rgba(13,15,20,.97); opacity: 0; transition: opacity .35s;
        font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #fff;
      }
      .__title.__show { opacity: 1; }
      .__titlenum {
        width: 74px; height: 74px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 34px; font-weight: 700; background: #2b6fff; color: #fff;
        box-shadow: 0 6px 22px rgba(43,111,255,.5);
      }
      .__titletext { font-size: 30px; font-weight: 600; letter-spacing: .2px; }
    ` + '`' + `;
    document.head.appendChild(style);

    // --- arrow cursor (tip at the hotspot 0,0) ---
    const cur = document.createElement('div');
    cur.className = '__cursor';
    cur.innerHTML = ` + '`' + `
      <svg viewBox="0 0 20 28" width="20" height="28" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 2 L2 22 L7 17.5 L10.5 25 L13.5 23.7 L10 16.5 L17 16.5 Z"
              fill="#f5f5f5" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>` + '`' + `;
    document.body.appendChild(cur);

    const place = (x, y) => { cur.style.left = x + 'px'; cur.style.top = y + 'px'; };
    document.addEventListener('mousemove', (e) => place(e.clientX, e.clientY), true);
    document.addEventListener('mousedown', (e) => {
      cur.classList.add('__down');
      const r = document.createElement('div');
      r.className = '__ripple';
      r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 520);
    }, true);
    document.addEventListener('mouseup', () => cur.classList.remove('__down'), true);

    // --- keystroke badges: each "action" is its own badge element. When the
    //     next action's badge appears, the previous one slides down and fades. ---
    let hideT = null;
    let lastT = 0;
    let curBadge = null;   // the live badge element
    let curGroup = [];     // labels accumulated in the live badge
    let showNextBareSpace = false;
    const HOLD = 1300;     // how long a badge stays after the last press
    const GAP = 1300;      // presses closer than this group into one badge (one action)
    const SPECIAL = {
      Enter: '↵ Enter', Escape: 'Esc', Tab: 'Tab', Backspace: '⌫',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
      ' ': 'Space', Delete: 'Del',
    };
    const exitBadge = (b) => {
      if (!b) return;
      b.classList.add('__exit');           // transition down + fade
      setTimeout(() => b.remove(), 500);
    };
    // re-render the live badge; the LAST cap re-pops each press so repeated
    // identical keys (e.g. several Enters) stay visibly distinct.
    const renderBadge = () => {
      curBadge.innerHTML = curGroup.map((p) => '<span class="__keycap">' + p + '</span>').join('');
      const last = curBadge.lastElementChild;
      if (last) { last.style.animation = 'none'; void last.offsetWidth; last.style.animation = '__pop .2s ease-out'; }
    };
    document.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return;
      // A bare Space/Backspace/Delete is normally part of typing in this demo
      // (palette queries, editor text), not a standalone gesture. The recorder can
      // opt into showing exactly one bare Space when it toggles a checkbox.
      if (!e.ctrlKey && !e.altKey && !e.metaKey &&
          (k === 'Backspace' || k === 'Delete')) return;
      if (!e.ctrlKey && !e.altKey && !e.metaKey && k === ' ' && !showNextBareSpace) return;
      const mods = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.metaKey) mods.push('Cmd');
      if (e.shiftKey) mods.push('Shift');
      const special = SPECIAL[k] || (/^F\d+$/.test(k) ? k : null) || (k.length > 1 ? k : null);
      if (mods.length === 0 && !special) return;   // plain typing: ignore
      const label = (mods.length ? mods.join(' + ') + ' + ' : '') + (special || k.toUpperCase());
      if (!e.ctrlKey && !e.altKey && !e.metaKey && k === ' ') showNextBareSpace = false;
      const now = (window.performance && performance.now) ? performance.now() : Date.now();
      // a press after a long gap is a new action -> retire the old badge downward
      if (!curBadge || now - lastT > GAP || curGroup.length >= 10) {
        exitBadge(curBadge);
        curBadge = document.createElement('div');
        curBadge.className = '__keys';
        document.body.appendChild(curBadge);
        curGroup = [];
      }
      lastT = now;
      curGroup.push(label);
      renderBadge();
      clearTimeout(hideT);
      hideT = setTimeout(() => { exitBadge(curBadge); curBadge = null; curGroup = []; }, HOLD);
    }, true);

    // --- numbered section title cards (driven explicitly from the script) ---
    const title = document.createElement('div');
    title.className = '__title';
    title.innerHTML = '<div class="__titlenum"></div><div class="__titletext"></div>';
    document.body.appendChild(title);
    window.__showTitle = (num, text) => {
      title.querySelector('.__titlenum').textContent = num;
      title.querySelector('.__titletext').textContent = text;
      title.classList.add('__show');
      cur.style.display = 'none'; // hide the cursor instantly (no fade overlap on the heading)
      // clear any lingering keystroke badge so the heading is clean
      document.querySelectorAll('.__keys').forEach((b) => b.remove());
      curBadge = null; curGroup = []; clearTimeout(hideT);
    };
    window.__showNextBareSpace = () => { showNextBareSpace = true; };
    window.__hideTitle = () => {
      title.classList.remove('__show');
      // bring the cursor back only after the heading has fully faded out
      setTimeout(() => { cur.style.display = ''; }, 420);
    };
  };

  if (document.body) install();
  else document.addEventListener('DOMContentLoaded', install);
})();
`;

/** Install cursor + keystroke overlays; persists across navigations. Call before goto. */
export async function installOverlays(page) {
    await page.addInitScript(HELPER);
}
