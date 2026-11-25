// The live readouts of the starship console: what each one runs on the Mac
// and how its answer is read. No readout may break the scene, so one that
// cannot be read is null, and nothing here throws.

import type { AgentInfo, EngineInterface } from 'claude-code'

import { PULL_REQUEST_LIMIT } from './starship-scene'

import type { ConsoleReadouts } from '../types'

export const NO_READOUTS: ConsoleReadouts = {
  diskFreeGb: null,
  diskTotalGb: null,
  cpuPercent: null,
  cpuTrace: [],
  cpuCores: null,
  claudeProcesses: null,
  reviewRequests: null,
  openPullRequests: null,
  scannedAt: null,
  githubCheckedAt: null,
}

// Read from df's POSIX table: the second column is the size and the fourth
// what is free, both in kibibytes. Gigabytes are decimal, as Finder counts.
export function parseDisk(dfOutput: string): { freeGb: number; totalGb: number } | null {
  const columns = dfOutput.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? []
  const totalKib = Number(columns[1])
  const freeKib = Number(columns[3])

  if (!(totalKib > 0) || !(freeKib >= 0)) {
    return null
  }

  return { freeGb: (freeKib * 1024) / 1e9, totalGb: (totalKib * 1024) / 1e9 }
}

// ps prints one percentage per process, each of one core. Their sum over the
// number of cores is the share of the whole machine in use.
export function parseCpuPercent(psOutput: string, cores: number): number | null {
  const shares = psOutput.split('\n').map(line => Number(line.trim().replace(',', '.')))
  const total = shares.reduce((sum, share) => sum + share, 0)

  if (psOutput.trim() === '' || !Number.isFinite(total) || !(cores > 0)) {
    return null
  }

  return Math.min(100, Math.max(0, total / cores))
}

export function countLines(text: string): number {
  return text.split('\n').filter(line => line.trim() !== '').length
}

// gh answers a JSON list with one entry per pull request.
export function parsePullRequestCount(json: string): number | null {
  try {
    const list: unknown = JSON.parse(json)

    return Array.isArray(list) ? list.length : null
  } catch {
    return null
  }
}

// A host command's output, or null when it could not start, failed or ran
// past its time.
async function output($: EngineInterface, argv: readonly string[], timeoutMs = 5000): Promise<string | null> {
  try {
    const ran = await $.process.run(argv, { timeoutMs })

    return ran.exitCode === 0 ? ran.stdout : null
  } catch {
    return null
  }
}

async function countClaudeProcesses($: EngineInterface): Promise<number | null> {
  try {
    const ran = await $.process.run(['/usr/bin/pgrep', '-x', 'claude'], { timeoutMs: 5000 })

    // pgrep exits 1 when no process matches, which is a count of none.
    return ran.exitCode <= 1 ? countLines(ran.stdout) : null
  } catch {
    return null
  }
}

let cores: number | null = null

async function readCpuCores($: EngineInterface): Promise<number | null> {
  if (cores === null) {
    const counted = Number(await output($, ['/usr/sbin/sysctl', '-n', 'hw.ncpu']))
    cores = counted > 0 ? counted : null
  }

  return cores
}

export type MacScan = Pick<
  ConsoleReadouts,
  'diskFreeGb' | 'diskTotalGb' | 'cpuPercent' | 'cpuCores' | 'claudeProcesses' | 'scannedAt'
>

// Disk, processor and processes: a few short commands, run together.
export async function scanMac($: EngineInterface): Promise<MacScan> {
  const [df, ps, cpuCores, claudeProcesses, time] = await Promise.all([
    output($, ['/bin/df', '-kP', '/System/Volumes/Data']),
    output($, ['/bin/ps', '-A', '-o', '%cpu=']),
    readCpuCores($),
    countClaudeProcesses($),
    output($, ['/bin/date', '+%H:%M']),
  ])
  const disk = df === null ? null : parseDisk(df)

  return {
    diskFreeGb: disk?.freeGb ?? null,
    diskTotalGb: disk?.totalGb ?? null,
    cpuPercent: ps === null || cpuCores === null ? null : parseCpuPercent(ps, cpuCores),
    cpuCores,
    claudeProcesses,
    scannedAt: time !== null && /^\d\d:\d\d$/.test(time.trim()) ? time.trim() : null,
  }
}

// The app's own environment may not have Homebrew on its PATH.
const GH_PATHS = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
let gh: string | null = null

async function findGh($: EngineInterface): Promise<string | null> {
  for (const path of GH_PATHS) {
    if ((await output($, [path, '--version'])) !== null) {
      return path
    }
  }

  return null
}

async function countPullRequests($: EngineInterface, ghPath: string, whose: string): Promise<number | null> {
  const found = await output(
    $,
    [ghPath, 'search', 'prs', whose, '--state=open', `--limit=${PULL_REQUEST_LIMIT}`, '--json', 'number'],
    20000,
  )

  return found === null ? null : parsePullRequestCount(found)
}

export type GithubScan = Pick<ConsoleReadouts, 'reviewRequests' | 'openPullRequests' | 'githubCheckedAt'>

// Pull requests waiting on the person, and the person's own that are open.
// With no gh, no sign-in or no network, both are null.
export async function scanGithub($: EngineInterface): Promise<GithubScan> {
  gh ??= await findGh($)

  if (gh === null) {
    return { reviewRequests: null, openPullRequests: null, githubCheckedAt: null }
  }
  const [reviewRequests, openPullRequests, time] = await Promise.all([
    countPullRequests($, gh, '--review-requested=@me'),
    countPullRequests($, gh, '--author=@me'),
    output($, ['/bin/date', '+%H:%M']),
  ])
  const isAnswered = reviewRequests !== null || openPullRequests !== null

  return {
    reviewRequests,
    openPullRequests,
    githubCheckedAt: isAnswered && time !== null && /^\d\d:\d\d$/.test(time.trim()) ? time.trim() : null,
  }
}

const isActive = (agent: AgentInfo) =>
  agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting'

// Counts this session's subagents that are at work. A turn's start or end is
// told here as it happens, since the list may not show it yet.
export async function countActiveSubagents(
  $: EngineInterface,
  change: { started?: string; ended?: string } = {},
): Promise<number> {
  const active = new Set((await $.agent.list()).filter(isActive).map(agent => agent.id))

  if (change.started !== undefined) {
    active.add(change.started)
  }
  if (change.ended !== undefined) {
    active.delete(change.ended)
  }

  return active.size
}
