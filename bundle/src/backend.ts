/**
 * The single egress module for this plugin: every filesystem write and every subprocess spawn lives here.
 *
 * The tool modules call these functions and never touch `node:fs` or `node:child_process` themselves. That
 * is the same rule this plugin enforces on the bundles it generates (`HARNESS.md` rule 1), applied to
 * itself — so the rules it teaches are the rules it follows.
 *
 * @module dsh-plugin-anything-bundle/backend
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** One command's outcome. A non-zero exit is data here, not an exception. */
export interface CommandOutcome {
  /** Whether the process exited zero. */
  readonly ok: boolean
  /** Captured stdout, UTF-8. */
  readonly stdout: string
  /** Captured stderr, UTF-8. */
  readonly stderr: string
  /**
   * The exit code, or `null` when the process was killed before it could exit — which in this module means
   * the timeout fired, since nothing else here kills a child.
   */
  readonly exitCode: number | null
  /**
   * The signal that killed the process, when `exitCode` is `null`.
   *
   * It carries the reason a `null` exit code cannot: Node discards a killed process's partial capture, so
   * `stdout` and `stderr` come back **empty** — measured, not assumed — and without this a timeout would be
   * indistinguishable from a command that printed nothing. It is deliberately not written into `stderr`:
   * callers treat a non-empty `stderr` as the process's own output, and `probe.ts` appends it to the help
   * excerpt, so text invented here would be read back as something the target printed.
   */
  readonly signal?: string | null
}

/**
 * Run a command, treating a non-zero exit as data rather than an error.
 * @param command - the executable to run.
 * @param args - argv passed through unchanged.
 * @param options - invocation controls.
 * @param options.cwd - working directory.
 * @param options.signal - the caller's abort signal; honored on every call.
 * @param options.timeoutMs - cooperative timeout budget for this call.
 * @returns the outcome, including a non-zero exit and a process killed by the timeout.
 * @throws Error only when there is no process outcome to report: the command could not be started
 * (`ENOENT`), or the caller's own `signal` cancelled the call (`ABORT_ERR`). A command that ran is
 * returned, however it ended.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; signal: AbortSignal; timeoutMs: number },
): Promise<CommandOutcome> {
  const resolved = await resolveExecutable(command, options)
  // Node ≥ 20.12 refuses to spawn a `.cmd`/`.bat` without a shell (the CVE-2024-27980 mitigation), so a
  // Windows batch entry point — `npx`, `dsh`, and every other npm-installed bin — reports `spawn EINVAL`
  // otherwise. The shell is therefore set for exactly that case and no other: `.exe` is spawned directly, and
  // nothing here goes through a shell on a platform that does not need one.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)

  // With `shell: true`, Node concatenates the command line rather than escaping it — which is what its own
  // deprecation warning is about — so an unquoted `D:\Program Files\nodejs\npx.cmd` is split at the space and
  // cmd.exe reports `'D:\Program' is not recognized`. Quoting is therefore this module's job, not the
  // runtime's.
  //
  // The trade is real and worth naming: quoting is not escaping. An argument containing a double quote would
  // break out. The arguments reaching here are this module's own — absolute paths, profile names, bundle
  // directories — all of which this package derives. A caller that routed model-authored free text into
  // `args` would be introducing the injection this comment warns about.
  const quoted = needsShell
    ? args.map((arg) => (arg === '' || /\s/.test(arg) ? `"${arg}"` : arg))
    : [...args]

  try {
    const { stdout, stderr } = await run(needsShell ? `"${resolved}"` : resolved, quoted, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      // Nothing here is a person at a terminal: output is captured, so a pager holds the process open and an
      // external viewer opens a window. Both are consequences of a tool assuming an interactive session.
      //
      // `cat` rather than an empty value: a pager set to the empty string is treated as unset by some tools,
      // which then pick their own — the behaviour being suppressed.
      env: { ...process.env, PAGER: 'cat', GIT_PAGER: 'cat', MANPAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
      ...(needsShell ? { shell: true } : {}),
    })
    return { ok: true, stdout, stderr, exitCode: 0 }
  } catch (cause) {
    const error = cause as {
      code?: number | string | null
      signal?: string | null
      stdout?: string
      stderr?: string
    }
    // Three shapes arrive here, and `code`'s type is what separates them. A non-zero exit is a number. A
    // process that ran and was killed before it could exit is `null` — `{ code: null, killed: true, signal:
    // 'SIGTERM' }`, measured — and that is an outcome, not an exception: the caller wants "it ran and was
    // killed", which is this module's timeout firing. A *string* code means there is no process outcome to
    // report at all: `ENOENT` when it never started, `ABORT_ERR` when the caller's own signal cancelled it.
    if (typeof error.code !== 'number' && error.code !== null) {
      throw new Error(`${command}: ${(cause as Error).message}`)
    }
    return {
      ok: false,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: typeof error.code === 'number' ? error.code : null,
      signal: error.signal ?? null,
    }
  }
}

/**
 * Resolve a bare command name to something spawnable on this platform.
 *
 * On Windows, `execFile` does not apply `PATHEXT`, so a bare `npx` or `dsh` — both `.cmd` files — fails with
 * `spawn npx ENOENT`. Passing `shell: true` would find them and would also hand every argument to a shell,
 * which is the wrong trade for a module that runs commands with paths from a model's session.
 *
 * So the name is resolved through the platform's own lookup and the absolute path is spawned, inheriting the
 * platform's exact PATH and PATHEXT semantics without a shell in the middle.
 *
 * @param command - the command as written.
 * @param options - invocation controls, reused for the lookup itself.
 * @returns an absolute path when the name resolves, or the original command.
 */
async function resolveExecutable(
  command: string,
  options: { cwd: string; signal: AbortSignal; timeoutMs: number },
): Promise<string> {
  if (process.platform !== 'win32') return command

  // A path to a bin wrapper. On Windows an npm-installed bin directory contains both `dsh` (a shell script)
  // and `dsh.cmd` (the runnable one), and `.../.bin/dsh` is the natural thing to write — it is what the
  // directory listing shows. It is not runnable, so the extension is tried before giving up.
  if (command.includes('/') || command.includes('\\')) {
    for (const extension of ['.cmd', '.exe', '.bat']) {
      if (existsSync(command + extension)) return command + extension
    }
    return command
  }

  try {
    const { stdout } = await run('where', [command], {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs,
      encoding: 'utf8',
    })
    // `where` lists several matches and they are not equivalent. For `npx` it returns, in order, an
    // extensionless shell script (a bash script, not runnable by spawn) and then `npx.cmd`. Taking the first
    // match yields `spawn …\npx ENOENT`, which reads as "npx is not installed" and is not.
    const candidates = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    return candidates.find((line) => /\.(exe|cmd|bat|com)$/i.test(line)) ?? command
  } catch {
    // Not found, or no `where` at all. Spawning the original name produces the clearer error.
    return command
  }
}

/**
 * Test whether a path exists and is a file.
 * @param path - the path to test.
 * @returns whether it is an existing regular file.
 */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Test whether a path exists and is a directory.
 * @param path - the path to test.
 * @returns whether it is an existing directory.
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Read a UTF-8 file.
 * @param path - the file to read.
 * @returns the file's contents.
 */
export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

/**
 * List the entries of a directory.
 * @param path - the directory to list.
 * @returns the entry names, or an empty list when the directory does not exist.
 */
export async function listDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

/** One file to write as part of a bundle. */
export interface PlannedFile {
  /** Path relative to the bundle's root. */
  readonly path: string
  /** The file's full contents. */
  readonly contents: string
}

/**
 * Write a set of files, creating parent directories as needed.
 *
 * Existing files are never overwritten. A generator that silently clobbers hand-written work is worse than
 * one that stops, so a collision is reported back to the caller rather than resolved unilaterally.
 *
 * @param root - the bundle's root directory.
 * @param files - the files to write.
 * @returns the paths written, and the paths skipped because they already existed.
 * @throws Error when the root cannot be created.
 */
export async function writeBundle(
  root: string,
  files: readonly PlannedFile[],
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = []
  const skipped: string[] = []
  for (const file of files) {
    const absolute = resolve(root, file.path)
    // Refuse to escape the root: a template placeholder must never become a path traversal.
    if (!absolute.startsWith(resolve(root) + (process.platform === 'win32' ? '\\' : '/'))) {
      throw new Error(`refusing to write outside the bundle root: ${file.path}`)
    }
    if (await isFile(absolute)) {
      skipped.push(file.path)
      continue
    }
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, file.contents, 'utf8')
    written.push(file.path)
  }
  return { written, skipped }
}

/**
 * Read a dsh session log.
 *
 * The log is zstd-compressed as a **sequence of independent frames**, not one stream — `zstdDecompressSync`
 * decodes only the first, which yields the session header and nothing else. The frames are found by their
 * magic number and decoded one at a time.
 *
 * That detail cost real time to find: the first reader here returned a 192-character header and looked like a
 * session that had recorded nothing.
 *
 * @param path - the log file.
 * @returns the concatenated decompressed JSONL.
 * @throws Error when the file cannot be read.
 */
export async function readSessionLog(path: string): Promise<string> {
  const buffer = await readFile(path)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts: number[] = []
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    if (buffer.compare(MAGIC, 0, 4, index, index + 4) === 0) starts.push(index)
  }
  if (starts.length === 0) {
    // Not framed as zstd: either already plaintext, or not a log at all. Returning it unchanged lets the
    // caller's parser decide, which reports a malformed log better than a decompression error would.
    return buffer.toString('utf8')
  }
  const parts: string[] = []
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1] ?? buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      // A damaged frame does not invalidate the frames around it, and a log from a crashed session is
      // exactly when a reader is most needed.
    }
  }
  return parts.join('')
}

/**
 * Build a {@link Runner} bound to one caller's cancellation.
 *
 * The `Runner` interface exists so inspection's parsing can be tested against fixture output with no target
 * installed. This is the only real implementation, and it lives here because this is the only module
 * permitted to spawn a process.
 *
 * @param signal - the caller's abort signal, honored on every call.
 * @param cwd - working directory for the commands.
 * @returns a runner.
 */
export function makeRunner(signal: AbortSignal, cwd: string): import('./inspect.ts').Runner {
  return {
    run: (command, args, timeoutMs) => runCommand(command, args, { cwd, signal, timeoutMs }),
  }
}

/**
 * Resolve a path relative to this package's install location.
 *
 * Uses `fileURLToPath`, not `new URL(...).pathname`. On Windows the latter yields a path with a leading
 * slash (`/D:/…`), and `path.resolve` then treats the drive letter as a directory name — producing
 * `D:\D:\…`. Every path this package derives would be wrong on Windows, and the failure surfaces as
 * "cannot find the file" from a tool that is otherwise correct.
 *
 * That is not hypothetical: a real agent run reported the gate path as `D:\D:\Opencode\…` and declined to
 * trust `plugin_anything_verify`. The first version of this function had the bug.
 *
 * @param segments - path segments below the package root.
 * @returns the absolute path.
 */
export function fromPackageRoot(...segments: string[]): string {
  // `lib/index.js` at runtime, `src/` under tsx: this package's root is one level above either.
  return join(resolve(fileURLToPath(new URL('.', import.meta.url)), '..'), ...segments)
}
