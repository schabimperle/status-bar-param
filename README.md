# Status Bar Parameter

This vscode extension adds selectable parameter to the status bar (in the bottom), which can be stored and used in the following vscode configuration files:
* tasks.json (including user tasks)
* launch.json
* *.code-workspace

![Demo](./images/full_demo.gif)

The demo walks through the full workflow: **1.** add a parameter, **2.** select another value, and **3.** use it in a task.

<p></p>

## Additional Features
* Parameter names must be unique across all configuration files, as they share a single command namespace.
* Pick `Command` type when adding a parameter to parse the selection list dynamically from a shell command.
* Edit/Delete the entry at the input section of the configuration file to adjust/remove the parameter.
* Add `"canPickMany": true` to the `args` object of any status bar parameter to enable multiple selection.
* Add `initialSelection` to the `args` object of any status bar parameter to set an initial selection which gets used the first time the parameter gets loaded. Without it, the default initial selection is the first value for single selection (`canPickMany=false`), and no value when `canPickMany=true`.
* Use the string `${command:statusBarParam.get.<param_name>}` (instead of `${input:<param_name>}`) to reference the selected value of a parameter from any other vscode configuration file than the one it is defined in.