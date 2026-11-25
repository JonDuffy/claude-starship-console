// What the mod reads from the Mac: host commands, the shared folder, where
// the session stands. Nothing here throws: a command that cannot be read
// answers a short reason instead.

import type { EngineInterface } from 'claude-code'

import { basename, parseUtcOffset, shortReason } from './format'

export type Ran = {
  /** null when the command could not start or ran past its time. */
  exitCode: number | null
  stdout: string
  stderr: string
  /** Why it failed, in a few words; null when it exited 0. */
  reason: string | null
}

export async function run(
  $: EngineInterface,
  argv: readonly string[],
  init: { cwd?: string; timeoutMs?: number } = {},
): Promise<Ran> {
  try {
    const ran = await $.process.run(argv, { timeoutMs: 10_000, ...init })

    return {
      exitCode: ran.exitCode,
      stdout: ran.stdout,
      stderr: ran.stderr,
      reason: ran.exitCode === 0 ? null : (shortReason(ran.stderr) ?? `exit ${ran.exitCode}`),
    }
  } catch (error) {
    return { exitCode: null, stdout: '', stderr: '', reason: shortReason(String(error)) ?? 'could not run' }
  }
}

// The app's own environment may not have Homebrew on its PATH.
const toolPaths = new Map<string, string>()

export async function findTool($: EngineInterface, name: 'gh' | 'aws'): Promise<string | null> {
  const known = toolPaths.get(name)

  if (known !== undefined) {
    return known
  }
  for (const path of [name, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]) {
    if ((await run($, [path, '--version'], { timeoutMs: 5_000 })).exitCode === 0) {
      toolPaths.set(name, path)

      return path
    }
  }

  return null
}

/**
 * The folder every session's copy of this mod shares, under the person's
 * Claude folder: heartbeats and the pull-request cache. One fixed place, so
 * sessions signed in to different accounts still see each other.
 */
export async function deckFolder($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')

  return home === undefined || home === '' ? null : `${home}/.claude/command-deck`
}

export async function homeFolder($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')

  return home === undefined || home === '' ? null : home
}

export type Place = {
  cwd: string
  /** The repository's main checkout, or the working directory outside one. */
  repoRoot: string
  repoName: string
  branch: string | null
}

export async function findPlace($: EngineInterface): Promise<Place> {
  const cwd = await $.session.cwd()
  let repoRoot = cwd

  try {
    repoRoot = (await $.session.repo())?.root ?? cwd
  } catch {
    // Outside a repository, or the session has no disk: the folder stands in.
  }
  const head = await run($, ['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5_000 })
  const branch = head.exitCode === 0 ? head.stdout.trim() : ''

  return {
    cwd,
    repoRoot,
    repoName: basename(repoRoot),
    // A detached HEAD answers the word HEAD.
    branch: branch === '' || branch === 'HEAD' ? null : branch,
  }
}

// The heartbeat and the call light name the repository often, and its
// branch rarely moves: one git call a minute serves them.
const PLACE_KEPT_MS = 60_000
let keptPlace: { at: number; place: Place } | null = null

export async function currentPlace($: EngineInterface): Promise<Place> {
  const now = await $.clock.now()

  if (keptPlace === null || now - keptPlace.at >= PLACE_KEPT_MS) {
    keptPlace = { at: now, place: await findPlace($) }
  }

  return keptPlace.place
}

export async function readUtcOffset($: EngineInterface): Promise<number | null> {
  const ran = await run($, ['/bin/date', '+%z'], { timeoutMs: 5_000 })

  return ran.exitCode === 0 ? parseUtcOffset(ran.stdout) : null
}

/** Free space on the volume holding `path`, in decimal gigabytes. */
export function parseFreeGb(dfOutput: string): number | null {
  const columns = dfOutput.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? []
  const freeKib = Number(columns[3])

  return columns.length >= 4 && Number.isFinite(freeKib) && freeKib >= 0 ? (freeKib * 1024) / 1e9 : null
}

export async function readFreeGb($: EngineInterface, path: string): Promise<number | null> {
  const ran = await run($, ['/bin/df', '-kP', path], { timeoutMs: 5_000 })

  return ran.exitCode === 0 ? parseFreeGb(ran.stdout) : null
}

/** `du -sk` prints the total last; it may also exit 1 over one unreadable folder. */
export function parseDuKb(duOutput: string): number | null {
  const last = duOutput.trim().split('\n').at(-1) ?? ''
  const found = /^(\d+)\s/.exec(last)

  return found === null ? null : Number(found[1])
}

export async function readFolderKb(
  $: EngineInterface,
  path: string,
): Promise<{ kb: number | null; reason: string | null }> {
  const ran = await run($, ['/usr/bin/du', '-sk', path], { timeoutMs: 90_000 })
  const kb = parseDuKb(ran.stdout)

  return { kb, reason: kb === null ? (ran.reason ?? 'no size read') : null }
}

/** Runs one feature's step so that its failure costs that step alone. */
export async function quietly($: EngineInterface, what: string, step: () => unknown): Promise<void> {
  try {
    await step()
  } catch (error) {
    $.ui.log(`command-deck: ${what} failed: ${shortReason(String(error)) ?? 'unknown'}`, { to: 'debug' })
  }
}
