# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Project Overview

Bun workspaces monorepo. Packages live under `projects/`.

- `projects/cli/` — `@coryrylan/cradle` CLI app (bin: `cradle`). See [`projects/cli/AGENTS.md`](./projects/cli/AGENTS.md) for package-specific guidance.
- `projects/docs/` — `@coryrylan/cradle-docs`, the Eleventy documentation site for `cradle`, built with the NVIDIA Elements (`nve-*`) UI design system. Build/lint via `bun run ci` in `projects/docs/`. Not released to npm, but its build depends on `projects/cli`'s build and statically deploys the CLI `install.sh` + platform binaries (`copy-cli-assets.js`) alongside the site — the documented primary install path.

## Tooling split

- **Root**: prettier, commitlint, husky, semantic-release config, [knip](https://knip.dev) (monorepo-aware via `knip.config.js` `workspaces`), monorepo orchestration via wireit. Catalog dev deps shared via Bun's workspaces `catalog`. Toolchain (bun + node) is pinned via `mise.toml` with checksums in `mise.lock`; CI installs it through `jdx/mise-action` in the shared `.github/actions/setup-ci` composite action.
- **Per-package**: ESLint, TypeScript, bunfig, source code, build outputs, install scripts. Each package has its own wireit graph.

## Common commands (run at root)

```bash
mise run install     # install pinned toolchain (bun, node) + workspace deps
mise run setup       # clean + install + full ci
bun install          # install deps for all workspaces
bun run ci           # format + lint:knip + per-package ci
bun run format       # prettier check across all packages
bun run format:fix   # prettier write
bun run lint:knip    # knip across all workspaces (unused files / deps / exports)
bun run release      # semantic-release per package (CI only)
```

To run package-scoped scripts, run them inside the package (e.g. `cd projects/cli && bun run build`) — bun's `--filter` runner does not set the npm-compatible env wireit requires, so wireit-wrapped scripts fail under it.

## Releases

- Single root `release.config.js` reads CWD's `package.json` to scope releases. Per-package `release.config.js` is a 1-line re-export.
- Currently only `@coryrylan/cradle` (`projects/cli`) is wired into the release pipeline. `@coryrylan/cradle-docs` is intentionally not released.
- Tag format: `<unscoped-name>-v<version>` (e.g. `cradle-v1.2.3`).
- Scope-gated: only commits with the package's scope trigger that package's release. `@coryrylan/cradle` uses scope `cli`.

## Commit Conventions

Enforced by commitlint (`@commitlint/config-conventional`):

- **Types**: `chore`, `feat`, `fix`
- **Scopes**: `ci`, `cli`, `docs`
- Subject: lower-case, no trailing period, max 100 chars

## Catalog dependencies

Shared dev deps (`@types/bun`, `@eslint/js`, `eslint`, `typescript`, `typescript-eslint`) are declared once at the root under `workspaces.catalog` with **exact** versions and referenced as `"catalog:"` in package `devDependencies`. New catalog entries must use exact versions (no `^`/`~`).
