#!/usr/bin/env bun

import { basename, join } from 'node:path';

import yargs from 'yargs';

import pkg from '../package.json' with { type: 'json' };
import { composeArgv } from './agent/launch.js';
import { doctorExitCode, formatDoctorReport, runDoctor } from './commands/doctor.js';
import { materializeStart, planStart, type StartFlags, type StartPlan } from './commands/start.js';
import { quoteCommandPart } from './setup/utils.js';
import { styleWarning } from './util/style.js';
import { runForeground, runInstall } from './util/proc.js';

const cli = yargs(process.argv.slice(2))
  .scriptName('cradle')
  .version(pkg.version)
  .usage('$0 <cmd> [args]')
  .parserConfiguration({ 'populate--': true })
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
  'run an agent folder with pi, sandboxed when sandbox/nono.json is present',
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
          'run inside nono (--sandbox forces it when sandbox/nono.json is absent or opts out; --no-sandbox disables)'
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
    const plan = await planStart(flags);
    printWarnings(plan.warnings);
    if (plan.dryRun) {
      printDryRun(plan);
      return;
    }
    const result = await materializeStart(plan, { install: runInstall });
    printWarnings(result.warnings);
    if (plan.profile !== null && !flags.verbose) console.log('🔒 Sandbox Active');
    process.exit(await runForeground(result.argv));
  } catch (err) {
    reportError(err);
  }
}

function printDryRun(plan: StartPlan): void {
  for (const file of plan.files) console.log(`write: ${join(plan.extensionsDir, file.rel)}`);
  if (plan.profile !== null) console.log(`write: ${plan.profile.path}`);
  if (plan.packages !== null) printPackagesPlan(plan.packages);
  console.log(composeArgv(plan.launch).map(quoteCommandPart).join(' '));
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
 * Read a bin's `--version` output, normalized to a bare version string. `nono`
 * prints `nono 0.68.0`; `pi` prints a bare `0.80.7` — strip a leading
 * `<bin name> ` prefix when present so both report the same shape. Returns
 * `null` on spawn failure.
 */
async function readBinVersion(binPath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([binPath, '--version'], { stdout: 'pipe', stderr: 'ignore' });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exitCode !== 0) return null;
    const firstLine = stdout.split('\n')[0]?.trim();
    if (!firstLine) return null;
    const prefix = `${basename(binPath)} `;
    return firstLine.startsWith(prefix) ? firstLine.slice(prefix.length) : firstLine;
  } catch {
    return null;
  }
}

function reportError(err: unknown): void {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}

void cli.parse();
