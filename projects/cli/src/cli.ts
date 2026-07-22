#!/usr/bin/env bun

import { join } from 'node:path';

import yargs from 'yargs';

import pkg from '../package.json' with { type: 'json' };
import { composeArgv, composeEnv } from './agent/launch.js';
import { doctorExitCode, formatDoctorReport, runDoctor } from './commands/doctor.js';
import { materializeStart, planStart, type StartFlags, type StartPlan } from './commands/start.js';
import { composeSbxExecArgv } from './sbx/compose.js';
import { quoteCommandPart } from './setup/utils.js';
import { styleWarning } from './util/style.js';
import { runCapture, runForeground, runInstall } from './util/proc.js';

const cli = yargs(process.argv.slice(2))
  .scriptName('cradle')
  .version(pkg.version)
  .usage('$0 <cmd> [args]')
  // Both flags are required to stop yargs from numerically coercing passthrough
  // tokens after `--` (verified empirically: 'parse-numbers' alone only covers
  // declared/unknown *option* values, not the positional-like `--` array).
  .parserConfiguration({ 'populate--': true, 'parse-numbers': false, 'parse-positional-numbers': false })
  .strict();

cli.command(
  '$0',
  'show help',
  () => {},
  async () => {
    console.log(await cli.getHelp());
  }
);

cli.command(
  'start [dir]',
  'run an agent folder with pi, sandboxed when sandbox/nono.json or sandbox/sbx.json is present',
  builder =>
    builder
      .positional('dir', {
        type: 'string',
        default: '.',
        describe: 'agent folder, or a name from ~/.cradle/settings.json (default: .)'
      })
      .option('offline', {
        type: 'boolean',
        description: 'block all outbound network (overrides the folder network policy; implies --sandbox)'
      })
      .option('allow-host', {
        type: 'array',
        string: true,
        description: 'restrict network to these hosts (repeatable; overrides the folder allowlist; implies --sandbox)'
      })
      .option('sandbox', {
        type: 'boolean',
        description:
          'run sandboxed (--sandbox forces it when no sandbox/ file enables one or the folder opts out; --no-sandbox disables)'
      })
      .option('sandbox-backend', {
        type: 'string',
        choices: ['nono', 'sbx'] as const,
        description:
          'sandbox implementation (implies --sandbox): nono (host OS policy) or sbx (Docker Sandboxes microVM)'
      })
      .option('verbose', {
        type: 'boolean',
        default: false,
        description: "show nono's full sandbox capabilities banner instead of the one-line status"
      })
      .option('dry-run', {
        type: 'boolean',
        default: false,
        description: 'print the write plan + command, do not spawn'
      })
      .epilogue('Everything after `--` is forwarded to pi.'),
  async argv => {
    const passthrough = ((argv['--'] as readonly unknown[] | undefined) ?? []).map(String);
    const allowHost = ((argv.allowHost as readonly unknown[] | undefined) ?? []).map(String);
    const flags: StartFlags = {
      dir: argv.dir,
      dryRun: argv.dryRun,
      ...(argv.sandbox !== undefined ? { noSandbox: !argv.sandbox } : {}),
      ...(argv.sandboxBackend !== undefined ? { sandboxBackend: argv.sandboxBackend } : {}),
      ...(argv.offline ? { offline: true } : {}),
      ...(allowHost.length ? { allowHost } : {}),
      ...(argv.verbose ? { verbose: true } : {}),
      ...(passthrough.length ? { passthrough } : {})
    };
    await runStart(flags);
  }
);

cli.command(
  'doctor',
  'check pi / nono / mise on PATH',
  () => {},
  async () => {
    const checks = await runDoctor({ readVersion: readBinVersion });
    console.log(formatDoctorReport(checks));
    process.exitCode = doctorExitCode(checks);
  }
);

// Every failure exits with the one-line message pattern; a rejection escaping a
// yargs handler would print the full usage dump plus a stack trace instead.
async function runStart(flags: StartFlags): Promise<void> {
  try {
    const plan = await planStart(flags, { tty: process.stdout.isTTY === true });
    printWarnings(plan.warnings);
    if (plan.dryRun) {
      printDryRun(plan);
      return;
    }
    const result = await materializeStart(plan, {
      install: runInstall,
      run: runCapture,
      readPiVersion: readBinVersion
    });
    printWarnings(result.warnings);
    if (plan.profile !== null && !flags.verbose) console.log('🔒 Sandbox Active');
    if (plan.sbx !== null && !flags.verbose) console.log('🔒 Sandbox Active (sbx)');
    process.exit(await runForeground(result.argv, composeEnv(plan.launch)));
  } catch (err) {
    reportError(err);
  }
}

function printDryRun(plan: StartPlan): void {
  for (const file of plan.files) console.log(`write: ${join(plan.extensionsDir, file.rel)}`);
  if (plan.profile !== null) console.log(`write: ${plan.profile.path}`);
  if (plan.sbx !== null) printSbxPlan(plan.sbx);
  if (plan.packages !== null) printPackagesPlan(plan.packages);
  // The dry-run print is an audit surface, so it must disclose the spawn env
  // too (cradle's one env-var exception, see `agent/launch.ts`'s `composeEnv`)
  // — not just the argv.
  const envPrefix = Object.entries(composeEnv(plan.launch)).map(([key, value]) => `${key}=${quoteCommandPart(value)}`);
  const argv =
    plan.sbx !== null ? composeSbxExecArgv(plan.sbx.spec, composeArgv(plan.launch)) : composeArgv(plan.launch);
  console.log([...envPrefix, ...argv.map(quoteCommandPart)].join(' '));
}

// The sbx setup sequence is part of the audit surface too — every command
// materialize will run, in order. Provision prints unpinned; materialize
// re-pins it to the host pi version (same precedent as the package `-e`
// entries below, which also resolve after the preview prints).
function printSbxPlan(sbx: NonNullable<StartPlan['sbx']>): void {
  console.log(`create: ${sbx.createArgv.map(quoteCommandPart).join(' ')}`);
  for (const argv of sbx.policyArgvs) console.log(`policy: ${argv.map(quoteCommandPart).join(' ')}`);
  console.log(`provision: ${sbx.provisionArgv.map(quoteCommandPart).join(' ')}`);
}

// Dry-run never installs; the printed argv legitimately omits the package `-e`
// entries below — they resolve at install time, after this preview prints.
function printPackagesPlan(packages: NonNullable<StartPlan['packages']>): void {
  console.log(`write: ${join(packages.npmDir, 'package.json')}`);
  const specSummary = packages.specs.map(spec => `${spec.name}@${spec.version}`).join(', ');
  console.log(`install: ${packages.installCommand.join(' ')} (${packages.npmDir}): ${specSummary}`);
}

function printWarnings(warnings: readonly string[]): void {
  const stderrTty = process.stderr.isTTY === true;
  for (const warning of warnings) console.error(styleWarning(`warning: ${warning}`, stderrTty));
}

/**
 * Read a bin's version output, normalized to a bare version string. Bins
 * report differently — `pi` prints a bare `0.80.10`, `nono` prints
 * `nono 0.68.0`, and `sbx` (no `--version` flag at all; callers pass
 * `['version']`) prints `sbx version: v0.35.0 <sha>` — so extract the first
 * version-shaped token from the first line rather than assuming a prefix.
 * Returns `null` on spawn failure, non-zero exit, or no match.
 */
async function readBinVersion(binPath: string, args: readonly string[] = ['--version']): Promise<string | null> {
  try {
    const proc = Bun.spawn([binPath, ...args], { stdout: 'pipe', stderr: 'ignore' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    return stdout.split('\n')[0]?.match(/v?\d+\.\d+\S*/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function reportError(err: unknown): void {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

void cli.parse();
