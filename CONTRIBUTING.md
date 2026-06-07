# Contributing

Thanks for your interest in improving **Status Bar Parameter**! This is a small
VS Code extension; the workflow is intentionally simple.

## Getting set up

```bash
npm ci          # install dependencies
npm run compile # type-check + build to out/ (also copies the JSON schemas)
```

Open the folder in VS Code and press <kbd>F5</kbd> to launch an Extension
Development Host with the extension loaded.

## Branch model

- `master` — the published Marketplace version. Don't commit here directly.
- `develop` — active development. Branch from it and open PRs against it.

Releases are cut by bumping the version with `npm version` and pushing the
resulting `v*` tag, which triggers `.github/workflows/release.yml` to package and
publish to the VS Marketplace and Open VSX.

## Checks (must stay green)

CI runs these on every PR; run them locally before pushing:

```bash
npm run lint            # ESLint
npm run format:check    # Prettier formatting check
npm test                # Jest unit suite (headless, jest-mock-vscode)
npm run test:coverage   # unit suite + coverage ratchet (jest.config.js)
npm run test:integration # real-host smoke (needs a display; use xvfb-run -a on Linux)
npm run package         # vsce packaging dry-run
```

A genuine remote-window smoke test also runs in CI
(`npm run test:integration:remote`); it needs an SSH server and is not usually
run locally.

### Code style

Formatting is enforced by **Prettier** (`npm run format` to apply,
`npm run format:check` to verify; CI runs the check). ESLint handles lint rules,
with `eslint-config-prettier` disabling the formatting rules that would conflict.
`.editorconfig` covers the basics (UTF-8, LF, final newline, no trailing
whitespace).

## Tests

New behavior needs tests. Fast logic and UI flows are unit-tested with
`jest-mock-vscode` under `src/test/unit/`; genuine `vscode` API behavior is
covered by the smoke layers under `src/test/integration/`. Keep the coverage
ratchet from regressing.
