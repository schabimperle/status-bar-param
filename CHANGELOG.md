# Change Log

All notable changes to the "status-bar-param" extension will be documented in this file.

## [1.9.1]

### Changed

- Refined the README demo GIF pacing: the advanced-options confirmation is tighter, the sample-task checkbox Space press is visible, and the final task output remains readable.

### Internal

- Updated dev tooling dependencies: `esbuild`, `eslint`, and `ovsx`.

## [1.9.0]

### Added

- **"Add Parameter to File" command** — the inline `+` on a tree node now adds straight to that file instead of silently skipping the target-file prompt.
- **"Insert an example to edit" wizard mode** — seed a complete, schema-valid example of the chosen value shape to tweak directly in JSON, with a how-to comment. Especially handy for named outputs.

### Changed

- **File lists ordered** local config → `.code-workspace` → global user `tasks.json`, in both the wizard picker and the tree.
- **Clearer `initialSelection` IntelliSense** — the schema now spells out how each value shape is referenced and offers completion examples.
- Refined Marketplace categories, keywords, and description.

### Fixed

- **Global user `tasks.json` opens in remote windows** — its `vscode-userdata` uri is now opened through the workbench instead of directly.
- **User `tasks.json` opens after adding a parameter**, consistent with every other file.

## [1.8.0]

### Added

- **Named (secondary) values** — a value's `value` can be a map of named outputs (with a required `displayValue`), each read via `${command:statusBarParam.get.<id>.<key>}`, so one selection drives several outputs (e.g. a compiler pick feeding both `CC` and `CXX`). The wizard builds them via a new value-shape step (plain / labelled / named). (#10)
- **`joinSeparator` option** — customize the string joining multiple selected values (only relevant with `canPickMany`; defaults to a single space, so existing behavior is unchanged).

### Changed

- Documented that a substituted parameter is passed as a single argument (a value with spaces is not split), with the shell-command / `options.env` workarounds.

### Internal

- Hardened named-value handling — output-key validation (reserved prototype names rejected), command-namespace preflight, and surfaced registration clashes. Added a pre-commit format/lint hook.

## [1.7.0]

### Added

- **Reliable global user `tasks.json` support**, including remote windows — adding or removing a parameter no longer triggers VS Code's "create tasks.json from template" picker.
- **Reworked add-parameter wizard** — an optional advanced multi-select (display labels, initial selection, status-bar visibility, command cwd/separator, sample task), where selecting none keeps the defaults. A one-time inline comment points to JSON IntelliSense for editing `args` directly.

### Changed

- Preserve a configuration file's existing indentation when inserting or editing a parameter.
- Renamed "Copy Retrieval String" → "Copy Reference".
- Replaced the per-step demo GIFs with a single guided walkthrough (add → select → use in a task); overhauled the README.
- Added an MIT license and project docs (CONTRIBUTING, SECURITY).

### Fixed

- Status-bar coloring — a selected value stands out while an empty one is dimmed (an all-whitespace value no longer renders as active).
- Editing a parameter no longer jumps the cursor to the wrong position (now located by id), including in the user `tasks.json`.
- A custom separator typed as an escape sequence (`\n`, `\t`) is now interpreted instead of written literally and never matching.

### Internal

- Restructured the extension into modules and added unit, integration, and remote smoke tests plus CI.

## [1.6.0]

### Added

- **`initialSelection`** parsed from a parameter's `args` to set an initial selection.

### Fixed

- Parse the `inputs` section of a `.code-workspace`'s `launch` configuration.

## [1.5.0]

### Added

- Hide options, global and per-parameter (`showName(s)`, `showSelection(s)`).

### Changed

- Moved the tree view to its own view container.

## [1.4.0]

### Added

- Retrieve values from shell commands.
- Multiple selection.
- Tree view (tab in the file explorer).
- Commands to edit, copy the reference for, delete, and select a parameter.
- JSON schema validation for input sections.

### Fixed

- Preselect the last picked value in the selection list.
- Made adding a sample task optional.
- Added icons for array and command parameters.

## [1.3.1]

- Parse `inputs` from `launch.json`, so a debug configuration's `${input:<id>}` can be driven from the status bar too.

## [1.3.0]

- Parse `inputs` from a `.code-workspace` file, so parameters declared in a multi-folder workspace are picked up alongside those in `tasks.json`.

## [1.2.4]

- Fixed the extension's "Feature Contributions" tab not listing its settings and commands in the Extensions view.

## [1.2.3]

- Fixed the long-standing bug from 1.0.7 — `inputs` defined in `tasks.json` failing to initialize on startup — for real this time.

## [1.2.0 - 1.2.2]

- No functional changes — the version was bumped accidentally and a published version can't be unpublished.

## [1.0.7]

- Attempted a fix for `inputs` in `tasks.json` not loading on startup (did not work; finally resolved in 1.2.3).

## [1.0.6]

- **Per-workspace selections** — a parameter's selected value is now stored in workspace state instead of global storage, so each workspace remembers its own choice.
- Switched to a JSONC-aware editor when modifying `tasks.json`, preserving existing comments.

## [1.0.5]

- Added a setting to show parameter names in front of their selected value in the status bar.

## [1.0.4]

### Added

- Workspace-folder picker when adding a parameter, so you choose which folder's `tasks.json` it lands in.

### Changed

- Shortened the get-selected command prefix (`statusBarParam.getSelected.<name>` → `statusBarParam.get.<name>`).

### Fixed

- Multiple bugs with multi-root workspaces.

## [1.0.3]

- Added multi-root workspace support — parameters are read from every workspace folder, not just the first.

## [1.0.2]

- Added an extension icon.

## [1.0.1]

- Updated the README.

## [1.0.0]

- **Initial release** — define a parameter as a `tasks.json` input and pick its value from a status-bar item, substituted into tasks via `${input:<id>}`. Includes a command to add a parameter through guided input-box prompts.
