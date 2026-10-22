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

- `develop` — the default branch and active development. Branch from it and
  open PRs against it; Dependabot (including security updates) lands here too.
- `master` — the published Marketplace version. Never commit here: the release
  workflow fast-forwards it to each release tag.

## Releasing

Releases are tag-driven: pushing a `v*` tag triggers
`.github/workflows/release.yml`, which runs the full CI on the tagged commit,
then publishes the packaged `.vsix` to the VS Marketplace and Open VSX, creates a
GitHub Release and fast-forwards `master` to the tag.

To cut a release, from `develop`:

```bash
npm version <patch|minor|major>   # bumps package.json + package-lock.json, commits, tags vX.Y.Z
git push --follow-tags            # pushes the commit AND the tag
```

Notes:

- **Use `npm version` — don't hand-edit the version.** It bumps `package.json`
  _and_ `package-lock.json` together and creates the matching `vX.Y.Z` tag in one
  step, keeping the project version consistent; the release job's first step
  verifies the tag equals `package.json`'s version. If a version was already
  hand-edited, re-sync the lock before tagging with
  `npm version <x.y.z> --allow-same-version --no-git-tag-version`, then commit
  both files and tag manually.
- The release workflow runs the full CI (`ci.yml`, every OS plus integration,
  remote smoke and packaging) on the tagged commit and publishes only if all of
  it passes, then fast-forwards `master` to the tag.
- Publishing needs the `VSCE_PAT` and `OVSX_PAT` repository secrets.

## Demo GIFs

The README's GIFs are produced end to end by `scripts/record-headless.sh`, which
builds the VSIX, launches a throwaway code-server over a copy of
`demo-workspace/`, drives it in a real browser and records via CDP screencast:

```bash
scripts/record-headless.sh usage            # short "how it's used" hero GIF
scripts/record-headless.sh full             # the guided three-part demo
scripts/record-headless.sh --install full   # also overwrite images/full_demo.gif
```

Besides `code-server`, it needs `ffmpeg` and `gifsicle` on `PATH` (muxing and GIF
optimisation), and a plain Chrome exposing a CDP endpoint — `CDP_URL`, defaulting
to `$CDP_ENDPOINT` and then to `http://127.0.0.1:9222`. The script's header
comment covers the rest.

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
