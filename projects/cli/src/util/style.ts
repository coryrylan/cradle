// ANSI styling for `cradle run`'s startup lines, so real warnings are visually distinct.
// Styling is TTY-gated: piped output stays byte-clean for tests and tooling.

/** Yellow when `isTty` — a real warning, printed to stderr. */
export function styleWarning(line: string, isTty: boolean): string {
  return isTty ? `\x1b[33m${line}\x1b[0m` : line;
}
