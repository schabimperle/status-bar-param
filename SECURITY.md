# Security Policy

## Supported versions

Only the latest published version on the VS Marketplace is supported. Please
update before reporting an issue.

## Reporting a vulnerability

Please report security issues **privately**, not via public issues:

- Preferred: open a private report through GitHub
  ([Security advisories](https://github.com/Schabimperle/status-bar-param/security/advisories/new)).
- Or email the maintainer at <m.schababerle@gmail.com>.

Include steps to reproduce and the affected version. You'll get an
acknowledgement as soon as possible, and a fix will be released once confirmed.

## Scope

This extension parses your workspace and user `tasks.json` / `launch.json` /
`.code-workspace` files and, for command-type parameters, runs the shell command
you define. Shell-command parameters are **not** executed in untrusted
workspaces (see the extension's Workspace Trust capability). Be mindful of the
commands you put in parameters, as they run with your user permissions.

Note on timing: in a **trusted** workspace these commands run automatically to
populate the selectable values — including shortly after the window finishes
loading, not only when you open the parameter picker. So opening a trusted
workspace that already defines command-type parameters will run their shell
commands. Only trust workspaces whose `tasks.json` / `launch.json` /
`.code-workspace` parameter definitions you are comfortable executing.
