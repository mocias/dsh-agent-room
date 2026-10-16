'use strict';
/**
 * The harness registry: which agent harnesses a room can put a member on.
 *
 * Until now the add-member form offered a *protocol* ("acp") as if it were a
 * product. That is the wrong noun for a user: "acp" is how we talk to an agent,
 * not which agent it is, and a roster entry reading `backend: "acp"` says
 * nothing about whether the member will be DSH, Qoder or something else. This
 * module replaces the protocol name with concrete, per-harness identities.
 *
 * Two things are deliberately kept apart:
 *
 *   1. **Protocol** — the wire format the pool speaks. Only two exist:
 *      `codex-app-server` (codex-pool.cjs) and `acp` (acp-backend.cjs). Several
 *      harnesses share the ACP implementation, which is the whole point of
 *      having written it as a protocol rather than as "the DSH backend".
 *   2. **Harness** — the product, with its own id, label, launch line and
 *      detection rule. `dsh` and `qoder` are both ACP harnesses; they differ
 *      only in what binary is started and with which arguments.
 *
 * Adding a harness is therefore a descriptor, not a code path. Claude, Gemini
 * and CodeBuddy are known-good ACP harnesses that are intentionally not listed
 * yet; each is one entry below, and nothing else in the plugin has to change.
 *
 * ## Launching on Windows, which is where the design is constrained
 *
 * Node's `spawn` does not perform PATHEXT lookup, so `spawn('qoder', [...])`
 * fails with ENOENT even when `qoder.cmd` is on PATH; and since Node 20,
 * spawning a `.cmd`/`.bat` without a shell throws `EINVAL` outright. The
 * remaining escape hatch, `{ shell: true }`, is deprecated for argument
 * injection reasons (DEP0190) and mangles any argument containing a space or a
 * quote.
 *
 * So a harness's launcher is always resolved to something that can be spawned
 * directly:
 *
 *   - a native `.exe` (codex's vendor binary, or DSH's own Electron executable);
 *   - or `node <entry.js>`, where an npm `.cmd` shim is *parsed* to recover the
 *     JS entry point it would have run.
 *
 * Nothing here is machine-specific. Paths come from `process.execPath`,
 * `process.resourcesPath`, `DSH_HOME` and PATH, so the shipped plugin stays
 * generic and the personal launch line stays in the profile layer.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROTOCOL_CODEX = 'codex-app-server';
const PROTOCOL_ACP = 'acp';

const WIN = process.platform === 'win32';

/**
 * Where DSH's ACP entry point sits inside an Electron app's `app.asar`.
 *
 * On its own, "this process is Electron" says nothing about DSH: this plugin now
 * ships its OWN standalone Electron desktop build, which also has a
 * `resources/app.asar` and also runs the code below. So a DSH install is
 * recognised by *this file being inside its asar*, and nothing weaker. The same
 * path is what an external install search looks for, which keeps "is this
 * process DSH?" and "where is DSH installed?" answering one question.
 */
const DSH_HOST_CLI = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'];

/**
 * Backend names that shipped before the registry, and what they now mean.
 *
 * Built with a null prototype so a lookup can never reach `Object.prototype`.
 * With a plain object literal, `LEGACY_BACKENDS['constructor']` returns the
 * `Object` function and `['__proto__']` returns an object: a member or config
 * naming a backend `constructor` would then resolve to a non-string, be used as
 * a pool key, and fail somewhere far from the cause. A null prototype makes the
 * lookup answer only for the keys actually listed.
 */
const LEGACY_BACKENDS = Object.assign(Object.create(null), { acp: 'dsh', 'dsh-acp': 'dsh' });

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDir(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Does this `app.asar` contain the given entry — as a real packed file?
 *
 * Two probes, because Electron's asar patch inverts which one works, and WHICH
 * one works is decided by what the asar IS in this process — `isFile` with a real
 * size under plain `node` (the offline suite, a script the user runs), a mounted
 * directory reporting size 0 under Electron. Statting the path is what tells the
 * two apart; `process.versions.electron` only describes the runtime, and a test
 * that stubs the runtime must still be able to exercise the real probe.
 *
 *   - As a file: Electron's header is a 16-byte preamble whose last four bytes
 *     are the length of the JSON directory that follows, so the directory can be
 *     read and walked. `existsSync('<asar>/dsh/...')` cannot work here — to the
 *     OS there is no such path.
 *   - As a mounted tree: `app.asar` resolves as a directory and the inner path
 *     is the proof, which is exactly what `isDshDesktopHost` asks of our own
 *     install. Reading the file's own bytes fails with ENOENT instead.
 *
 * The check is for a FILE, not merely for a name in the tree: an entry that is
 * itself a directory of the same name would otherwise pass, and every caller here
 * is asking whether a specific file was shipped.
 *
 * `segments` is a path split on `/`, since that is the separator an asar
 * directory uses regardless of platform.
 */
function asarHasEntry(asarPath, segments) {
  let stat;
  try {
    stat = fs.statSync(asarPath);
  } catch {
    return false;
  }
  if (stat.isDirectory()) {
    try {
      return isFile(path.join(asarPath, ...segments));
    } catch {
      return false;
    }
  }
  if (!stat.isFile()) return false;

  let fd;
  try {
    fd = fs.openSync(asarPath, 'r');
    const preamble = Buffer.alloc(16);
    if (fs.readSync(fd, preamble, 0, 16, 0) !== 16) return false;
    const length = preamble.readUInt32LE(12);
    // A truncated or corrupt header must not become a huge allocation: the
    // directory cannot be larger than the file it sits in.
    if (!(length > 0) || length > stat.size - 16) return false;
    const json = Buffer.alloc(length);
    if (fs.readSync(fd, json, 0, length, 16) !== length) return false;
    let tree = JSON.parse(json.toString('utf8'));
    for (const segment of segments) {
      if (!tree || !tree.files) return false;
      tree = tree.files[segment];
    }
    return Boolean(tree && !tree.files && !tree.link);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Does this `app.asar` contain a DSH desktop host? */
function asarHasDshHost(asarPath) {
  return asarHasEntry(asarPath, DSH_HOST_CLI);
}

/** Is the process we are running inside a DSH desktop host? */
function isDshDesktopHost() {
  if (!process.versions.electron || !process.resourcesPath) return false;
  return asarHasDshHost(path.join(process.resourcesPath, 'app.asar'));
}

/** The extensions `cmd.exe` would try, in its own precedence order. */
function pathExtensions() {
  if (!WIN) return [''];
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const exts = raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return ['', ...exts];
}

/**
 * Absolute-path lookup of a bare command name across PATH.
 *
 * On Windows an *extensionless* hit is skipped: npm installs a POSIX shell
 * script (`codex`, no extension) beside every `.cmd`, and that file is not
 * executable there. Returning it would produce a launcher that always fails,
 * which is worse than reporting "not found".
 */
function which(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) return isFile(name) ? name : null;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = pathExtensions();
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      if (WIN && ext === '') continue;
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Recover the JS entry point an npm `.cmd` shim would have executed.
 *
 * Every shim npm writes ends in a line like
 *   `"%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`
 * so the entry is the `.js` path relative to the shim's own directory. Parsing
 * it is what makes a shim-only install launchable without a shell.
 */
function shimEntryPoint(shim) {
  let text;
  try {
    text = fs.readFileSync(shim, 'utf8');
  } catch {
    return null;
  }
  const match = text.match(/"[%~]*dp0%\\([^"]+?\.(?:js|cjs|mjs))"/i);
  if (!match) return null;
  const entry = path.join(path.dirname(shim), match[1]);
  return isFile(entry) ? entry : null;
}

/**
 * A `node` that can be spawned directly, plus the env that makes it node.
 *
 * Preference order matters. A real `node.exe` beside the running executable is
 * the bundled DSH runtime and is the most predictable choice. Falling back to
 * `process.execPath` means "we are running inside the Electron desktop host",
 * which only behaves as node with `ELECTRON_RUN_AS_NODE=1`.
 */
function nodeRunner() {
  const beside = path.join(path.dirname(process.execPath), WIN ? 'node.exe' : 'node');
  if (isFile(beside)) return { binary: beside, env: {} };
  const onPath = which('node');
  if (onPath) return { binary: onPath, env: {} };
  return { binary: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * Turn a discovered launcher into a spawnable `{ binary, argv, env }`.
 *
 * Returns null when the hit is a `.ps1` or an unusable shim, so callers can
 * report "installed but not launchable" instead of spawning something doomed.
 */
function launchableFrom(hit) {
  if (!hit) return null;
  const ext = path.extname(hit).toLowerCase();
  if (WIN && (ext === '.cmd' || ext === '.bat')) {
    const entry = shimEntryPoint(hit);
    if (!entry) return null;
    const node = nodeRunner();
    return { binary: node.binary, argv: [entry], env: node.env, via: `node ${entry}` };
  }
  if (ext === '.ps1') return null;
  // The default branch still verifies the file is there. Callers normally pass a
  // hit from `which()` or a detector, which already checked — but this is the
  // last gate before `spawn`, and a path that does not exist fails there with an
  // error that says nothing about which harness was misconfigured.
  return isFile(hit) ? { binary: hit, argv: [], env: {}, via: hit } : null;
}

/** `$DSH_HOME`, defaulting the same way DSH itself does. */
function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.USERPROFILE || process.env.HOME;
  return home ? path.join(home, '.dsh') : null;
}

/** The profile whose `package.json` proves the ACP bundle is installed. */
function dshAcpProfileDir() {
  const home = dshHome();
  if (!home) return null;
  return path.join(home, 'profiles', 'acp');
}

/**
 * Where this install's profile directory is.
 *
 * This is the one place the question is answered, because getting it wrong is
 * silent: the directory decides whether the personal account-route patch is
 * found (see `peerAccountPatch`) and where a room's roster is stored, and an
 * empty answer degrades to "feature quietly missing" rather than to an error.
 *
 * `explicit` is the value to trust, and it comes from Cordis:
 * `ctx.get('profileContext').dir`, provided by `profile-boot` BEFORE plugins are
 * loaded, so it is populated by the time any `apply` runs.
 *
 * The environment is a FALLBACK ONLY. DSH never sets `DSH_PROFILE_DIR` in its own
 * process — `dsh-shell-env` injects it into the shells and children DSH spawns,
 * which is why it is visible to a tool shell and to a test run from one, but not
 * to the host. Preferring the variable is what made the lookup fail inside the
 * real host while passing everywhere it was tested. It is still consulted so a
 * plain `node` run (the offline suite, an embedder) can point this at a profile
 * without a Cordis context.
 *
 * A last-resort walk of our own command line covers the case of a DSH whose
 * profileContext service is missing. DSH names its profile on the command line in
 * one of two shapes, and both are accepted:
 *
 *   - `--profile <name>` — the ACP child's own form, resolved as
 *     `$DSH_HOME/profiles/<name>`;
 *   - a bare positional profile DIRECTORY — the desktop host's form, whose argv
 *     is `... dsh-desktop-host/lib/index.js <asar> <profileDir> <runtime> ...`.
 *
 * The positional form is the host this fix exists for, so it is not an
 * afterthought. A positional candidate is only accepted when it actually IS a
 * directory directly under `$DSH_HOME/profiles`, so an unrelated path argument
 * cannot be mistaken for the profile.
 */
function resolveProfileDir(explicit) {
  if (isDir(explicit)) return explicit;

  const fromEnv = process.env.DSH_PROFILE_DIR;
  if (isDir(fromEnv)) return fromEnv;

  const home = dshHome();
  if (!home) return null;
  const profilesRoot = path.join(home, 'profiles');
  const argv = Array.isArray(process.argv) ? process.argv : [];

  const at = argv.indexOf('--profile');
  const name = at !== -1 ? argv[at + 1] : null;
  if (name && !name.startsWith('-')) {
    const candidate = path.join(profilesRoot, name);
    if (isDir(candidate)) return candidate;
  }

  // The positional form: a directory that lives directly under `profiles/`. The
  // containment check is what separates a real profile argument from any other
  // path the host happens to pass (an asar path, a runtime directory, a cwd).
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg) continue;
    if (path.dirname(path.resolve(arg)) !== path.resolve(profilesRoot)) continue;
    if (isDir(arg)) return arg;
  }

  return null;
}

/**
 * The signed-in-account route patch, when the user has placed one beside the
 * profile config.
 *
 * Shipped DSH targets its API-key route, while the desktop app is signed in on
 * the account route; without this patch an ACP child starts and then cannot
 * authenticate.
 *
 * This is deliberately a PROFILE-layer file and is not shipped: the account and
 * model names in it are the user's own, so the plugin only DISCOVERS it. A
 * profile that never needed it is never handed a stray `--patch`.
 */
function peerAccountPatch(profileDir) {
  const dir = resolveProfileDir(profileDir);
  if (!dir) return null;
  const candidate = path.join(dir, 'dsh-peer-account-route.yml');
  return isFile(candidate) ? candidate : null;
}

/* -------------------------------------------------------------------------- */
/* Per-harness detection and launch                                            */
/* -------------------------------------------------------------------------- */

function detectCodex() {
  const { resolveCodexBinary } = require('./codex-pool.cjs');
  const resolved = resolveCodexBinary(null);
  if (resolved && (resolved.includes('/') || resolved.includes('\\')) && isFile(resolved)) {
    return { found: true, detail: '找到 codex 可执行文件', binary: resolved };
  }
  const hit = which('codex');
  if (hit) {
    const launch = launchableFrom(hit);
    if (launch) return { found: true, detail: '找到 codex 启动器', binary: launch.binary };
    return { found: false, detail: '找到了 codex 脚本，但无法直接启动（缺少 .js 入口或 node）', binary: hit };
  }
  return { found: false, detail: '未检测到 codex（npm i -g @openai/codex）', binary: null };
}

function launchCodex(context) {
  const configured = context.configured || {};
  if (configured.codexPath || configured.agentCommand || configured.agentPath) return {};
  const detection = detectCodex();
  if (!detection.found) return {};
  // Hand the pool the absolute path we verified. `resolveCodexBinary` would find
  // the same file, but only by repeating the search; more importantly a bare
  // name there would reach `spawn` and fail with ENOENT on Windows.
  return { codexPath: detection.binary };
}

/**
 * Find a DSH desktop app installed on this machine that we are not running in.
 *
 * A PATH lookup cannot see one: the Windows installer registers an uninstall
 * entry and writes no `dsh` command at all. Three sources, most authoritative
 * first, and the first that yields a real asar wins:
 *
 *   1. The uninstall registry. `InstallLocation` and `DisplayIcon` are written by
 *      the installer itself, so they are the install — not a guess about one.
 *      They are also the only source that survives the user picking an arbitrary
 *      directory.
 *   2. `dsh` on PATH, for a command-line install with no desktop app.
 *   3. The directories an Electron installer defaults to.
 *
 * `fs.existsSync` is deliberately NOT the test: under Electron it resolves inside
 * asars, so it would accept a path that does not exist for any other process.
 * `asarHasDshHost` proves the asar actually holds a DSH host, which is the
 * question; a directory merely NAMED like DSH is not enough.
 *
 * `candidates` is an optional explicit list of install directories, for callers
 * that already know where to look (and for tests, which must not depend on what
 * happens to be installed on the machine running them). Omitted, the search runs.
 *
 * Deliberately NOT cached in the module. The settings row has a 「重新检测」 button
 * whose whole purpose is to re-run detection after the user installs something,
 * and it calls `detectHarnesses` with the cache bypassed. A memo here would make
 * that button a lie — the user installs DSH, clicks, and is told it is missing
 * until they restart. The expensive part (a filtered `reg query`, ~20 ms) is
 * already cached briefly at the call site, which is the layer that knows how
 * stale an answer the UI can tolerate.
 */
function discoverDshInstall(candidates) {
  const list = Array.isArray(candidates) ? candidates.map(toDshCandidate) : dshInstallCandidates();
  for (const candidate of list) {
    if (candidate && asarHasDshHost(candidate.asar)) return candidate;
  }
  return null;
}

/** Normalise one install directory into the executable + asar pair. */
function toDshCandidate(input) {
  const dir = typeof input === 'string' ? input : input && input.dir;
  if (!dir || typeof dir !== 'string') return null;
  let key;
  try {
    key = path.resolve(dir);
  } catch {
    return null;
  }
  const preferred = typeof input === 'object' && input && input.exe ? input.exe : null;
  // The launcher is whatever the uninstall entry points at, when it said; the
  // standard name is the fallback. Naming the wrong executable here would break
  // the launch line while detection still reported success.
  const exe = preferred && isFile(preferred) ? preferred : path.join(key, 'DeepSeek Harness.exe');
  return { dir: key, exe, asar: path.join(key, 'resources', 'app.asar') };
}

/** The install directories worth probing, in the order they should be trusted. */
function dshInstallCandidates() {
  const found = [];
  const seen = new Set();
  const add = (input) => {
    const candidate = toDshCandidate(input);
    if (!candidate) return;
    if (seen.has(candidate.dir)) return;
    seen.add(candidate.dir);
    found.push(candidate);
  };

  for (const entry of registryDshInstalls()) add(entry);

  const hit = which('dsh');
  // A `dsh` on PATH need not be a desktop install at all; probing its directory
  // costs one asar read and covers the case where it is.
  if (hit) add(path.dirname(hit));

  const { LOCALAPPDATA, ProgramFiles, ProgramW6432 } = process.env;
  for (const base of [LOCALAPPDATA, ProgramFiles, ProgramW6432]) {
    if (!base) continue;
    add(path.join(base, 'DeepSeek Harness'));
    add(path.join(base, 'Programs', 'DeepSeek Harness'));
  }
  return found;
}

/**
 * DSH installs recorded in the Windows uninstall registry.
 *
 * `reg.exe` is used rather than a native module because this plugin has no
 * dependencies and must not grow one. A filtered query (`/f ... /d`) is an order
 * of magnitude faster than dumping the whole hive, and the filter is on the
 * display name the installer writes.
 *
 * Windows-only by construction. Any failure — a locked registry, a missing
 * `reg.exe`, a non-Windows host — degrades to "no candidates": guessing an
 * install path is never worth breaking detection over.
 *
 * Both `InstallLocation` and `DisplayIcon` are read. Electron's installer writes
 * both, and either one alone is enough to locate the install, so a machine with
 * only one of them still works. The icon carries a trailing `,0` resource index
 * and is often quoted, hence the cleanup.
 */
function registryDshInstalls() {
  if (!WIN) return [];
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const hives = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const installs = [];
  for (const hive of hives) {
    let out;
    try {
      out = execFileSync(reg, ['query', hive, '/s', '/f', 'DeepSeek Harness', '/d'], {
        windowsHide: true,
        timeout: 5000,
        // `reg.exe` emits the console codepage; field names and the ASCII part of
        // a path survive any decode, and a mojibake non-ASCII path simply fails
        // the asar probe below rather than launching something wrong.
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    for (const install of parseDshInstallEntries(String(out))) installs.push(install);
  }
  return installs;
}

/**
 * The DSH installs described in one `reg query` dump.
 *
 * Split out from the query so the parsing can be tested against fixture text: the
 * real registry only ever describes the machine the suite happens to run on, and
 * a test that only passes on the author's laptop measures the laptop.
 *
 * `reg query` prints one `HKEY_...` block per key with indented `Name  REG_SZ
 * value` lines. The dump is unparsable as a whole (`reg.exe` writes UTF-16 into a
 * console codepage, and a single value can wrap), so blocks are split on the next
 * `HKEY_` at the start of a line and each is matched independently.
 */
function parseDshInstallEntries(text) {
  const installs = [];
  for (const block of String(text || '').split(/\r?\n(?=HKEY_)/)) {
    // The filtered query can match a neighbouring key by VALUE, so an entry is
    // only trusted once its own display name says DSH.
    if (!/DisplayName\s+REG_SZ\s+.*DeepSeek Harness/i.test(block)) continue;
    const location = block.match(/InstallLocation\s+REG_SZ\s+(.+)/);
    const icon = block.match(/DisplayIcon\s+REG_SZ\s+(.+)/);
    const iconExe = icon ? unquote(icon[1].replace(/,\s*-?\d+\s*$/, '')) : null;
    const dir = location ? unquote(location[1]) : iconExe ? path.dirname(iconExe) : null;
    if (!dir) continue;
    installs.push({ dir, exe: iconExe });
  }
  return installs;
}

/** Strip the quotes `reg.exe` may leave around a `REG_SZ` value. */
function unquote(value) {
  return String(value).trim().replace(/^"(.*)"$/, '$1');
}

/**
 * `candidates` is an optional explicit list of install directories, threaded
 * straight to `discoverDshInstall`. It exists so the discovery path can be
 * exercised end to end without depending on what happens to be installed on the
 * machine running the test — the wiring from "an install was found" to "the
 * detection row says so" is precisely what regresses silently.
 */
function detectDsh(candidates) {
  // 1. Running inside DSH counts as "present" by definition, but ONLY once the
  // process is proven to be DSH. The older rule ("Electron with a resourcesPath")
  // was also true inside this plugin's own standalone desktop build, which then
  // reported a DSH that did not exist and derived a launch line pointing at its
  // own asar. What can still be missing here is the ACP profile.
  if (isDshDesktopHost()) {
    const profile = dshAcpProfileDir();
    if (profile && isFile(path.join(profile, 'package.json'))) {
      return { found: true, detail: '当前进程即 DSH，且 acp profile 已安装', binary: process.execPath };
    }
    return {
      found: true,
      detail: '当前进程即 DSH，但未找到 acp profile（可用 dsh 安装 @deepseek-ai/dsh-acp-app）',
      binary: process.execPath,
    };
  }

  // 2. A DSH desktop app installed on this machine that we are NOT running
  // inside — the case a PATH lookup cannot see, because the installer adds no
  // `dsh` command. This is what lets the standalone build reach a real DSH.
  const install = discoverDshInstall(candidates);
  if (install) {
    return { found: true, detail: `找到已安装的 DSH 桌面端：${install.dir}`, binary: install.exe };
  }

  // 3. A `dsh` command on PATH, for a CLI install with no desktop app.
  const hit = which('dsh');
  if (hit) {
    const launch = launchableFrom(hit);
    if (launch) return { found: true, detail: '在 PATH 中找到 dsh', binary: launch.binary };
  }

  return {
    found: false,
    detail: '未检测到 dsh（PATH 上没有 dsh，本机也没有已安装的 DSH 桌面端，且当前进程不是 DSH）',
    binary: null,
  };
}

/**
 * The ACP child's launch line for a desktop install.
 *
 * Shared by "our own install" and "an install we found", because the two cases
 * differ only in which executable and which asar they name — deriving them twice
 * is how one of them drifts. Both relaunch the app's own binary as node
 * (`ELECTRON_RUN_AS_NODE`) so the asar's `cli.js` runs headless.
 *
 * The `cli.js` path is not existence-checked here: the caller has already proven
 * the same path resolves inside `asar`, and re-probing would measure the probe.
 */
function acpLaunchLine(executable, asar, profileDir) {
  const argv = ['--expose-internals', path.join(asar, ...DSH_HOST_CLI), '--profile', 'acp'];
  // The profile directory arrives from the host's `profileContext`; reading it
  // from the environment alone is what silently dropped this patch.
  const patch = peerAccountPatch(profileDir);
  if (patch) argv.push('--patch', patch);
  return {
    agentCommand: executable,
    agentArgs: argv,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    // DSH's ACP profile refuses SOCKS and logs a warning per start, so the
    // ambient socks5h default is actively harmful for this harness.
    proxy: false,
  };
}

function launchDsh(context) {
  const configured = context.configured || {};
  // An explicit launch line always wins: a user who wrote `agentCommand` has an
  // install we cannot guess better than they can.
  if (configured.agentCommand || configured.agentPath || configured.agentArgs) return {};

  // Inside the desktop host: re-launch our own executable as node and let it
  // boot the ACP profile. Built from `process.execPath`/`resourcesPath`, so the
  // same line works from any install directory.
  if (isDshDesktopHost()) {
    return acpLaunchLine(process.execPath, path.join(process.resourcesPath, 'app.asar'), context.profileDir);
  }

  // A desktop install we are NOT inside: re-launch ITS executable as node against
  // ITS asar. Without this the standalone build derived `{}` and the member could
  // not start at all, even with DSH installed two directories away.
  //
  // `context.candidates` mirrors the argument `detectDsh` takes, so a test can
  // drive the whole "found an install → built a line from it" path against a
  // fixture. Production leaves it undefined and the real search runs.
  const install = discoverDshInstall(context.candidates);
  if (install) return acpLaunchLine(install.exe, install.asar, context.profileDir);

  const hit = which('dsh');
  if (hit) {
    const launch = launchableFrom(hit);
    if (launch) {
      return {
        agentCommand: launch.binary,
        agentArgs: [...launch.argv, '--profile', 'acp'],
        env: launch.env,
        proxy: false,
      };
    }
  }
  return {};
}

/* -------------------------------------------------------------------------- */
/* Qoder                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Where Qoder's desktop builds keep the SDK worker that speaks ACP.
 *
 * Two package names, because the international build ships `qoder-agent-sdk`
 * where the CN build ships `qoder-cn-agent-sdk`. Both are tried rather than
 * keyed off the executable's name: a `Qoder.exe` that happens to carry the CN
 * SDK is a working install, and refusing it over the filename would be wrong.
 */
const QODER_SDKS = ['qoder-cn-agent-sdk', 'qoder-agent-sdk'];

/** The worker runtime and the asar entry that must both exist for one SDK. */
function qoderWorkerPaths(resources, sdk) {
  return {
    worker: path.join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      '@qoder-ai',
      sdk,
      'dist',
      '_worker',
      'qoder-worker-runtime.obf.mjs',
    ),
    // Pre-split, because `asarHasEntry` walks the archive's directory tree segment
    // by segment and a raw string would be walked one character at a time.
    entry: ['node_modules', '@qoder-ai', sdk, 'dist', 'index.js'],
  };
}

/**
 * The launch line for a Qoder desktop install rooted at `exe`'s directory.
 *
 * A Qoder desktop install is three things at once, and all three are checked
 * before the install is trusted:
 *
 *   1. the executable (what we relaunch as node),
 *   2. an SDK entry INSIDE `resources/app.asar` — read out of the archive header,
 *      because the packed file is not a real path for anything but Electron, and
 *   3. the worker runtime NEXT TO it, unpacked, which is the file we actually
 *      hand to `worker_threads`.
 *
 * Checking (3) alone is not enough: the unpacked directory is also where a stale
 * version's leftovers live, so an install whose asar no longer matches would
 * otherwise be reported as working. Checking (2) alone is not enough either —
 * the asar records what was packed, not what survived an interrupted update.
 *
 * Returns null when this directory is not a Qoder desktop install with a usable
 * SDK, which is a normal answer, not an error.
 */
function qoderDesktopLaunch(exe) {
  if (!exe || !isFile(exe)) return null;
  const resources = path.join(path.dirname(exe), 'resources');
  for (const sdk of QODER_SDKS) {
    const { worker, entry } = qoderWorkerPaths(resources, sdk);
    if (!isFile(worker)) continue;
    if (!asarHasEntry(path.join(resources, 'app.asar'), entry)) continue;
    return {
      agentCommand: exe,
      // The worker runs INSIDE Qoder's binary, so the bridge is the child and the
      // worker runtime is its argument. See lib/qoder-worker.cjs.
      agentArgs: [path.join(__dirname, 'qoder-worker.cjs'), worker],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      // Qoder's worker is a local process; routing it through the ambient SOCKS
      // default would break it the same way it breaks DSH's ACP profile.
      proxy: false,
      kind: '桌面后端',
    };
  }
  return null;
}

/**
 * Qoder desktop installs, best candidate first.
 *
 * Qoder's Windows installer writes no `qoder`/`qodercli` command and no
 * `InstallLocation`: its uninstall entry carries only a `DisplayIcon` pointing at
 * an `.ico`, so a directory has to be recovered from a path the entry happens to
 * carry. Two sources can do that, and they are NOT equally good:
 *
 *   - The launcher's `state.ini` names the versioned `appExecutable` the launcher
 *     would actually start. This is the live build, and it is the only source
 *     that identifies a version rather than just a directory.
 *   - The uninstall registry names the install ROOT only. The root carries a
 *     legacy full copy of the app beside `.qoder-versions/`, and the two are
 *     different builds — on this machine the root copy is an older, smaller one
 *     than the 0.4.8 actually running. So the ROOT copy is the last resort, not
 *     the first.
 *
 * Hence the explicit ranks below rather than a filesystem order: getting this
 * wrong launches a stale Qoder whose login session does not exist. Ranks also
 * make the version sort meaningful — `.qoder-versions` is sorted numerically
 * descending, so 0.4.10 is correctly preferred over 0.4.8.
 */
function qoderInstallCandidates(options = {}) {
  const env = options.env || process.env;
  const launcherInstalls = options.launcherInstalls || qoderLauncherInstalls;
  const registryInstalls = options.registryInstalls || registryQoderInstalls;
  const found = [];
  const seen = new Map();
  // Lower rank wins; a path already recorded keeps the better of the two ranks.
  const push = (exe, rank) => {
    if (!exe || typeof exe !== 'string') return;
    let key;
    try {
      key = path.resolve(exe);
    } catch {
      return;
    }
    const existing = seen.get(key.toLowerCase());
    if (existing) {
      if (rank < existing.rank) existing.rank = rank;
      return;
    }
    const row = { exe: key, rank };
    seen.set(key.toLowerCase(), row);
    found.push(row);
  };
  const addRoot = (dir, exe, base) => {
    if (!dir || typeof dir !== 'string') return;
    let key;
    try {
      key = path.resolve(dir);
    } catch {
      return;
    }
    // The launcher's own pick, when it said one. `appExecutable` is relative to
    // `installDir` on this layout (`.qoder-versions\0.4.8\Qoder CN.exe`), but a
    // bare name in older `install.ini` files resolves the same way.
    if (exe) push(path.isAbsolute(exe) ? exe : path.join(key, exe), base);
    qoderVersions(key).forEach((version, index) => {
      for (const name of QODER_EXE_NAMES) {
        push(path.join(key, '.qoder-versions', version, name), base + 10 + index);
      }
    });
    for (const name of QODER_EXE_NAMES) push(path.join(key, name), base + 20);
  };

  // 0: the launcher's live build. 100/200: roots recovered from elsewhere, whose
  // version is unknown, so the versioned dirs inside them decide.
  for (const install of launcherInstalls()) addRoot(install.dir, install.exe, 0);
  for (const install of registryInstalls()) addRoot(install.dir, install.exe, 100);

  // Last resort: the defaults an installer picks when the user does not choose a
  // directory, for a Qoder we could not otherwise locate. Nothing here is
  // authoritative — each is simply probed, and a miss costs one failed stat.
  //
  // The two scopes are kept apart on purpose. `Programs\` is a PER-USER
  // convention (`%LOCALAPPDATA%\Programs\Qoder`); joining it onto `Program Files`
  // would invent `C:\Program Files\Programs\Qoder`, a path that cannot exist and
  // that only makes the candidate list misleading to read.
  for (const name of QODER_EXE_NAMES) {
    if (env.LOCALAPPDATA) {
      push(path.join(env.LOCALAPPDATA, 'Qoder', name), 300);
      push(path.join(env.LOCALAPPDATA, 'Programs', 'Qoder', name), 300);
      push(path.join(env.LOCALAPPDATA, 'Qoder CN', name), 300);
      push(path.join(env.LOCALAPPDATA, 'Programs', 'Qoder CN', name), 300);
    }
    // The CN build installs under its own product directory, whichever scope.
    for (const base of [env.ProgramFiles, env.ProgramW6432]) {
      if (!base) continue;
      push(path.join(base, 'Qoder', name), 300);
      push(path.join(base, 'Qoder CN', name), 300);
    }
  }

  found.sort((a, b) => a.rank - b.rank);
  return found.map((row) => row.exe);
}

/** Every name a Qoder desktop executable ships under, CN build first. */
const QODER_EXE_NAMES = ['Qoder CN.exe', 'Qoder.exe'];

/** Version directories under a launcher-style install, newest first. */
function qoderVersions(dir) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, '.qoder-versions'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    // Descending by the numeric parts of the name, so 0.4.10 beats 0.4.8 — a
    // plain string sort would prefer the older one and launch it.
    .map((entry) => entry.name)
    .sort((a, b) =>
      String(b).localeCompare(String(a), undefined, { numeric: true, sensitivity: 'base' }),
    );
}

/**
 * Qoder installs read from the launcher's own `state.ini`.
 *
 * `installDir` is an absolute path and `appExecutable` is RELATIVE TO IT on this
 * layout (`.qoder-versions\0.4.8\Qoder CN.exe`), while `install.ini` from an
 * older version writes a bare name. Both are joined against `installDir` unless
 * already absolute, which is why the caller does the joining.
 *
 * Parsed with a regex rather than an INI library: the plugin has no dependencies
 * by design, and this file has exactly two keys we want.
 */
function qoderLauncherInstalls() {
  const { LOCALAPPDATA, APPDATA } = process.env;
  const files = [];
  for (const base of [LOCALAPPDATA, APPDATA]) {
    if (!base) continue;
    for (const product of ['Qoder CN', 'Qoder']) {
      files.push(path.join(base, product, `${product} Launcher`, 'state.ini'));
      files.push(path.join(base, product, `${product} Launcher`, 'install.ini'));
      files.push(path.join(base, product, 'Launcher', 'state.ini'));
    }
  }
  const installs = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const row = parseQoderLauncherState(text);
    if (row) installs.push(row);
  }
  return installs;
}

/**
 * The install one launcher INI describes.
 *
 * Split from the file read so it can be tested against fixture text — the real
 * state file only ever describes this machine's install, and a test bound to it
 * would measure the laptop rather than the parser.
 */
function parseQoderLauncherState(text) {
  const read = (key) => {
    const match = String(text || '').match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'im'));
    return match ? match[1].replace(/^"(.*)"$/, '$1') : null;
  };
  const dir = read('installDir');
  if (!dir) return null;
  return { dir, exe: read('appExecutable') };
}

/**
 * Qoder installs recorded in the Windows uninstall registry.
 *
 * Qoder writes NO `InstallLocation`, so the directory is recovered from either
 * `DisplayIcon` or `UninstallString` and the caller is not told which — the
 * value is a path either way. The icon carries a `,0` resource index that must be
 * stripped BEFORE unquoting, the same ordering the DSH reader needs.
 */
function registryQoderInstalls() {
  if (!WIN) return [];
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const hives = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const installs = [];
  for (const hive of hives) {
    let out;
    try {
      out = execFileSync(reg, ['query', hive, '/s', '/f', 'Qoder', '/d'], {
        windowsHide: true,
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    for (const install of parseQoderInstallEntries(String(out))) installs.push(install);
  }
  return installs;
}

/**
 * The Qoder installs described in one `reg query` dump.
 *
 * Same shape as the DSH parser, and the same reason for splitting it out: the
 * fixture text is the only way to test the parse without the machine's registry.
 *
 * `UninstallString` is a full command line (`"D:\...\Uninstall Qoder CN.exe"
 * /currentuser`), so the executable is read out of the leading quoted token and
 * its directory taken — reading the whole line as a path would produce a
 * "directory" with arguments glued on.
 */
function parseQoderInstallEntries(text) {
  const installs = [];
  for (const block of String(text || '').split(/\r?\n(?=HKEY_)/)) {
    // A value filter matches neighbouring keys too, so the display name must
    // vouch for the block before any of its paths are trusted. "Qoder" alone
    // would also match an unrelated product that merely mentions it.
    if (!/DisplayName\s+REG_SZ\s+.*\bQoder\b/i.test(block)) continue;
    const icon = block.match(/DisplayIcon\s+REG_SZ\s+(.+)/);
    const iconPath = icon ? unquote(icon[1].replace(/,\s*-?\d+\s*$/, '')) : null;
    const uninstall = block.match(/UninstallString\s+REG_SZ\s+(.+)/);
    let uninstallExe = null;
    if (uninstall) {
      const quoted = String(uninstall[1]).trim().match(/^"([^"]+)"/);
      uninstallExe = quoted ? quoted[1] : String(uninstall[1]).trim().split(/\s+/)[0];
    }
    // The icon is preferred: it sits in the install root, whereas the uninstaller
    // is one directory down in some layouts. Either locates the same install.
    const anchor = iconPath || uninstallExe;
    if (!anchor) continue;
    const dir = path.dirname(anchor);
    // An `.ico` directly in the root is the normal layout, but an install that
    // puts icons in a subdirectory would make `dirname` one level short.
    const root = /[\\/]resources[\\/][^\\/]+$/i.test(dir) ? path.dirname(dir) : dir;
    installs.push({ dir: root, exe: null });
  }
  return installs;
}

/**
 * A Qoder install is preferred when it is RUNNING.
 *
 * A machine can hold several (CN and international, or a stale version beside the
 * live one). The one the user is actually running is the one whose login session
 * and SDK version are known-good, so it is tried first; everything else is still
 * offered, since a stopped Qoder is perfectly usable.
 *
 * `tasklist` reports a process's image NAME and not its directory, so a running
 * "Qoder CN.exe" can only vouch for candidates with that same basename — which is
 * still enough to separate the CN build from the international one, and it never
 * claims to know more than it does. The valid installs are resolved once here
 * rather than inside the comparator, which would re-read an asar per comparison.
 */
function qoderInstalls() {
  const running = runningQoderNames();
  const valid = [];
  for (const exe of qoderInstallCandidates()) {
    const launch = qoderDesktopLaunch(exe);
    if (launch) valid.push({ exe, launch, running: running.has(path.basename(exe).toLowerCase()) });
  }
  valid.sort((a, b) => Number(b.running) - Number(a.running));
  return valid;
}

/** Lowercased image names of the Qoder processes that are running now. */
function runningQoderNames() {
  const running = new Set();
  if (!WIN) return running;
  const tasklist = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe');
  let out;
  try {
    out = execFileSync(tasklist, ['/FI', 'IMAGENAME eq Qoder CN.exe', '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return running;
  }
  for (const line of String(out).split(/\r?\n/)) {
    const name = line.match(/^"([^"]+)"/);
    // `tasklist` prints an informational line instead of CSV when nothing
    // matched, which the quote anchor already rejects.
    if (name) running.add(name[1].toLowerCase());
  }
  return running;
}

/**
 * Qoder desktop detection.
 *
 * Four sources, most trustworthy first:
 *
 *   1. A RUNNING Qoder whose install probes clean — the user's real, logged-in
 *      build, and the only source that is right when several versions coexist.
 *   2. A desktop install found via the launcher's `state.ini` or the uninstall
 *      registry. This is what a PATH lookup cannot see, and it is the common case
 *      on Windows: Qoder ships no `qoder` command.
 *   3. `qodercli`/`qoder` on PATH, for a CLI-only install.
 *   4. A negative message naming the two ways to get one.
 *
 * `candidates` is an optional explicit list of executables, for callers that
 * already know where to look and for tests, which must not depend on what happens
 * to be installed on the machine running them.
 */
function detectQoder(candidates) {
  const installs = Array.isArray(candidates)
    ? candidates
        .map((exe) => ({ exe, launch: qoderDesktopLaunch(exe) }))
        .filter((install) => install.launch)
    : qoderInstalls();
  // The international build's executable is `Qoder.exe`; only probe for it when
  // the CN probe found nothing, so the common install costs one tasklist call.
  if (!installs.length && !Array.isArray(candidates)) {
    for (const exe of qoderInternationalCandidates()) {
      const launch = qoderDesktopLaunch(exe);
      if (launch) return { found: true, detail: `找到 Qoder 桌面后端：${exe}`, binary: exe, launch };
    }
  }
  if (installs.length) {
    const chosen = installs[0];
    return {
      found: true,
      detail: `找到 Qoder 桌面后端：${chosen.exe}`,
      binary: chosen.exe,
      launch: chosen.launch,
    };
  }

  // `qodercli` is the same package's second bin, so either name is a hit.
  for (const name of ['qoder', 'qodercli']) {
    const hit = which(name);
    if (!hit) continue;
    const launch = launchableFrom(hit);
    if (launch) return { found: true, detail: `在 PATH 中找到 ${name}`, binary: launch.binary };
    return { found: false, detail: `找到了 ${name}，但无法直接启动`, binary: hit };
  }
  return {
    found: false,
    detail: '未检测到 Qoder（安装 Qoder 桌面版，或 npm i -g @qoder-ai/qodercli）',
    binary: null,
  };
}

/** The international build's executable, probed only when the CN names missed. */
function qoderInternationalCandidates() {
  const found = [];
  const { LOCALAPPDATA, ProgramFiles, ProgramW6432 } = process.env;
  for (const base of [LOCALAPPDATA, ProgramFiles, ProgramW6432]) {
    if (!base) continue;
    found.push(path.join(base, 'Qoder', 'Qoder.exe'));
    found.push(path.join(base, 'Programs', 'Qoder', 'Qoder.exe'));
    found.push(path.join(base, 'Qoder', 'Qoder CN.exe'));
    found.push(path.join(base, 'Programs', 'Qoder', 'Qoder CN.exe'));
  }
  for (const install of registryQoderInstalls()) {
    found.push(path.join(install.dir, 'Qoder.exe'));
    found.push(path.join(install.dir, 'Qoder CN.exe'));
  }
  return found;
}

function launchQoder(context) {
  const configured = context.configured || {};
  if (configured.agentCommand || configured.agentPath || configured.agentArgs) return {};
  const detection = detectQoder(context.candidates);
  if (!detection.found) return {};
  // A desktop install carries its own launch line, which cannot be re-derived from
  // the executable alone (it needs the SDK worker beside it). Recomputing it here
  // would be a second copy of the SDK-name search.
  if (detection.launch) return { ...detection.launch };
  const hit = detection.binary;
  if (!hit) return {};
  const launch = launchableFrom(hit);
  if (!launch) return {};
  return {
    agentCommand: launch.binary,
    // The CLI's ACP mode is a flag, not a subcommand: `qoder --acp`.
    agentArgs: [...launch.argv, '--acp'],
    env: launch.env,
    proxy: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every harness the plugin can run, in the order they are offered.
 *
 * `protocol` selects the pool implementation; it is the only field the engine
 * looks at. Everything else is presentation or launching.
 */
const HARNESSES = [
  {
    id: 'codex',
    label: 'codex（本机 codex 会话）',
    short: 'codex',
    protocol: PROTOCOL_CODEX,
    detect: detectCodex,
    launch: launchCodex,
  },
  {
    id: 'dsh',
    label: 'DSH（DeepSeek Harness，ACP）',
    short: 'DSH',
    protocol: PROTOCOL_ACP,
    detect: detectDsh,
    launch: launchDsh,
  },
  {
    id: 'qoder',
    label: 'Qoder（桌面版 / qoder --acp）',
    short: 'Qoder',
    protocol: PROTOCOL_ACP,
    detect: detectQoder,
    launch: launchQoder,
  },
];

function harnessIds() {
  return HARNESSES.map((entry) => entry.id);
}

function harnessById(id) {
  return HARNESSES.find((entry) => entry.id === id) || null;
}

/**
 * Fold a backend name onto its canonical harness id.
 *
 * Two jobs, both about the same failure — one harness ending up with two pools,
 * or a member pointing at a pool that does not exist:
 *
 *   1. **Legacy names.** The persisted roster on disk still says
 *      `backend: "acp"` for the member that was running DSH, and a room's saved
 *      config may say the same. An unknown backend throws in `_createPool`, so
 *      without this a restart would take the whole room down.
 *   2. **Case.** `Qoder`, `qoder` and `QODER` must be one harness. Backend names
 *      are used as pool keys, config keys and directory names, so a difference
 *      in case would silently produce a second pool with no launch line, and a
 *      member on it would fail for no visible reason. Names are therefore
 *      lowercased, including unknown ones, so a hand-registered `MyAgent` and
 *      `myagent` also collapse together.
 */
function canonicalBackend(name) {
  const key = name == null ? '' : String(name);
  if (!key) return '';
  const lower = key.toLowerCase();
  const mapped = LEGACY_BACKENDS[lower];
  return typeof mapped === 'string' && mapped ? mapped : lower;
}

/**
 * The message every row carries while detection has not been authorised.
 *
 * It names the place the user can answer, because a row that says only "未检测到"
 * while we deliberately never looked is a lie — and the one the user cannot act
 * on. `blocked` on the row is what lets the UI tell the two apart.
 */
const UNAUTHORISED_DETAIL = '未检测：需要先选择是否允许自动检测本机后端';

/** Run every detection rule. Fast and side-effect free: filesystem and PATH.
 *
 * ## Why this can refuse to look
 *
 * Detection reads PATH, queries the registry, and walks install directories. That
 * is a scan of the user's machine performed on the plugin's own initiative — the
 * user did not ask for it, and on a first run they have not agreed to it either.
 * `allowAuto: false` therefore makes this return rows that say "not looked at"
 * WITHOUT touching any of those sources.
 *
 * It defaults to true so that the contract test and any direct caller keep the
 * old behaviour, and so that a caller who has no opinion cannot accidentally
 * disable a working install. The SERVER is the layer that knows the user's
 * choice and always passes it, which is what makes the gate real.
 *
 * Note that this gates DETECTION only, not launch resolution. By the time a
 * member starts, the user has committed to that backend, and refusing to look
 * there would surface as a misleading "not found" rather than as the honest
 * "I will not look" state the UI shows. A user who declined the scan can still
 * reach a harness by configuring its launch line by hand.
 */
function detectHarnesses(options = {}) {
  const allowAuto = options.allowAuto !== false;
  const blockedDetail = options.detail || UNAUTHORISED_DETAIL;
  return HARNESSES.map((entry) => {
    if (!allowAuto) {
      return {
        id: entry.id,
        label: entry.label,
        short: entry.short,
        protocol: entry.protocol,
        found: false,
        // Never scanned, as opposed to scanned-and-absent. The UI must not
        // present this as "未检测到", and `forced` on an enabled row must not be
        // read as "you insisted on something that is missing".
        blocked: true,
        detail: blockedDetail,
        binary: null,
      };
    }
    let result;
    try {
      result = entry.detect();
    } catch (error) {
      result = { found: false, detail: `检测失败：${error.message}`, binary: null };
    }
    return {
      id: entry.id,
      label: entry.label,
      short: entry.short,
      protocol: entry.protocol,
      found: !!result.found,
      blocked: false,
      detail: result.detail,
      binary: result.binary || null,
    };
  });
}

/**
 * Pool options contributed by a harness: the raw default layer, unmerged.
 *
 * Returns `{}` for an unknown harness, and for one whose launcher cannot be
 * resolved on this machine — in which case the pool's own "no ACP agent
 * configured" error is the right thing for the user to see.
 */
function launchOptions(id, configured, profileDir) {
  const entry = harnessById(canonicalBackend(id));
  if (!entry || typeof entry.launch !== 'function') return {};
  try {
    // `profileDir` is passed as its OWN argument, never folded into `configured`:
    // `mergeLaunch` copies every non-`env` key of the configuration onto the
    // pool's option object, so a plumbing key smuggled in there would be handed
    // to the pool as though the user had configured it.
    return entry.launch({ configured: configured || {}, profileDir }) || {};
  } catch {
    return {};
  }
}

/**
 * Layer a harness's default launch line under the user's configuration.
 *
 * The rule is per-key: anything the configuration set wins, so a user who wrote
 * `agentCommand` gets exactly the command they wrote. The single exception is
 * `env`, which MERGES — a harness may need `ELECTRON_RUN_AS_NODE` to be a
 * working node at all, and a config that adds one variable of its own must not
 * silently drop that. Keeping this rule in one function is what stops the two
 * call sites from drifting apart.
 */
function mergeLaunch(derived, configured) {
  const own = configured || {};
  const out = { ...(derived || {}) };
  for (const [key, value] of Object.entries(own)) {
    if (key === 'env') continue;
    out[key] = value;
  }
  const env = { ...((derived && derived.env) || {}), ...(own.env || {}) };
  if (Object.keys(env).length) out.env = env;
  else delete out.env;
  return out;
}

/** A one-line, UI-safe description of what a harness would be started with. */
function describeLaunch(options) {
  if (!options) return null;
  const binary = options.agentCommand || options.agentPath || options.codexPath || null;
  if (!binary) return null;
  const argv = Array.isArray(options.agentArgs) ? options.agentArgs : [];
  return [binary, ...argv].join(' ');
}

/**
 * Which harnesses the add-member form offers, and the user's say in it.
 *
 * The rule is "detected by default, overridable by hand":
 *
 *   - No stored choice (`enabled === null`) means AUTOMATIC: offer exactly what
 *     detection found on this machine. An install therefore works with no
 *     configuration, and a harness the user installs later appears on its own.
 *   - A stored list means the user decided: offer those, whether or not
 *     detection agrees. Enabling a harness that was not found is legitimate —
 *     detection is a guess about paths, and a user who launches a harness
 *     through a wrapper script knows something we do not.
 *
 * `codex` is never dropped from the automatic set even when its binary is not
 * found, because it is the room's primary backend and a room with no backend at
 * all would fail to construct rather than fail informatively at a turn.
 */
class HarnessStore {
  constructor(options = {}) {
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.dir = options.dir || null;
    this.file = this.dir ? path.join(this.dir, 'harnesses.json') : null;
    /** `null` means "automatic": follow detection. See the class comment. */
    this.enabled = null;
    this.load();
  }

  load() {
    if (!this.file) return this.enabled;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.(`harnesses read failed: ${error.message}`);
      return this.enabled;
    }
    try {
      const parsed = JSON.parse(raw);
      const list = parsed && parsed.enabled;
      // An explicit empty array is a real choice ("offer nothing"), so it must
      // survive; only a missing/invalid value falls back to automatic.
      if (Array.isArray(list)) this.enabled = this._sanitize(list);
    } catch (error) {
      this.logger?.(`harnesses parse failed: ${error.message}`);
    }
    return this.enabled;
  }

  /** Keep only known harness ids, canonicalised and de-duplicated. */
  _sanitize(list) {
    const out = [];
    for (const entry of list) {
      const id = canonicalBackend(entry);
      if (!harnessById(id)) continue;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  get() {
    return this.enabled;
  }

  update(patch) {
    const raw = patch && Object.prototype.hasOwnProperty.call(patch, 'enabled') ? patch.enabled : undefined;
    if (raw === null || raw === undefined) this.enabled = null;
    else if (Array.isArray(raw)) this.enabled = this._sanitize(raw);
    else this.enabled = null;
    this.save();
    return this.enabled;
  }

  save() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, enabled: this.enabled }, null, 2) + '\n', 'utf8');
      fs.renameSync(temp, this.file);
      return true;
    } catch (error) {
      this.logger?.(`harnesses save failed: ${error.message}`);
      return false;
    }
  }

  /**
   * The harness rows to show: every registry entry, plus what was detected and
   * whether it is currently offered.
   */
  rows(detections) {
    const found = detections || detectHarnesses();
    const offered = this.effective(found);
    return found.map((row) => ({
      ...row,
      enabled: offered.includes(row.id),
      // Distinguishes "the user turned it on even though we could not find it"
      // from an ordinary row, so the UI can warn instead of silently offering
      // a harness that will fail at its first turn.
      //
      // A row we never looked for is NOT that case: it is unchecked because there
      // was no scan, not because the harness is missing, and calling it "强制启用"
      // would blame the user for our own refusal to look.
      forced: !row.blocked && offered.includes(row.id) && !row.found,
    }));
  }

  /** The ids the add-member form should offer, given what detection found. */
  effective(detections) {
    if (this.enabled) return this.enabled.slice();
    const found = detections || detectHarnesses();
    const ids = found.filter((row) => row.found).map((row) => row.id);
    if (!ids.includes('codex')) ids.unshift('codex');
    return ids;
  }
}

/** Where the harness selection lives: its own directory beside the rooms. */
function defaultHarnessDir(roomsDir) {
  if (!roomsDir) return null;
  return path.join(path.dirname(roomsDir), 'agent-room-harnesses');
}

/**
 * Whether this machine's installs may be scanned at all, and the user's answer.
 *
 * ## The three states, and why "no answer" is one of them
 *
 *   - `null` — the user has never been asked. Detection is NOT allowed, and the
 *     UI must ask before anything is scanned. This is the state that makes the
 *     first run honest: the plugin arrives with no permission and takes none.
 *   - `'automatic'` — asked and allowed. Detection runs as before.
 *   - `'manual'` — asked and declined. Nothing is scanned; the user configures a
 *     launch line themselves or ticks a harness on by hand.
 *
 * Collapsing "never asked" into either answer is the bug this class exists to
 * prevent. Defaulting it to `'automatic'` would scan a machine the user was never
 * consulted about; defaulting it to `'manual'` would leave a fresh install unable
 * to find a backend it has, with no hint that a question is waiting.
 *
 * The file lives beside `harnesses.json` because the two are one subject — which
 * harnesses this machine may use — and splitting them across directories would
 * give `HarnessStore`'s directory nothing to be the answer for.
 */
class ConsentStore {
  constructor(options = {}) {
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.dir = options.dir || null;
    this.file = this.dir ? path.join(this.dir, 'discovery-consent.json') : null;
    /** `null` = never asked. See the class comment. */
    this.choice = null;
    this.load();
  }

  load() {
    if (!this.file) return this.choice;
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger?.(`consent read failed: ${error.message}`);
      return this.choice;
    }
    try {
      this.choice = normalizeConsent(JSON.parse(raw)?.choice);
    } catch (error) {
      this.logger?.(`consent parse failed: ${error.message}`);
    }
    return this.choice;
  }

  get() {
    return this.choice;
  }

  /** Has the user actually answered? `false` means the UI must ask. */
  answered() {
    return this.choice === 'automatic' || this.choice === 'manual';
  }

  /**
   * Record the user's answer.
   *
   * `null` clears it back to "never asked", which is the right response to a
   * corrupt file or a user who wants to be consulted again — it re-arms the
   * question rather than silently picking an answer for them.
   */
  update(patch) {
    const raw = patch && Object.prototype.hasOwnProperty.call(patch, 'choice') ? patch.choice : undefined;
    if (raw === null || raw === undefined) this.choice = null;
    else this.choice = normalizeConsent(raw);
    this.save();
    return this.choice;
  }

  save() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, choice: this.choice }, null, 2) + '\n', 'utf8');
      fs.renameSync(temp, this.file);
      return true;
    } catch (error) {
      this.logger?.(`consent save failed: ${error.message}`);
      return false;
    }
  }
}

/** Fold any stored value onto the three states the store admits. */
function normalizeConsent(value) {
  return value === 'automatic' || value === 'manual' ? value : null;
}

/** Should detection be allowed to touch the machine? Only an explicit yes. */
function allowsAutoDetection(choice) {
  return normalizeConsent(choice) === 'automatic';
}

module.exports = {
  HARNESSES,
  HarnessStore,
  ConsentStore,
  PROTOCOL_ACP,
  PROTOCOL_CODEX,
  UNAUTHORISED_DETAIL,
  acpLaunchLine,
  allowsAutoDetection,
  asarHasDshHost,
  asarHasEntry,
  canonicalBackend,
  defaultHarnessDir,
  describeLaunch,
  detectDsh,
  detectHarnesses,
  detectQoder,
  discoverDshInstall,
  dshAcpProfileDir,
  harnessById,
  harnessIds,
  isDshDesktopHost,
  launchOptions,
  launchQoder,
  launchableFrom,
  mergeLaunch,
  nodeRunner,
  normalizeConsent,
  parseDshInstallEntries,
  parseQoderInstallEntries,
  parseQoderLauncherState,
  peerAccountPatch,
  qoderDesktopLaunch,
  qoderInstallCandidates,
  qoderLauncherInstalls,
  registryDshInstalls,
  registryQoderInstalls,
  resolveProfileDir,
  shimEntryPoint,
  which,
};
