# Status Bar Parameter

Add selectable parameters to the status bar (bottom of the window) and reuse the
chosen value across your VS Code configuration files. Pick a value once in the
bar, and every task, launch config, or `.code-workspace` entry that references the
parameter uses it.

![Demo: add, select, and use a status-bar parameter](./images/full_demo.gif)

The demo walks through the full workflow: **1.** add a parameter, **2.** select
another value, and **3.** use it in a task.

## Usage

1. **Add a parameter** from the status-bar param view (activity bar) or the
   `Status Bar Parameter: Add Parameter` command. The wizard asks for the target
   file, type, id, and values; advanced options are optional. Right after the type,
   it offers to either guide you through the values or **insert a complete example
   to edit in JSON** — handy for the named-output shape, which is quicker to tweak
   in the file than to enter prompt by prompt.
2. **Select a value** by clicking the item in the status bar, or with
   `Status Bar Parameter: Change Selection`.
3. **Use the value** in a configuration file via VS Code variable substitution:
   - `${input:<id>}` — from the same `tasks`/`launch` input scope that defines it.
   - `${command:statusBarParam.get.<id>}` — from any other configuration file.

Parameters can be stored in, and referenced across:

- `tasks.json` (including the global user tasks)
- `launch.json`
- `*.code-workspace`

Selections persist across restarts, and the extension works in remote windows.

## Parameter types

- **Array** — choose from a fixed list of values.
- **Command** — populate the value list dynamically from a shell command's
  output (one value per line, or split on a custom `separator`).

## JSON examples

The wizard writes VS Code `inputs` entries like these. For the extension to pick
up a parameter, keep `type` as `"command"` and keep `command` in the form
`statusBarParam.get.<id>`, matching the `id`. In the first example, only the
`environment` parts are meant to change. Configure everything else under `args`;
IntelliSense is available there.

```jsonc
"inputs": [
    {
        "id": "environment",
        "type": "command",
        "command": "statusBarParam.get.environment",
        "args": ["dev", "staging", "prod"]
    },
    {
        "id": "branch",
        "type": "command",
        "command": "statusBarParam.get.branch",
        "args": {
            "shellCmd": "git branch --format=%(refname:short)"
        }
    }
]
```

## Value shapes

An array parameter's values are defined in the wizard right after the type, or by
editing `values` directly. Plain and display-labelled values can be mixed. Named
values cannot be mixed with either, because a keyless reference has no single
value to return for a named entry.

- **Plain** — a bare string, shown in the bar and returned as-is.
  Example: `"values": ["dev", "staging", "prod"]`.
- **Display labels** — `{ "value": "raw", "displayValue": "Label" }` shows a
  friendly label in the bar and picker while storing and returning the raw value.
  Example: `{ "value": "prod-us-east-1", "displayValue": "Production (US East)" }`.
- **Named (secondary) values** — make `value` a map of named outputs (with a
  required `displayValue`), so one selection drives several outputs, each fetched
  via `${command:statusBarParam.get.<id>.<key>}`. A keyless reference resolves to
  an empty string (with a warning), so always reference a key. The `displayValue`
  must be unique among the values: it is what `initialSelection` references (a
  named value has no single string to match on). For example, a compiler picker
  feeding both `CC` and `CXX`:

  ```jsonc
  {
      "id": "compiler",
      "type": "command",
      "command": "statusBarParam.get.compiler",
      "args": {
          "values": [
              { "displayValue": "gcc",   "value": { "cc": "gcc",   "cxx": "g++" } },
              { "displayValue": "clang", "value": { "cc": "clang", "cxx": "clang++" } }
          ]
      }
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

## Tree view

The **Status Bar Parameter** view in the activity bar lists every parameter
grouped by the file it lives in. From there you can add a parameter to a file,
change a selection, edit or delete a parameter, copy its reference, or reset all
selections at once.

## Advanced options

Configure these on a parameter's `args` object — either via the optional step in
the add wizard, or by editing the JSON directly (start typing inside `args` to
trigger IntelliSense):

- **`canPickMany`** — select multiple values at once; the picker shows checkboxes.
  Example: `"canPickMany": true`.
- **`joinSeparator`** — the output separator used to join selected values when the
  parameter is substituted (only relevant with `canPickMany`; defaults to a single
  space). Used verbatim: the wizard interprets a typed escape (`\n`, `\t`, `\r`,
  `\\`) once and stores the real character, so when editing `args` directly write a
  real newline (`"\n"`), not `"\\n"`. Example: `"joinSeparator": ", "`.
- **`initialSelection`** — the value(s) applied when no selection is stored, such
  as first load or after reset. Without it, a single-select parameter defaults to
  the first value and a multi-select to none. Example:
  `"initialSelection": "staging"` (or an array of values with `canPickMany`). For
  display-labelled values reference the underlying `value`; for named (map) values
  reference the `displayValue` label (e.g. `"initialSelection": "gcc"`).
- **`cwd` / `separator`** (command type) — the directory to run the command in, and
  the input separator used to split command output into values (defaults to
  newlines). `separator` parses command output; `joinSeparator` joins selected
  values during substitution.
  Example: `"cwd": "scripts", "separator": ","`.
- **`showName` / `showSelection`** — override the global [display settings](#settings)
  for a single parameter. Example: `"showName": true`.

## Settings

- `statusBarParam.showNames` (default `false`) — show each parameter's name in
  front of its value in the status bar. A parameter with nothing selected (e.g. a
  multi-select with no choice yet, or a command with empty output) always shows its
  greyed name as a fallback, regardless of this setting, so the item stays
  identifiable instead of rendering blank.
- `statusBarParam.showSelections` (default `true`) — show the selected value in
  the status bar.

## Notes

- Parameter ids must use only letters, digits, `_`, `.`, or `-`, and must be
  unique across all configuration files because they share one command namespace.
- To adjust or remove a parameter, edit or delete its entry in the `inputs`
  section of the configuration file (or use the tree view's actions).
- **A substituted value is a single argument.** VS Code expands `${input:<name>}`
  / `${command:...}` to one string, and each element of a task's `args` array is
  passed as a single argument — so a value containing spaces is **not** split into
  several arguments (a multi-select join is one argument too). To turn one value
  into multiple arguments, reference it in a `shell` task's `command` string (the
  shell splits on spaces — mind quoting), or pass values through `options.env` or
  one `args` element each.
