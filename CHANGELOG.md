# Change Log

All notable changes to the "status-bar-param" extension will be documented in this file.

## [1.9.0]

- Added an "Add Parameter to File" command: the per-file inline `+` on a tree node now uses its own command (`statusBarParam.addToFile`) that adds straight to that file, while the command-palette entry and the view-title `+` always prompt for the target file. This fixes the shared command silently skipping the file prompt, since VS Code hands the focused tree node to a view-title command. Also hardened revealing a parameter in the global user `tasks.json` (it now awaits the real opened document and surfaces an error if the open fails, instead of racing the active editor).
- Added an "insert an example to edit" mode to the add-parameter wizard: after the type pick you can either be guided through the value/option prompts as before, or have the wizard seed a complete, schema-valid example of the chosen value shape to edit directly in JSON, with a shape-aware how-to comment — handy for the named-output shape, whose value/key matrix is tedious to enter prompt by prompt. The example path still pre-checks named output keys against the existing command namespace (so a `${command:statusBarParam.get.<id>.<key>}` collision aborts before writing), and the how-to comment is written above the input for a document file or surfaced as a message for the user `tasks.json`, which can't embed comments.
- Ordered the file list in both the wizard's file picker and the tree view so local workspace config files come first, the `.code-workspace` next, and the global user `tasks.json` last (previously the user tasks file, registered first, appeared at the top even though the local files are the usual edit target).
- Refined the Marketplace categories, keywords, and extension description for discoverability.
- Fixed clicking the global user `tasks.json` in the Status Bar Parameter view failing with a "file does not exist" error in remote windows: its uri is a `vscode-userdata` placeholder that can't be opened directly, so the tree now opens it through the workbench (like the rest of the extension) instead of a bare `vscode.open` on that uri.
- Fixed the user `tasks.json` not opening after adding a parameter to it (e.g. an example inserted by the wizard, which is meant to be edited): the new parameter is now revealed and the file opened for editing, consistent with every other file. This is safe because adding always leaves at least one task, so opening never triggers VS Code's "create tasks.json from template" picker.

## [1.8.0]

- Added named (secondary) values: a value's `value` can be a map of named outputs (with a required `displayValue`), each retrievable via `${command:statusBarParam.get.<id>.<key>}`, so one selection can drive several outputs — for example a compiler picker feeding both `CC` and `CXX`. A keyless reference to a map resolves to an empty string with a warning. The add-parameter wizard can build named values too, via a new value-shape step (plain / display labels / named outputs) chosen before the values are entered. Plain/labelled and named values can't be mixed in one parameter, since a keyless reference has no meaning for a named entry. A named value's `displayValue` must be unique (the wizard enforces this), since `initialSelection` references that label rather than the value's opaque canonical-JSON identity. The optional sample task is offered for named values too, scaffolding a task that echoes each `${command:statusBarParam.get.<id>.<key>}` reference (instead of the keyless `${input:<id>}`, which is empty for a map), and the "Copy Reference" command offers each named output's `${command:…}` reference. (#10)
- Added a `joinSeparator` option to customize the string used to join multiple selected values when a parameter is substituted into a task (only relevant with `canPickMany`). It defaults to a single space, so existing behavior is unchanged. In the add-parameter wizard it's asked as a follow-up to enabling "select multiple values" (where it actually applies, rather than as a standalone advanced option), and backslash escapes you type there (`\n`, `\t`, `\r`, `\\`) are interpreted once and stored as the real character — the same as the command `separator`. When editing `args` directly, use the value verbatim (it isn't re-interpreted at substitution time, so write a real newline / `"\n"` rather than `"\\n"`).
- Documented that a substituted parameter is passed as a single argument (a value with spaces is not split), with the shell-command / `options.env` workarounds.
- Internal: hardened the new named-value handling — output keys are validated (and reserved prototype names rejected), the add-parameter wizard preflights the whole command-id namespace so a colliding id/key is caught before it's written, and a secondary-command registration clash is surfaced rather than silently dropped. Added a local pre-commit hook running the format/lint gates.

## [1.7.0]

- Added reliable support for parameters in the global user `tasks.json`, including in remote windows. Adding or removing a user-tasks parameter no longer triggers VS Code's "create tasks.json from template" picker.
- Reworked the add-parameter wizard: after the core steps (target file, type, id, values/command) an optional multi-select offers the advanced options — display labels, initial selection, status-bar name/value visibility, a command's working directory/separator, and a sample task — where selecting none keeps the defaults. When adding a parameter to a configuration file, a one-time inline comment also points to JSON IntelliSense for editing the `args` object directly.
- Preserved the existing indentation of a configuration file when inserting or editing a parameter, instead of re-flowing the touched properties.
- Fixed the status-bar coloring so a parameter with a selected value stands out while an empty one is dimmed (previously the inactive color could appear brighter, and an all-whitespace value rendered as active).
- Fixed editing a parameter jumping the cursor to the wrong position (now located by parameter id in the current document text), including in the user `tasks.json`.
- Fixed a custom command separator typed as an escape sequence (e.g. `\n`, `\t`) being written literally and never matching; escapes are now interpreted.
- Renamed the "Copy Retrieval String" command to "Copy Reference".
- Replaced the per-step demo GIFs with a single guided walkthrough (add → select → use in a task) and overhauled the README.
- Added an MIT license and project documentation (CONTRIBUTING, SECURITY).
- Internal: restructured the extension into modules, hardened core logic, and added a full unit, integration, and remote smoke-test suite plus CI.

## [1.6.0]

- Added parsing the 'initialSelection' value from the argument section of parameters, which can be used to set an initial selection.
- Fixed not parsing the inputs section of the 'launch' configuration of .code-workspace files.

## [1.5.0]

- Added hide options, globally and per parameter (showName/s, showSelection/s).
- Moved tree view to its own view container.

## [1.4.0]

- Added retrieving values from shell commands.
- Added option for multiple selection.
- Added tree view (tab in file explorer).
- Added commands to:
    - ... Edit a parameter.
    - ... Copy the retrieval string for a parameter.
    - ... Delete a parameter.
    - ... Select a parameter.
- Added json schema validation for input sections.
- Minor improvements and bugfixes.
    - Preselection of the last picked value in selection list.
    - Made adding sample task optional.
    - Added icons for array and command parameters.
    - Updated extension overview.

## [1.3.1]

- Added parsing inputs from launch.json.

## [1.3.0]

- Added parsing inputs from .code-workspace file.

## [1.2.4]

- Fixed "Feature Contributions" listing in extensions view of status bar param.

## [1.2.3]

- Fixed bug from 1.0.7.

## [1.2.0 - 1.2.2]

- Increased version accidentially. Unpublishing not possible...

## [1.0.7]

- Tried Fixing bug at loading inputs in tasks.json (didn't work).

## [1.0.6]

- Storing selection of status bar items in workspace instead of global storage.

## [1.0.5]

- Added setting to show the param names in the status bar.

## [1.0.4]

- Fixed multiple bugs with multi root workspaces.
- Added Workspace picker for adding inputs by command.
- Shortened command prefix for getting the selected value (`statusBarParam.getSelected.<name>` -> `statusBarParam.get.<name>`)

## [1.0.3]

- Added multi root

## [1.0.2]

- Added icon.

## [1.0.1]

- Updated Readme.

## [1.0.0]

- Initial release