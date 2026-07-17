# cradle

![CI Build](https://github.com/coryrylan/cradle/actions/workflows/pull-request.yml/badge.svg)

Bun workspaces monorepo for the `cradle` CLI and supporting docs.

## Packages

- [`projects/cli`](./projects/cli) — `cradle` CLI (bin: `cradle`).
- [`projects/docs`](./projects/docs) — documentation site placeholder.

## Agents

cradle runs portable agents defined as folders around the [pi](https://github.com/earendil-works/pi-mono) coding agent — see [ARCHITECTURE.md](./ARCHITECTURE.md) for the folder format and [`examples/hello`](./examples/hello) for a minimal agent.

## Common commands

```bash
bun install          # install deps for all workspaces
bun run ci           # format + per-package ci (lint + build + test:coverage)
bun run format       # prettier check across the monorepo
bun run format:fix   # prettier write
```

See per-package `README.md` files for package-specific commands and details.

## License

MIT
