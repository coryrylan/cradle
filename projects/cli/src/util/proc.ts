type ForwardableSignal = 'SIGINT' | 'SIGTERM';

interface Killable {
  kill(signal: ForwardableSignal): void;
}

/** A signal handler that forwards `signal` to `proc`. */
export function killOn(proc: Killable, signal: ForwardableSignal): () => void {
  return () => {
    proc.kill(signal);
  };
}

/**
 * Spawn an interactive child process, inheriting the raw tty so a full-screen
 * agent TUI works, and forwarding interrupt/terminate signals. Resolves with the
 * child's exit code so the caller can propagate it.
 *
 * This is the only module that performs a real spawn; everything upstream
 * (argv composition, bin resolution) is utils and unit-tested.
 *
 * `env` entries override the inherited `process.env` (used for the
 * sandboxed-run `MISE_CACHE_DIR`, see `agent/launch.ts`'s `composeEnv`).
 */
export async function runForeground(argv: readonly string[], env: Record<string, string> = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    throw new Error('Command requires at least one argument');
  }

  const proc = Bun.spawn([cmd, ...rest], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, ...env }
  });

  // Forward interrupts to the child while it runs, then detach — leaving the
  // handlers attached would leak a pair per call across sequential spawns
  // (e.g. `setup` pulling several packs) and pin already-exited children.
  const onInterrupt = killOn(proc, 'SIGINT');
  const onTerminate = killOn(proc, 'SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);

  try {
    return await proc.exited;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

/**
 * Run a setup command silently, capturing stderr for the caller's error
 * message — the sbx create/policy/provision sequence, see
 * `commands/run.ts`'s `MaterializeDeps.run`. Never throws on a non-zero
 * exit: the caller decides which failures matter (an sbx create name
 * collision means attach, not failure).
 */
export async function runCapture(argv: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    throw new Error('Command requires at least one argument');
  }

  const proc = Bun.spawn([cmd, ...rest], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
    env: process.env
  });

  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stderr };
}

/** Run a package install (e.g. `npm install`) in `cwd`, inheriting output; throws on non-zero exit. */
export async function runInstall(command: readonly string[], cwd: string): Promise<void> {
  const [cmd, ...rest] = command;
  if (!cmd) {
    throw new Error('Command requires at least one argument');
  }

  const proc = Bun.spawn([cmd, ...rest], {
    cwd,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Package install failed (${command.join(' ')} exited ${String(exitCode)})`);
  }
}
