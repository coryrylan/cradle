// Loader/validator for the agent folder format (see /ARCHITECTURE.md). A folder
// with an APPEND_SYSTEM.md is a complete agent; settings.json, models.json, skills/,
// extensions/, and sandbox/nono.json are optional. Missing APPEND_SYSTEM.md and
// malformed JSON are hard errors; everything else unexpected is a warning + continue.

import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { readPackageSpecs, type NpmPackageSpec } from './packages.js';
import { readTextIfExists } from '../setup/install.js';
import {
  getErrorMessage,
  hasErrorCode,
  isPathShaped,
  isRecord,
  isStringArray,
  parseJson,
  warnUnsupportedKeys,
  type JsonValue
} from '../setup/utils.js';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface AgentSettings {
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
  readonly defaultThinkingLevel?: ThinkingLevel;
  /** Parsed `npm:` package sources from settings.json's `packages` key — see `./packages.js`. */
  readonly packages?: readonly NpmPackageSpec[];
  /** Installer argv prefix from settings.json's `npmCommand` (e.g. `["npm"]`); `npm` when absent. */
  readonly npmCommand?: readonly string[];
}

export interface AgentSandboxGrants {
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly allow: readonly string[];
}

/**
 * The agent's declared network posture — a curated subset of nono's profile
 * `network` block, using nono's CANONICAL key names (not the `proxy_allow` /
 * `port_allow` legacy aliases). Folded verbatim into the generated per-agent
 * profile by `nono/profiles.ts`, where nono is the enforcement authority:
 * `allow_domain` presence flips nono to default-deny proxy filtering, and nono
 * fails closed (refuses to run) on an unenforceable platform or a bad key —
 * cradle never has to synthesize a fallback. Absent entirely ⇒ nono default
 * (open network), preserving the old `net: "allow"` behavior.
 */
export interface AgentNetwork {
  /** Deny all outbound (replaces the old `net: "block"`). */
  readonly block?: boolean;
  /** Named nono network-policy profile (host `network-policy.json`); opaque pass-through. */
  readonly networkProfile?: string;
  /** Outbound host allowlist — hostnames/IPs. Presence ⇒ nono default-denies unlisted hosts. */
  readonly allowDomain?: readonly string[];
  /** localhost TCP ports the child may connect+bind (local IPC / dev servers). */
  readonly openPort?: readonly number[];
  /** TCP ports the child may listen on. */
  readonly listenPort?: readonly number[];
}

export type AgentSandboxPosture = 'unconfigured' | 'enabled' | 'disabled';

export interface AgentSandbox {
  /**
   * The folder's declared sandbox posture. `'unconfigured'` when the folder has
   * no `sandbox/nono.json`; otherwise mirrors the file's `sandbox` key
   * (absent ⇒ `'enabled'`).
   */
  readonly posture: AgentSandboxPosture;
  readonly network?: AgentNetwork;
  readonly filesystem: AgentSandboxGrants;
  /**
   * Raw macOS Seatbelt s-expression rules from `sandbox/nono.json`'s
   * `unsafe_macos_seatbelt_rules`, merged verbatim after the base profile's
   * rules (see nono/profiles.ts). The escape hatch a browser agent uses to let
   * Chrome register its crashpad Mach service and open IOKit — capabilities the
   * default profile denies. Named "unsafe" because each rule widens the OS
   * sandbox; nono's startup banner does not list seatbelt rules, so review a
   * folder's `sandbox/nono.json` or the generated profile to audit them.
   */
  readonly unsafeMacosSeatbeltRules: readonly string[];
}

export interface AgentFolder {
  readonly dir: string;
  /** Abs path of APPEND_SYSTEM.md — appended to pi's system prompt via `--append-system-prompt`. */
  readonly appendSystemFilePath: string;
  readonly settings: AgentSettings;
  /** Serialized `providers` object from models.json, `null` when absent. */
  readonly providersJson: string | null;
  readonly skillsDir: string | null;
  /** pi-native extensions (top-level `extensions/*.ts` plus each subdir's `index.ts`), absolute paths. */
  readonly extensionFiles: readonly string[];
  readonly sandbox: AgentSandbox;
  readonly warnings: readonly string[];
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const RESERVED_DIRS = new Set(['schedules', 'subagents', 'channels', 'connections']);
const KNOWN_ENTRIES = new Set(['APPEND_SYSTEM.md', 'settings.json', 'models.json', 'skills', 'extensions', 'sandbox']);
const REPO_ENTRIES = new Set(['.git', '.gitignore', '.DS_Store', 'README.md', 'LICENSE']);
const EMPTY_GRANTS: AgentSandboxGrants = { read: [], write: [], allow: [] };
const EMPTY_SANDBOX: AgentSandbox = {
  posture: 'unconfigured',
  filesystem: EMPTY_GRANTS,
  unsafeMacosSeatbeltRules: []
};

export async function loadAgentFolder(dir: string): Promise<AgentFolder> {
  const abs = resolve(dir);
  const entries = await readAgentDir(abs);
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  if (!byName.has('APPEND_SYSTEM.md')) {
    const renameHint = byName.has('AGENTS.md') ? ' — found AGENTS.md, rename it to APPEND_SYSTEM.md' : '';
    throw new Error(`not an agent folder: ${abs} (missing APPEND_SYSTEM.md${renameHint} — see ARCHITECTURE.md)`);
  }

  const warnings: string[] = [];
  warnUnknownEntries(entries, warnings);
  return {
    dir: abs,
    appendSystemFilePath: join(abs, 'APPEND_SYSTEM.md'),
    settings: await loadSettings(abs, byName.has('settings.json'), warnings),
    providersJson: await loadProviders(abs, byName.has('models.json'), warnings),
    skillsDir: resolveSkillsDir(abs, byName.get('skills'), warnings),
    extensionFiles: await loadExtensions(abs, byName.get('extensions'), warnings),
    sandbox: await loadSandbox(abs, byName.get('sandbox'), warnings),
    warnings
  };
}

async function readAgentDir(abs: string): Promise<Dirent[]> {
  try {
    return await readdir(abs, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR')) {
      throw new Error(`agent folder not found: ${abs}`, { cause: error });
    }
    throw error;
  }
}

function warnUnknownEntries(entries: readonly Dirent[], warnings: string[]): void {
  const reserved = entries.filter(entry => RESERVED_DIRS.has(entry.name)).map(entry => entry.name);
  const unknown = entries
    .map(entry => entry.name)
    .filter(name => !KNOWN_ENTRIES.has(name) && !RESERVED_DIRS.has(name) && !REPO_ENTRIES.has(name));
  if (reserved.length > 0) {
    warnings.push(`reserved for a future cradle release, ignored: ${reserved.join(', ')}`);
  }
  if (unknown.length > 0) {
    warnings.push(`not part of the agent folder format, ignored: ${unknown.join(', ')}`);
  }
}

/**
 * `settings.json` is pi's file — pi owns its schema, so cradle silently
 * leaves keys it doesn't map to CLI flags (`theme`, `quietStartup`,
 * `collapseChangelog`, …) to pi rather than warning on valid settings. Two
 * keys get cradle-side handling instead of a silent pass-through: `packages`
 * — pi's npm-distributed extension mechanism — is resolved and installed
 * per-agent (see `readPackageSpecs` in `./packages.js` for the npm: parsing
 * rules; `commands/start.ts` does the install + `-e` resolution), and
 * `npmCommand` selects the installer cradle shells out to for it (default
 * `npm`).
 */
async function loadSettings(abs: string, present: boolean, warnings: string[]): Promise<AgentSettings> {
  if (!present) return {};
  const path = join(abs, 'settings.json');
  const json = await readJsonObject(path);
  const provider = readStringKey(json, 'defaultProvider', path, warnings);
  const model = readStringKey(json, 'defaultModel', path, warnings);
  const thinking = readThinkingLevel(json, path, warnings);
  const packages = readPackageSpecs(json, path, warnings);
  const npmCommand = readNpmCommand(json, path, warnings);
  return {
    ...(provider !== undefined ? { defaultProvider: provider } : {}),
    ...(model !== undefined ? { defaultModel: model } : {}),
    ...(thinking !== undefined ? { defaultThinkingLevel: thinking } : {}),
    ...(packages.length > 0 ? { packages } : {}),
    ...(npmCommand !== undefined ? { npmCommand } : {})
  };
}

/** `npmCommand`: the installer argv prefix (e.g. `["pnpm"]`) — `commands/start.ts` appends `install`. */
function readNpmCommand(
  record: { readonly [key: string]: JsonValue },
  path: string,
  warnings: string[]
): readonly string[] | undefined {
  const value = record['npmCommand'];
  if (value === undefined) return undefined;
  if (!isStringArray(value) || value.some(item => item.trim() === '')) {
    warnings.push(`${path}: npmCommand must be an array of non-empty strings — ignored`);
    return undefined;
  }
  return value.length > 0 ? value : undefined;
}

async function loadProviders(abs: string, present: boolean, warnings: string[]): Promise<string | null> {
  if (!present) return null;
  const path = join(abs, 'models.json');
  const json = await readJsonObject(path);
  const providers = json['providers'];
  if (providers === undefined || !isRecord(providers)) {
    throw new Error(`${path} must contain a "providers" object`);
  }
  warnUnsupportedKeys(json, path, ['providers'], warnings);
  return JSON.stringify(fillModelCostDefaults(providers), null, 2);
}

/**
 * pi's own models.json loader defaults a model's `cost`, but the
 * `registerProvider` extension API does not — a registered model without it
 * crashes the turn (`model.cost.input`). Fill the same zero-cost default so
 * configs copied from `~/.pi/agent/models.json` work verbatim.
 */
function fillModelCostDefaults(providers: { readonly [key: string]: JsonValue }): JsonValue {
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return Object.fromEntries(
    Object.entries(providers).map(([name, provider]) => {
      if (!isRecord(provider) || !Array.isArray(provider['models'])) return [name, provider];
      const models = provider['models'].map(model =>
        isRecord(model) && model['cost'] === undefined ? { cost: zeroCost, ...model } : model
      );
      return [name, { ...provider, models }];
    })
  );
}

function resolveSkillsDir(abs: string, entry: Dirent | undefined, warnings: string[]): string | null {
  if (!entry) return null;
  if (!entry.isDirectory()) {
    warnings.push('skills must be a directory — ignored');
    return null;
  }
  return join(abs, 'skills');
}

/** Mirror pi's own extension discovery shapes: top-level `extensions/*.ts` plus each subdir's `index.ts`. */
async function loadExtensions(abs: string, entry: Dirent | undefined, warnings: string[]): Promise<string[]> {
  if (!entry) return [];
  if (!entry.isDirectory()) {
    warnings.push('extensions must be a directory — ignored');
    return [];
  }
  const extensionsDir = join(abs, 'extensions');
  const entries = await readdir(extensionsDir, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (item): Promise<string | null> => {
        if (item.isFile() && item.name.endsWith('.ts') && !item.name.startsWith('.')) {
          return join(extensionsDir, item.name);
        }
        if (item.isDirectory()) {
          const index = join(extensionsDir, item.name, 'index.ts');
          return (await Bun.file(index).exists()) ? index : null;
        }
        return null;
      })
  );
  return candidates.filter((file): file is string => file !== null);
}

async function loadSandbox(abs: string, entry: Dirent | undefined, warnings: string[]): Promise<AgentSandbox> {
  if (!entry) return EMPTY_SANDBOX;
  if (!entry.isDirectory()) {
    warnings.push('sandbox must be a directory — ignored');
    return EMPTY_SANDBOX;
  }
  const path = join(abs, 'sandbox', 'nono.json');
  const json = await readSandboxJson(path);
  if (json === undefined) {
    warnings.push('sandbox/ has no nono.json — sandboxing stays off unless --sandbox is passed');
    return EMPTY_SANDBOX;
  }
  const enabled = readBooleanKey(json, 'sandbox', path, warnings);
  const network = readNetwork(json, path, warnings);
  warnNetRemoved(json, path, warnings);
  // `net` stays in the supported set only so the removed-key hint above is the
  // single message about it — not a duplicate generic "unsupported key".
  warnUnsupportedKeys(json, path, ['sandbox', 'network', 'filesystem', 'unsafe_macos_seatbelt_rules', 'net'], warnings);
  return {
    posture: enabled === false ? 'disabled' : 'enabled',
    ...(network !== undefined ? { network } : {}),
    filesystem: readGrants(json['filesystem'], path, warnings),
    unsafeMacosSeatbeltRules: readSeatbeltRules(json['unsafe_macos_seatbelt_rules'], path, warnings)
  };
}

/** Read + parse sandbox/nono.json once; `undefined` when the file is absent. */
async function readSandboxJson(path: string): Promise<{ readonly [key: string]: JsonValue } | undefined> {
  const text = await readTextIfExists(path);
  if (text === undefined) return undefined;
  const json = parseJson(text, path);
  if (!isRecord(json)) throw new Error(`${path} must be a JSON object`);
  return json;
}

/** The old `net: "allow" | "block"` key was removed; point authors at `network`. */
function warnNetRemoved(record: { readonly [key: string]: JsonValue }, path: string, warnings: string[]): void {
  if (record['net'] !== undefined) {
    warnings.push(`${path}: "net" was removed — use "network" instead (see ARCHITECTURE.md) — ignored`);
  }
}

/**
 * Read the agent's `network` block into `AgentNetwork`. A curated subset of
 * nono's canonical `network` keys, each warn-and-dropped when malformed (like
 * every other folder key). Returns undefined when absent or entirely empty so
 * the generated profile omits `network` (nono default: open).
 */
function readNetwork(
  record: { readonly [key: string]: JsonValue },
  path: string,
  warnings: string[]
): AgentNetwork | undefined {
  const value = record['network'];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push(`${path}: network must be an object — ignored`);
    return undefined;
  }
  const where = `${path} network`;
  warnUnsupportedKeys(value, where, ['block', 'network_profile', 'allow_domain', 'open_port', 'listen_port'], warnings);
  const block = readBooleanKey(value, 'block', where, warnings);
  const networkProfile = readStringKey(value, 'network_profile', where, warnings);
  const allowDomain = readHostList(value, 'allow_domain', where, warnings);
  const openPort = readPortList(value, 'open_port', where, warnings);
  const listenPort = readPortList(value, 'listen_port', where, warnings);
  const network: AgentNetwork = {
    ...(block !== undefined ? { block } : {}),
    ...(networkProfile !== undefined ? { networkProfile } : {}),
    ...(allowDomain.length > 0 ? { allowDomain } : {}),
    ...(openPort.length > 0 ? { openPort } : {}),
    ...(listenPort.length > 0 ? { listenPort } : {})
  };
  return Object.keys(network).length > 0 ? network : undefined;
}

/** Host allowlist entries — non-empty strings. They land in the profile as JSON values (never argv). */
function readHostList(
  record: { readonly [key: string]: JsonValue },
  key: string,
  path: string,
  warnings: string[]
): readonly string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!isStringArray(value)) {
    warnings.push(`${path}: ${key} must be an array of strings — ignored`);
    return [];
  }
  // Trim like readSeatbeltRules does: a host with stray whitespace would land
  // verbatim in the profile's allow_domain and never match at proxy time.
  const hosts = value.map(entry => entry.trim()).filter(entry => entry !== '');
  if (hosts.length !== value.length) warnings.push(`${path}: ${key} entries must be non-empty — blanks ignored`);
  return hosts;
}

/** Port list entries — integers in 0–65535. */
function readPortList(
  record: { readonly [key: string]: JsonValue },
  key: string,
  path: string,
  warnings: string[]
): readonly number[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`${path}: ${key} must be an array of port numbers — ignored`);
    return [];
  }
  const isPort = (entry: JsonValue): entry is number =>
    typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 65535;
  const dropped = value.filter(entry => !isPort(entry));
  if (dropped.length > 0) {
    warnings.push(`${path}: ${key} entries must be integers 0–65535 — ignored: ${dropped.join(', ')}`);
  }
  return value.filter(isPort);
}

/**
 * Read `unsafe_macos_seatbelt_rules`: an array of raw Seatbelt s-expressions
 * merged verbatim into the generated profile. Accept only balanced,
 * parenthesized entries so a hostile folder can't smuggle a bare token/flag
 * into the policy — the same shape-guard rationale as `readStringList`'s path
 * check. nono re-validates s-expression syntax at profile load; this is the
 * lightweight pre-filter, warn-don't-throw like every other folder key.
 */
function readSeatbeltRules(value: JsonValue | undefined, path: string, warnings: string[]): readonly string[] {
  if (value === undefined) return [];
  if (!isStringArray(value)) {
    warnings.push(`${path}: unsafe_macos_seatbelt_rules must be an array of strings — ignored`);
    return [];
  }
  const isSexpr = (rule: string): boolean => {
    const trimmed = rule.trim();
    return trimmed.startsWith('(') && trimmed.endsWith(')');
  };
  const dropped = value.filter(rule => !isSexpr(rule));
  if (dropped.length > 0) {
    warnings.push(
      `${path}: unsafe_macos_seatbelt_rules entries must be parenthesized s-expressions — ignored: ${dropped.join(', ')}`
    );
  }
  return value.filter(isSexpr).map(rule => rule.trim());
}

function readBooleanKey(
  record: { readonly [key: string]: JsonValue },
  key: string,
  path: string,
  warnings: string[]
): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    warnings.push(`${path}: ${key} must be true or false — ignored`);
    return undefined;
  }
  return value;
}

function readGrants(value: JsonValue | undefined, path: string, warnings: string[]): AgentSandboxGrants {
  if (value === undefined) return EMPTY_GRANTS;
  if (!isRecord(value)) {
    warnings.push(`${path}: filesystem must be an object — ignored`);
    return EMPTY_GRANTS;
  }
  warnUnsupportedKeys(value, `${path} filesystem`, ['read', 'write', 'allow'], warnings);
  return {
    read: readStringList(value, 'read', path, warnings),
    write: readStringList(value, 'write', path, warnings),
    allow: readStringList(value, 'allow', path, warnings)
  };
}

function readStringList(
  record: { readonly [key: string]: JsonValue },
  key: string,
  path: string,
  warnings: string[]
): readonly string[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!isStringArray(value)) {
    warnings.push(`${path}: ${key} must be an array of strings — ignored`);
    return [];
  }
  // Grants become `nono run` flag values — only accept path-shaped entries (the
  // shared guard) so a hostile folder can't smuggle flags (e.g. a leading `-`)
  // into the sandbox argv.
  const dropped = value.filter(entry => !isPathShaped(entry));
  if (dropped.length > 0) {
    warnings.push(`${path}: ${key} entries must be absolute, ~/, or $HOME/ paths — ignored: ${dropped.join(', ')}`);
  }
  return value.filter(isPathShaped);
}

async function readJsonObject(path: string): Promise<{ readonly [key: string]: JsonValue }> {
  const json = parseJson(await readJsonText(path), path);
  if (!isRecord(json)) {
    throw new Error(`${path} must be a JSON object`);
  }
  return json;
}

/**
 * Read a config file whose dirent exists, naming `path` in every failure. The
 * dirent-level presence check can't tell a real file from a broken symlink
 * (read → ENOENT → undefined) or a directory (read → raw EISDIR), and neither
 * of those may surface as "not valid JSON" or a path-free fs error.
 */
async function readJsonText(path: string): Promise<string> {
  let text: string | undefined;
  try {
    text = await readTextIfExists(path);
  } catch (error) {
    // Non-ENOENT read failure (EISDIR, EACCES, …): keep the hard error but name the file.
    throw new Error(`${path} could not be read: ${getErrorMessage(error)}`, { cause: error });
  }
  if (text === undefined) {
    throw new Error(`${path} could not be read — broken symlink?`);
  }
  return text;
}

function readStringKey(
  record: { readonly [key: string]: JsonValue },
  key: string,
  path: string,
  warnings: string[]
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    warnings.push(`${path}: ${key} must be a string — ignored`);
    return undefined;
  }
  return value;
}

function readThinkingLevel(
  record: { readonly [key: string]: JsonValue },
  path: string,
  warnings: string[]
): ThinkingLevel | undefined {
  const value = record['defaultThinkingLevel'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !THINKING_LEVELS.includes(value as ThinkingLevel)) {
    warnings.push(`${path}: defaultThinkingLevel must be one of ${THINKING_LEVELS.join(', ')} — ignored`);
    return undefined;
  }
  return value as ThinkingLevel;
}
