// Shared types for the OS timer artifacts a scheduled agent run compiles to:
// a launchd LaunchAgent (see `./launchd.js`) on macOS, a systemd user timer
// (see `./systemd.js`) on Linux. Both emitters return the identical
// `TimerPlan` shape, so the command layer that writes files and shells out
// dispatches on platform exactly once and never branches on it again.

import type { Schedule } from '../agent/schedules.js';

/** Everything both timer emitters need to compose their platform's artifacts. */
export interface TimerContext {
  readonly schedule: Schedule;
  /** From `agent/state.ts`'s `agentId()` — e.g. `my-agent-a1b2c3d4`. Keeps two same-named folders from colliding. */
  readonly agentId: string;
  readonly agentDir: string;
  /** Absolute path to the `cradle` binary — launchd and systemd load no shell profile, so this is never a bare name. */
  readonly cradleBin: string;
  /** Where the task's stdout/stderr is captured. */
  readonly logPath: string;
  readonly home: string;
  /** launchd domain target (`gui/<uid>`); systemd ignores it. */
  readonly uid: number;
}

/** One file the command layer must write before running `installSteps`. */
export interface TimerFile {
  readonly path: string;
  readonly content: string;
}

/** One argv to run, in order, as part of installing, removing, or one-shot firing a timer. */
export interface TimerStep {
  readonly argv: readonly string[];
  /** A non-zero exit is expected and must be ignored — e.g. `launchctl bootout` when nothing is loaded yet. */
  readonly ignoreFailure?: boolean;
}

/** The platform-neutral result of composing a schedule's OS timer — the command layer's only input. */
export interface TimerPlan {
  /** The launchd label or the systemd unit base name — shown in `cradle schedule list`. */
  readonly id: string;
  readonly files: readonly TimerFile[];
  readonly installSteps: readonly TimerStep[];
  readonly removeSteps: readonly TimerStep[];
}
