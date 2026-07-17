// Chrome's nested macOS sandbox cannot initialize inside nono's seatbelt, so its
// child processes must launch with --no-sandbox. bun#27802 empties process.env
// inside the sandbox, so this can't ride an exported shell variable — instead we
// set it here at import time; pi builds each bash tool's env from process.env at
// spawn, so agent-browser (and the Chrome it launches) inherit the flag.
process.env.AGENT_BROWSER_ARGS ??= '--no-sandbox';
