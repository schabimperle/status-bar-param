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
- **Named (secondary) values** — make a value's `value` an object (with a required
  `displayValue` label) so one selection drives several named outputs, each fetched
  via `${command:statusBarParam.get.<id>.<key>}`. Many tools already provide this
  kind of indirection (e.g. CMake presets); reach for this when none fits. Example —
  a compiler picker feeding both `CC` and `CXX`:

  ```jsonc
  "args": {
      "values": [
          { "displayValue": "gcc",   "value": { "cc": "gcc",   "cxx": "g++" } },
          { "displayValue": "clang", "value": { "cc": "clang", "cxx": "clang++" } }
      ]
  }
  ```

  ```jsonc
  "options": {
      "env": {
          "CC":  "${command:statusBarParam.get.compiler.cc}",
          "CXX": "${command:statusBarParam.get.compiler.cxx}"
      }
  }
  ```

  A keyless reference (`${input:<id>}`) has no single value for a map and resolves
  to an empty string with a warning — always reference a key. The add-parameter
  wizard can build these too: pick **Named outputs** when it asks how to define the
  values, name the output keys once (e.g. `cc`, `cxx`), then give each selection a
  label and a value per key. A single parameter is wholly plain/labelled **or**
  named — the two can't be mixed, since a keyless reference would have no meaning for
  the named entries.
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
- **A substituted value is a single argument.** VS Code expands `${input:<name>}`
  / `${command:...}` to one string, and each element of a task's `args` array is
  passed as a single argument — so a value containing spaces is **not** split into
  several arguments (a multi-select join is one argument too). To turn one value
  into multiple arguments, reference it in a `shell` task's `command` string (the
  shell splits on spaces — mind quoting), or pass values through `options.env` or
  one `args` element each.
