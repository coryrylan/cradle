# @coryrylan/cradle-docs

The Eleventy + [NVIDIA Elements](https://nvidia.github.io/elements/) documentation site for [`cradle`](../cli/), the runtime for portable agents defined as folders. Not published or released — it's built and deployed as a static site.

## Getting started

Install dependencies at the repo root, then run the dev server from this package:

```sh
bun install
cd projects/docs
bun run dev
```

Open http://localhost:8082/ to view the site.

## Tasks

| Command         | Description                                           |
| --------------- | ----------------------------------------------------- |
| `bun run dev`   | Start the local development server                    |
| `bun run build` | Generate the production site into `dist/`             |
| `bun run lint`  | Lint the JavaScript and TypeScript source with ESLint |
| `bun run ci`    | Run `lint` + `build` (used in CI)                     |

See the [Eleventy documentation](https://www.11ty.dev/docs/) for template, data, and configuration details.
