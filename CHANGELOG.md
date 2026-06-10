# Change Log

All notable changes to the "status-bar-param" extension will be documented in this file.

## [Unreleased]

- Added a `joinSeparator` option to customize the string used to join multiple selected values when a parameter is substituted into a task (only relevant with `canPickMany`). It defaults to a single space, so existing behavior is unchanged, and backslash escapes (`\n`, `\t`, `\r`, `\\`) are interpreted. It can be set via the add-parameter wizard's advanced options or by editing the `args` object directly.

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