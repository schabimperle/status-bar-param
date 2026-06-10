# Status Bar Parameter

Add selectable parameters to the status bar (bottom of the window) and reuse the
chosen value across your VS Code configuration files. Pick a value once in the
bar, and every task, launch config, or workspace input that references the
parameter uses it.

![Demo](./images/full_demo.gif)

The demo walks through the full workflow: **1.** add a parameter, **2.** select
another value, and **3.** use it in a task.

## Usage

1. **Add a parameter** from the status-bar param view (activity bar) or the
   `Status Bar Parameter: Add Parameter` command. A short wizard asks for the
   target file, the type, an id, and the values.
2. **Select a value** by clicking the item in the status bar, or with
   `Status Bar Parameter: Change Selection`.
3. **Use the value** in a configuration file via VS Code variable substitution:
   - `${input:<name>}` — within the file the parameter is defined in.
   - `${command:statusBarParam.get.<name>}` — from any other configuration file.

Parameters can be stored in, and referenced across:

- `tasks.json` (including the global user tasks)
- `launch.json`
- `*.code-workspace`

Selections persist across restarts, and the extension works in remote windows.

## Parameter types

- **Array** — choose from a fixed list of values.
- **Command** — populate the value list dynamically from a shell command's
  output (one value per line, or split on a custom `separator`). In an untrusted
  workspace the command is not executed; array parameters still work.

## Tree view

The **Status Bar Parameter** view in the activity bar lists every parameter
grouped by the file it lives in. From there you can add a parameter to a file,
change a selection, edit or delete a parameter, copy its reference, or reset all
selections at once.

## Advanced options

Configure these on a parameter's `args` object — either via the optional step in
the add wizard, or by editing the JSON directly (start typing inside `args` to
trigger IntelliSense):

- **`canPickMany`** — select multiple values at once.
- **`initialSelection`** — the value(s) applied the first time the parameter
  loads. Without it, a single-select parameter defaults to the first value and a
  multi-select to none.
- **`joinSeparator`** — the string used to join multiple selected values when the
  parameter is substituted into a task (only relevant with `canPickMany`).
  Defaults to a single space; backslash escapes (`\n`, `\t`, `\r`, `\\`) are
  interpreted.
- **Display labels** — write a value as
  `{ "value": "raw", "displayValue": "Label" }` to show a friendly label in the
  bar and picker while storing and returning the raw value.
- **`cwd` / `separator`** (command type) — the directory to run the command in,
  and the string used to split its output into values.
- **`showName` / `showSelection`** — override the global display settings for a
  single parameter.

## Settings

- `statusBarParam.showNames` (default `false`) — show each parameter's name in
  front of its value in the status bar.
- `statusBarParam.showSelections` (default `true`) — show the selected value in
  the status bar.

## Notes

- Parameter ids must be unique across all configuration files, as they share a
  single command namespace.
- To adjust or remove a parameter, edit or delete its entry in the `inputs`
  section of the configuration file (or use the tree view's actions).
