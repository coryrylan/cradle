Audit complete — read-only, no files changed. Baseline: bun run test → 539 pass / 0 fail; bunx knip clean.

Scope Analyzed

projects/cli/ — all 26 source files under src/ (agent/, commands/, nono/, schedule/, setup/, util/, cli.ts). Read root AGENTS.md,
projects/cli/AGENTS.md, and grepped ARCHITECTURE.md + projects/docs/src/** for external consumers of CLI types/claims.

Published boundary is package.json#exports → dist/index.js only (a bundled CLI bin), so every export interface here is internal to the package —
verified no consumer in projects/docs, examples/, install.sh, or CI. Test types available: in-process unit tests, subprocess smoke tests
(src/index.test.ts), and a bundle-output test (src/build.test.ts). No a11y/visual/SSR axes (CLI package). Knip runs monorepo-wide.

Findings

### 1. installTree's result-recording protocol, dry-run branch, and mode are all dead — P1, high confidence

Locations: src/setup/install.ts:11-38 (SetupStatus, SetupResult, InstallContext, addResult, fail), :52-55 (ctx.dryRun branch), :28 + :66-71
(TreeFile.mode + chmod); sole caller src/commands/run.ts:395-398.

Mechanism + evidence: every call site in the repo is materializeRun. It passes { dryRun: false, results: [], failures: [] } and reads only
ctx.failures. ctx.results has zero production readers (only install.test.ts:18 last()), addResult's three status values are never inspected, dryRun is
unreachable because cli.ts:157 returns after printDryRun(plan) before materializeRun is ever called, and no TreeFile producer anywhere sets mode
(emitExtensionFiles emits rel/content only). The "warn-and-record, never throw" contract in the test title is fictional: the only caller throws on the
first recorded failure.

Must survive: stale-file removal from the state extensions/ dir (run.test.ts:597), idempotent no-op when content matches, and a one-line error naming
the artifact when the write fails.

Smallest simplification: installTree(dest, files): Promise<void> — keep treeMatches/makeWritableTree/rm/writeTreeFile, wrap in one try/catch that
throws Failed to write agent extensions: …. Delete InstallContext, SetupResult, SetupStatus, addResult, fail, the name parameter, dryRun, and mode.

Benefit: ~45 lines of install.ts plus ~30 test lines gone; one exported API surface and one per-call allocation removed; the fake never-throw contract
stops misleading readers. Risk: low — single caller. Validate: bun test src/setup/install.test.ts src/commands/run.test.ts && bun run lint && bun run
build.

────────────────────────────────────────────────────────────────────────────────

### 2. Five fields in the schedule pipeline are written and never read — two carry a docs claim that isn't true — P1, high confidence

Locations: src/schedule/timer.ts:26 (TimerPlan.id), src/agent/schedules.ts:26 (Schedule.path), :29 (Schedule.description),
src/commands/schedule.ts:100+:105 region (SchedulePlan.folder, SchedulePlan.platform).

Evidence:

- TimerPlan.id (launchd.ts:164, systemd.ts:149) — read only in launchd.test.ts:116, systemd.test.ts:123, schedule.test.ts:114. Its own doc comment says
  "shown in cradle schedule list"; formatScheduleRow prints slug/cron/cwd/status, never the id.
- Schedule.path — no reader in src/ at all, production or test.
- Schedule.description — parsed, validated, warn-handled, stored; ScheduleRow has no description field. Both ARCHITECTURE.md:223 and
  projects/docs/src/schedule/index.md:29 document it as "shown in cradle schedule list". Neither the CLI nor the docs' own rendered claim is honored.
- SchedulePlan.folder — one test read; SchedulePlan.platform — zero reads anywhere, including tests.

Must survive: the plist/unit Label/Description values (composed inline from agentId + slug, independent of id), and the unsupported-frontmatter-key
warning.

Smallest simplification: delete TimerPlan.id, Schedule.path, SchedulePlan.folder, SchedulePlan.platform and their three test assertions. description
needs a decision from you: render it as a fifth line in formatScheduleRow (honors both docs), or drop it from Schedule + FRONTMATTER_KEYS and correct
ARCHITECTURE.md:223 + docs/src/schedule/index.md:29 — deleting it silently turns existing authored files into "unsupported keys ignored" warnings, so
it must not be a quiet removal.

Benefit: four pieces of per-target state and their construction/typing gone; two docs pages stop lying. Risk: low for the four; description is a
format-surface change. Validate: bun test src/schedule src/commands/schedule.test.ts src/agent/schedules.test.ts, then bun run lint.

────────────────────────────────────────────────────────────────────────────────

### 3. LaunchSpec.stateDir is write-only, and a test exists solely to police code that was never written — P1, high confidence

Locations: src/agent/launch.ts:12 (+ doc :14-19), set at src/commands/run.ts:263, src/agent/launch.test.ts:240-253.

Evidence: grep -n "stateDir" src/agent/launch.ts returns the declaration and two comment lines — no read. composePiArgv/composeEnv/composeArgv use
extensionsDir, sessionsDir, miseCacheDir, profilePath. The only test is 'should derive the providers -e path and --session-dir from the spec, never
re-derive from stateDir' — it asserts that the function does not call statePaths(spec.stateDir), a bug that cannot occur while nothing reads the field.

Must survive: argv deriving providers.ts/--session-dir from the spec's own extensionsDir/sessionsDir — already covered by the other argv tests.

Smallest simplification: drop LaunchSpec.stateDir and the run.ts:263 assignment, and delete the test. nono/profiles.ts keeps its own stateDir (it
genuinely reads it, for meta.name and the allow grant).

Benefit: one field and ~15 test lines removed, plus the misleading "re-deriving from stateDir risks silently disagreeing" rationale, which describes a
hazard created only by the field's existence. Risk: trivial. Validate: bun test src/agent/launch.test.ts src/commands/run.test.ts.

────────────────────────────────────────────────────────────────────────────────

### 4. RunPlan stores a second copy of extensionsDir/sessionsDir that plan.launch already owns, then re-asserts them onto it — P2, high confidence

Locations: src/commands/run.ts:85-94 (the 10-line "Authoritative — the single derivation site" doc), :392-410 (materializeRun's re-assert),
run.test.ts:649-666.

Evidence: both copies originate from the same single statePaths(stateDir) call at run.ts:128 and flow into buildLaunch unchanged. Nothing in production
ever overrides them; the re-assert exists to keep a hypothetical post-planRun mutation of RunPlan from disagreeing with plan.launch — a divergence the
duplication itself creates. Note RunPlan exposes only 2 of the 3 StatePaths fields (miseCacheDir lives only on launch), so the duplicate copy is also
incomplete, which is its own tell.

Must survive: files written to the state extensions//sessions/ dirs; argv pointing at exactly those paths; --dry-run printing the write plan.

Smallest simplification: remove extensionsDir/sessionsDir from RunPlan; materializeRun writes to plan.launch.extensionsDir/.sessionsDir and cli.ts:207
prints plan.launch.extensionsDir. One source of truth, no re-assert, no precedence doc.

Benefit: deletes the re-assert object spread, its 6-line rationale, and the test that exists to verify the workaround. Risk: moderate churn — 18
plan.extensionsDir + 6 plan.sessionsDir test references, mechanical rename. Validate: bun test src/commands/run.test.ts && bun test && bun run lint.

────────────────────────────────────────────────────────────────────────────────

### 5. Three artifacts exist to thread terminalIntegrations from buildLaunch into the profile builder — P2, medium-high confidence

Locations: src/agent/launch.ts:63 (terminalIntegrations? optional), src/commands/run.ts:248-249 (PlannedLaunch extends LaunchSpec), :462-468
(IsolationContext), :470-478 (buildIsolation), :495-507 (sandboxPlan's inline ctx type).

Evidence: LaunchSpec.terminalIntegrations is declared optional but planRun always populates it, so both consumers degrade to ?. (launch.ts:115, :150).
PlannedLaunch then re-declares it as required purely so buildIsolation can read it off the return value. IsolationContext and sandboxPlan's inline
parameter type are the same shape plus linkedGitDir?, and buildIsolation is a two-line forwarder whose entire job is resolving that one field.

Must survive: socket grants + hook -e entries reaching the profile; scheduled runs excluding terminal integrations (that lives in
getTerminalIntegrations's enabled, untouched); the degenerate-cwd guard.

Smallest simplification: make LaunchSpec.terminalIntegrations required (drop the two ?.), delete PlannedLaunch, fold buildIsolation into sandboxPlan
(which already receives linkedGitDir-shaped ctx) or resolve linkedGitDir in planRun beside the other async lookups, and collapse IsolationContext with
sandboxPlan's parameter type.

Benefit: one interface, one type alias, one function, and two ?. fallbacks removed; the "sometimes present" cardinality lie in LaunchSpec corrected.
Risk: moderate — launch.test.ts builds specs by hand and will need the field (that's the point: the compiler enforces the contract). Validate: bun test
src/agent/launch.test.ts src/agent/terminal-integrations.test.ts src/commands/run.test.ts.

────────────────────────────────────────────────────────────────────────────────

### 6. DoctorCheck.bin is always DoctorCheck.name — P3, high confidence

Locations: src/commands/doctor.ts:5 (readonly bin: string), set at :75, :79-81 (optionalCheck writes bin: name), 8 literals in doctor.test.ts.

Evidence: every construction site passes identical values; formatCheck and doctorExitCode read only name/required/found/version/note. No reader of bin
exists in the repo.

Smallest simplification: delete the field. Benefit: one field, one always-duplicated literal per check, 8 test literals. Risk: trivial. Validate: bun
test src/commands/doctor.test.ts.

────────────────────────────────────────────────────────────────────────────────

### 7. cli.ts re-implements runCaptureAll, and the version-parsing regex is untestable in-process — P3, high confidence

Locations: src/cli.ts:242-253 (readBinVersion) vs src/util/proc.ts:66-90 (runCaptureAll).

Evidence: identical spawn-and-drain-both-streams body. cli.ts is per AGENTS.md exercised only via subprocess smoke tests, so readBinVersion's actual
logic — the stdout.split('\n')[0]?.match(/v?\d+\.\d+\S*/)?.[0] ?? null normalization that reconciles pi's bare 0.80.10 against nono's nono 0.68.0 — has
zero in-process coverage, while proc.test.ts covers the plumbing it duplicates.

Smallest simplification: extract normalizeVersionOutput(stdout: string, exitCode: number): string | null into commands/doctor.ts (which owns the
readVersion contract) and have cli.ts pass (binPath) => normalizeVersionOutput(await runCaptureAll([binPath, '--version'])); cover the four branches
(non-zero exit, pi-style, nono-style, no match) with unit tests. Benefit: removes a second raw Bun.spawn and its error handling from the untested file;
the parsing logic gains real tests. Risk: low. Validate: bun test src/commands/doctor.test.ts src/util/proc.test.ts src/index.test.ts.

────────────────────────────────────────────────────────────────────────────────

### 8. Verbatim duplicated micro-helpers — P3, high confidence (partly audit-consolidation territory)

- unknownScheduleMessage is character-identical in src/commands/run.ts:225-231 and src/commands/schedule.ts:278-284.
- readCliHostList (run.ts:323-328) re-implements folder.ts:471-484 readHostList's trim/filter/warn body — its own comment admits the mirroring.
- warnUnknownFrontmatterKeys (agent/schedules.ts:193-198) duplicates warnUnsupportedKeys (setup/utils.ts:52-59) purely because the latter's parameter
  is typed { readonly [key: string]: JsonValue }; widening it to Readonly<Record<string, unknown>> (it only calls Object.keys) deletes the copy and its
  test.
- resolveSkillsDir (folder.ts:352-358) and resolveScheduleDir (:360-366) are identical apart from the name in the warning string.
- const [cmd, ...rest] = argv; if (!cmd) throw new Error('Command requires at least one argument') appears three times in util/proc.ts:31-34, :71-74,
  :96-99.

Smallest simplification: one host-list trimmer and one unknown-slug message helper; widen warnUnsupportedKeys; one resolveKnownDir(abs, entry, name,
warnings); one requireArgv(argv) in proc.ts. Benefit: five near-copies collapse; message text stops drifting between siblings. Risk: low, warning-text
assertions must be updated in lockstep.

────────────────────────────────────────────────────────────────────────────────

### 9. RunFlags.noSandbox inverts --sandbox twice across the CLI boundary — P3, medium confidence

Locations: src/cli.ts:82 (noSandbox: !argv.sandbox), src/commands/run.ts:33, :354-355 (=== true → off, === false → on).

Evidence: yargs already models the tri-state (--sandbox → true, --no-sandbox → false, absent → undefined). cli.ts negates it into a tri-state
noSandbox; resolveSandbox negates it right back. The double negation is why run.test.ts:123, :742 loop for (const noSandbox of [true, false]) — a loop
whose two iterations read backwards relative to the flag users type.

Smallest simplification: RunFlags.sandbox?: boolean with the same "absent = defer to the folder" semantics; cli.ts forwards argv.sandbox unchanged.
Benefit: the flag name matches the user-facing surface and the precedence rule reads directly. Risk: 26 noSandbox: test call sites flip polarity —
mechanical but error-prone; do it as its own commit, and verify the [true, false] loops still assert the intended branches. Validate: bun test
src/commands/run.test.ts.

Keep

- runForeground's SIGINT/SIGTERM forwarding + process.off (util/proc.ts:47-59). Not redundant with terminal Ctrl-C: registering the handler is what
  stops cradle from dying immediately and orphaning pi, and SIGTERM reaches only cradle. The finally detach is load-bearing (tested for listener leaks
  across sequential spawns).
- installTree's makeWritableTree (install.ts:87-99). Pre-clearing perms before rm -r is a real requirement on a read-only state tree, covered by
  install.test.ts:66.
- packagesUpToDate's manifest comparison (run.ts:378-383) and materializeRun's rm(manifestPath) on install failure — both guard a real
  stale-node_modules trap. Keeping them means PackagesPlan.manifest (a serialized string in the plan) stays: it is the comparison key.
- warnUnsupportedKeys listing the removed net key as "supported" (folder.ts:419-422). Deliberate: it makes the targeted rename hint the single message.
  Same for the AGENTS.md rename hint and tildeNullHint.
- composeEnv's MISE_CACHE_DIR override and HERDR_AGENT — documented host-only exceptions, each with a stated failure mode.
- The DI seams (RunDeps.which/cwd/home/env/platform, MaterializeDeps.install, MaterializeScheduleDeps.run). AGENTS.md codifies them as the package's
  in-process testability mechanism, and every one has a production supplier plus real test usage. stateDirFor's stateRoot third parameter (state.ts:32)
  is the one soft spot — run.test.ts drives it through process.env.CRADLE_STATE_DIR anyway — but it is two lines and keeps a ||-fallback test that
  would otherwise need env mutation.
- isRestrictiveNetwork vs hasRestrictiveNetworkFlags (run.ts:336, :349). Look mergeable, are not: one inspects the resolved posture, the other the CLI
  request. Merging them would lose the case where the folder is restrictive but no CLI flag was passed.
- schedule/cron.ts's FieldSpec table and the dual day-of-month/day-of-week rejection. Pure, single-source, and the reason the two emitters cannot
  disagree.

Recommended Starting Point

Finding 1 (installTree's InstallContext). Highest payoff-to-risk in the package: one bounded file plus one caller, four types and two exported
functions removed, one unreachable branch and one unused chmod path deleted, zero behavioral surface — materializeRun already throws on the first
recorded failure, so the collection protocol converts nothing into a user-visible difference. No user decision required. Baseline is already green (539
pass, knip clean); re-run bun test src/setup/install.test.ts src/commands/run.test.ts after, then bun run ci.

Two decisions before you touch anything else, both on Finding 2: render description in cradle schedule list or delete it and correct
ARCHITECTURE.md:223 + docs/src/schedule/index.md:29 — that field is documented as shipped behavior that does not exist, which is the only finding in
this audit with a wrong-answer-externally property. Findings 3 and 6 can land the same day as small independent commits; do Finding 4 alone (24
test-site renames) and Finding 9 alone (26 polarity flips).
