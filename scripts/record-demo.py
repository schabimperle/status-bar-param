#!/usr/bin/env python3
"""
Automated demo driver for the Status Bar Parameter README GIFs.

Drives VS Code with smooth, eased mouse movement and human-cadence typing so the
recorded clips look natural. Recording and GIF conversion are NOT done here --
start your screen recorder first, run a flow, then convert with scripts/make-gif.sh.

Usage:
    python3 scripts/record-demo.py <flow> [--countdown N]

    flow = select | add | retrieve | full

Flows map to the README assets:
    select   -> images/demo_select.gif    (change the selected value)
    add      -> images/demo_add.gif        (statusBarParam.add)
    retrieve -> images/demo_retrieve.gif   (copy/use the retrieval string)
    full     -> images/full_demo.gif       (all of the above, back to back)

Setup:
    Linux (X11 session required -- see notes at the bottom):
        pip install pyautogui
        sudo apt install scrot python3-tk python3-dev
    macOS:
        pip install pyautogui          # pulls in pyobjc automatically
        # Grant Accessibility AND Screen Recording permission to whatever runs
        # this (Terminal/iTerm/VS Code): System Settings > Privacy & Security.
        # Without Accessibility, pyautogui silently fails to move/type.

IMPORTANT: tune the COORDS below to your screen/layout before recording.
Run with --probe to print the live cursor position while you hover over the
target (status bar item, palette, etc.) and copy the numbers in.
"""

import argparse
import platform
import random
import sys
import time

try:
    import pyautogui
except ImportError:
    sys.exit("pyautogui not installed -- run: pip install pyautogui")

# Fail-safe: slam the mouse into a screen corner to abort the script.
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.3           # settle time after every action
pyautogui.MINIMUM_DURATION = 0  # allow short eased moves

# Primary modifier: Cmd on macOS, Ctrl elsewhere (palette, paste, etc.).
MOD = "command" if platform.system() == "Darwin" else "ctrl"

# --- Tune these to YOUR layout (use --probe to find them) --------------------
COORDS = {
    "status_bar_item": (960, 1050),  # the parameter shown in the status bar
    "treeview_item": (150, 300),     # the Status Bar Parameter view/item in the sidebar
    "add_icon": (300, 1050),         # the "+" Add Parameter icon on the view toolbar
    "editor_center": (960, 540),     # somewhere neutral in the editor
}

PARAM_NAME = "my-parameter"
PARAM_VALUES = ["alpha", "beta", "gamma"]
# -----------------------------------------------------------------------------


def smooth_move(x, y, dur=1.0):
    """Eased cursor glide -- looks natural instead of teleporting."""
    pyautogui.moveTo(x, y, duration=dur, tween=pyautogui.easeInOutQuad)


def click_at(name, dur=1.0, settle=0.5):
    x, y = COORDS[name]
    smooth_move(x, y, dur)
    time.sleep(settle)
    pyautogui.click()
    time.sleep(settle)


def human_type(text, wpm=300):
    """Type with small per-keystroke jitter so it reads as a person typing."""
    base = 60 / (wpm * 5)
    for ch in text:
        pyautogui.write(ch)
        time.sleep(max(0.0, base + random.uniform(-0.02, 0.06)))


def palette(command_title):
    """Open the Command Palette and run a command by its title. Keyboard-driven
    palette navigation always looks crisp -- reserve mouse moves for the status bar."""
    pyautogui.hotkey(MOD, "shift", "p")
    time.sleep(0.6)
    human_type(command_title)
    time.sleep(0.6)
    pyautogui.press("enter")
    time.sleep(0.8)


def quickpick(value):
    """Type into an open QuickPick / input box and confirm."""
    human_type(value)
    time.sleep(0.5)
    pyautogui.press("enter")
    time.sleep(0.8)


# --- Flows -------------------------------------------------------------------

def flow_add():
    """Add a parameter via the command palette."""
    # Focus the Status Bar Parameter view first so its toolbar "+" is shown,
    # then click the add icon to start the wizard.
    click_at("treeview_item", dur=1.0)
    click_at("add_icon", dur=0.8)
    quickpick(PARAM_NAME)            # name prompt
    for v in PARAM_VALUES[:-1]:      # value entries
        quickpick(v)
    human_type(PARAM_VALUES[-1])     # last value
    time.sleep(0.4)
    pyautogui.press("enter")
    time.sleep(0.4)
    pyautogui.press("enter")         # confirm / finish list
    time.sleep(1.0)


def flow_select():
    """Change the selected value by clicking the status bar item."""
    click_at("status_bar_item", dur=1.2)
    time.sleep(0.5)
    # QuickPick of values is now open -- arrow to a different value and confirm.
    pyautogui.press("down")
    time.sleep(0.5)
    pyautogui.press("down")
    time.sleep(0.5)
    pyautogui.press("enter")
    time.sleep(1.0)


def flow_retrieve():
    """Copy the retrieval string for the parameter, then show it being used."""
    palette("Status Bar Parameter: Copy Retrieval String")
    time.sleep(0.6)
    # If multiple params exist, a QuickPick appears -- pick the first.
    pyautogui.press("enter")
    time.sleep(0.8)
    # Demonstrate pasting it somewhere (e.g. tasks.json) -- adjust as needed.
    click_at("editor_center", dur=1.0)
    pyautogui.hotkey(MOD, "v")
    time.sleep(1.2)


def flow_full():
    flow_add()
    time.sleep(1.0)
    flow_select()
    time.sleep(1.0)
    flow_retrieve()


FLOWS = {
    "add": flow_add,
    "select": flow_select,
    "retrieve": flow_retrieve,
    "full": flow_full,
}


def probe():
    """Print the live cursor position so you can fill in COORDS."""
    print("Move the cursor over a target; Ctrl+C to stop.")
    try:
        while True:
            x, y = pyautogui.position()
            print(f"\r x={x:5d}  y={y:5d}", end="", flush=True)
            time.sleep(0.05)
    except KeyboardInterrupt:
        print()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("flow", nargs="?", choices=sorted(FLOWS), help="which demo to run")
    ap.add_argument("--countdown", type=int, default=4,
                    help="seconds to focus VS Code before the flow starts")
    ap.add_argument("--probe", action="store_true",
                    help="print live cursor coords and exit (to fill in COORDS)")
    args = ap.parse_args()

    if args.probe:
        probe()
        return
    if not args.flow:
        ap.error("a flow is required (or use --probe)")

    print(f"Focus VS Code now. Starting '{args.flow}' in {args.countdown}s...")
    for i in range(args.countdown, 0, -1):
        print(f"\r {i} ", end="", flush=True)
        time.sleep(1)
    print("\rgo!   ")
    FLOWS[args.flow]()
    print("done.")


if __name__ == "__main__":
    main()
