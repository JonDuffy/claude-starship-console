// The world beneath the mod, for its tests: a Mac whose commands, files,
// clock and notifications are answered from memory. Nothing here runs a
// program or touches a disk.

import { mock } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { AgentInfo, On, SessionUsage } from 'claude-code'

import type { DeckCondition, DeckConsoleFeed } from '../types'

export const NOW = 1_800_000_000_000
export const HOME = '/Users/test'
export const DECK = `${HOME}/.claude/command-deck`
export const REPO = '/code/home'
export const CWD = '/code/home/.claude/worktrees/feature'
export const SESSION = 'session-1'

export const START = { cwd: CWD, surface: 'desktop', isInteractive: true } as const
export const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
export const BAND = {
  plugin: 'command-deck',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

export type Answer = { exitCode: number; stdout: string; stderr?: string }

export const ok = (stdout: string): Answer => ({ exitCode: 0, stdout })
export const failed = (stderr: string, exitCode = 1): Answer => ({ exitCode, stdout: '', stderr })

/** `df -kP` output with this many kibibytes free. */
export const df = (freeKib: number) =>
  `Filesystem   1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s1   482797652 354662384  ${freeKib}    83%    /System/Volumes/Data\n`

export function agent(more: Partial<AgentInfo> & { id: string }): AgentInfo {
  return {
    description: `task ${more.id}`,
    type: 'general-purpose',
    status: 'running',
    kind: 'local_agent',
    taskStatus: 'running',
    label: '',
    startTime: NOW - 60_000,
    cwd: CWD,
    tokenCount: 0,
    tokenSamples: [],
    hasRow: true,
    ...more,
  }
}

/**
 * Stands for a mod that reads command-deck's two plain values, as
 * terminal-looks does for its console: `/peek` answers both as JSON. Load it
 * with `test(name, { plugins: [READER] }, body)`.
 */
export const READER: Plugin = {
  name: 'reader',
  register(on) {
    on('command.run', { command: 'peek' }, async $ => ({
      text: JSON.stringify({
        condition: await $.state.get({ plugin: 'command-deck', key: 'condition' } as never),
        console: await $.state.get({ plugin: 'command-deck', key: 'console' } as never),
      }),
    }))
  },
}

/** What command-deck's condition and console feed hold now, read as another mod reads them. */
export async function peek($: Engine): Promise<{ condition: DeckCondition; console: DeckConsoleFeed | null }> {
  return JSON.parse((await $.command.run({ ...COMMAND, command: 'peek', args: '' })).text ?? '{}')
}

export type World = {
  clock: ReturnType<typeof mock.clock>
  /** Every command the mod ran, as its argument vector. */
  runs: string[][]
  /** Answers a command, first match wins; unanswered ones exit 127. */
  answers: Array<(argv: readonly string[], cwd: string | undefined) => Answer | undefined>
  files: Map<string, { text: string; mtimeMs: number }>
  /** Folders that exist though no file was written under them. */
  folders: Set<string>
  notes: { text: string; title?: string; key?: string }[]
  cancels: string[]
  toasts: string[]
  fills: string[]
  /** The panes the mod opened. It opens none. */
  opened: string[]
  agents: AgentInfo[]
  usage: SessionUsage
  /** What the engine itself decides about a tool call, beneath the mod. */
  engineDecision: 'allow' | 'ask' | 'deny'
  /** The context blocks the last submitted prompt entered with. */
  submitted: { text: string; context: readonly string[] }[]
  freeKib: number
  /** False where the session has nothing that raises a native notification. */
  canNotify: boolean
  closed: string[]
  /** Holds a tool call open, as a dialog the person has not answered does; resolved, the call returns. */
  held: Promise<void> | null
  count: (...words: string[]) => number
}

/**
 * @param look the look terminal-looks has on, as that mod's own value says it; left out, that mod is not loaded.
 */
export function world(on: On, store: Record<string, unknown> = {}, look?: string): World {
  const clock = mock.clock(on, { now: NOW })
  const w: World = {
    clock,
    runs: [],
    answers: [],
    files: new Map(),
    folders: new Set(),
    notes: [],
    cancels: [],
    toasts: [],
    fills: [],
    opened: [],
    agents: [],
    usage: { startedAt: NOW - 3_600_000, context: { window: 200_000 }, rateLimits: [] },
    engineDecision: 'allow',
    submitted: [],
    freeKib: 73_305_336,
    canNotify: true,
    closed: [],
    held: null,
    count: (...words) => w.runs.filter(run => words.every(word => run.includes(word))).length,
  }
  const exists = (path: string) =>
    w.files.has(path) || w.folders.has(path) || [...w.files.keys(), ...w.folders].some(known => known.startsWith(`${path}/`))

  if (look !== undefined) {
    // Stands for terminal-looks, whose value command-deck reads to pick its styling.
    on('state.get', { plugin: 'terminal-looks', key: 'look' } as never, () => ({ value: { value: look, version: 1 } }) as never)
  }
  mock.env(on, { HOME })
  mock.store(on, store)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.measure', (_, e) => ({ changed: [...e.changed] }))
  on('session.stop', (_, e) => ({ isTurnRunning: e.isTurnRunning }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: SESSION }))
  on('session.repo', () => ({ value: { root: REPO, remote: null, internal: false, name: null } }))
  on('session.usage', () => ({ value: w.usage }))
  on('agent.list', () => ({ value: w.agents }))
  on('command.register', () => ({ value: { command: 'deck' } }))
  on('command.run', () => ({ text: '' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => {
    w.submitted.push({ text: e.text, context: e.context ?? [] })

    return { text: e.text }
  })
  on('prompt.fill', (_, e) => {
    w.fills.push(e.text)

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('tool.check', () => ({ decision: w.engineDecision }))
  on('tool.call', async () => {
    await w.held

    return { result: {} }
  })
  on('classic.PermissionRequest', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.PostToolBatch', () => ({}))
  on('classic.Stop', () => ({}))
  on('ui.open', (_, e) => {
    w.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    w.closed.push(e.id)

    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    if (!w.canNotify) {
      return { value: { isSent: false, reason: 'no-surface' } }
    }
    w.notes.push({ text: e.text, title: e.title, key: e.key })

    return { value: { isSent: true, channel: 'client' } }
  })
  on('ui.cancelNotify', (_, e) => {
    w.cancels.push(e.key)

    return { value: { isSent: true } }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('fs.write', (_, e) => {
    w.files.set(e.path, { text: e.text, mtimeMs: clock.now() })

    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const file = w.files.get(e.path)

    return file === undefined ? { deny: `ENOENT: ${e.path}` } : { value: file.text }
  })
  on('fs.exists', (_, e) => ({ value: exists(e.path) }))
  on('fs.stat', (_, e) => {
    const file = w.files.get(e.path)

    return file === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.list', (_, e) => {
    const inside = [...w.files].filter(([path]) => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))

    return inside.length === 0 && !exists(e.path)
      ? { deny: `ENOENT: ${e.path}` }
      : {
          value: inside.map(([path, file]) => ({
            name: path.slice(e.path.length + 1),
            kind: 'file' as const,
            size: file.text.length,
            mtimeMs: file.mtimeMs,
            isLink: false,
          })),
        }
  })
  on('process.run', (_, e) => {
    const [program, ...args] = e.argv
    let answer: Answer | undefined

    w.runs.push([...e.argv])
    for (const respond of w.answers) {
      answer ??= respond(e.argv, e.init?.cwd)
    }
    if (answer === undefined && args[0] === '--version') answer = ok(`${program} 1.0\n`)
    if (answer === undefined && program === 'git' && args.includes('--abbrev-ref')) answer = ok('feature\n')
    if (answer === undefined && program === '/bin/date') answer = ok('+0100\n')
    if (answer === undefined && program === '/bin/df') answer = ok(df(w.freeKib))
    answer ??= failed(`${program}: not answered in this test`, 127)

    return {
      value: {
        exitCode: answer.exitCode,
        stdout: answer.stdout,
        stderr: answer.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  return w
}
