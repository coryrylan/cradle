# @coryrylan/cradle-docs — Elements + Eleventy integration

This file only covers how `projects/docs` wires Elements into Eleventy. For component APIs, template validation, and project setup commands, use the Elements CLI/MCP documentation instead.

## Integration Points

- Keep global Elements CSS in `src/_layouts/index.css`.
- Register Elements used by layout or markdown content in `src/_layouts/index.ts`.
- Keep shared page shell markup in `src/_layouts/index.11ty.js`; page files should supply content.
- Use `@11ty/eleventy-plugin-vite` for bundling the layout entrypoint.

## Markdown Rendering

- Add `nve-text` and `nve-layout` attributes through the markdown-it renderer in `eleventy.config.js` when markdown should receive Elements typography.
- Keep renderer mappings constrained to token types that markdown-it exposes predictably: headings, paragraphs, links, lists, inline code, fences, and tables.
- Inline code spans (single backticks) get `nve-text="code"` — a bare `<code>` fails the Elements template validator's unstyled-typography check.
- Fenced code blocks (` ``` `) render as `nve-codeblock`, not `<pre>`. The fence info string maps to the `language` attribute (aliased where markdown shorthand differs, e.g. `sh` → `shell`, `ts` → `typescript`); unrecognized or absent languages omit the attribute and fall back to the component's default.
- Pipe tables render as `nve-grid` (`nve-grid-header`/`-column`/`-row`/`-cell`), not `<table>`, wrapped in a `.table-scroll` container so wide tables scroll instead of overflowing the viewport. Each cell's inline content is wrapped in a `<span>` because nve-grid-cell's shadow DOM slots into a flex container, which blockifies bare direct children.
- Let raw `nve-*` HTML pass through markdown only when the page intentionally owns that markup.

## Routing

- Keep the `<base>` URL and Vite `base` aligned with `PAGES_BASE_URL` (defaults to `/` when unset — no hardcoded path suffix).
- Use relative links in navigation markup (`getting-started/`, `commands/`, …) so static output works under whatever base path `PAGES_BASE_URL` sets.

## Verification

- Run `bun run build` in `projects/docs` after layout, renderer, or asset pipeline changes.
- Run `bun run lint` when editing Eleventy config or layout TypeScript.
- From the repo root, `bun --filter @coryrylan/cradle-docs run ci` runs both.
