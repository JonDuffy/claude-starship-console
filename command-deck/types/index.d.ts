/**
 * command-deck's state contract: what its band row and its tool-row badges
 * draw from. Every value is this session's own, held in `$.state`.
 */

/** Where a session stands, as its heartbeat and the fleet board say it. */
export type DeckSessionState = 'working' | 'idle' | 'needs-you' | 'ended'

export type DeckStatus = {
  /** A turn of the main conversation is running. */
  isMainWorking: boolean
  /** What the session waits on the person for; null when it waits on nothing. */
  waitingOn: string | null
  state: DeckSessionState
  /** When `state` last changed, in epoch milliseconds; 0 before the first reading. */
  since: number
}

/** One session's heartbeat file, as every session running this mod writes it. */
export type DeckHeartbeat = {
  version: 1
  sessionId: string
  /** The repository folder's name, or the working directory's when there is none. */
  repo: string
  cwd: string
  branch: string | null
  state: DeckSessionState
  waitingOn: string | null
  since: number
  updatedAt: number
  activeSubagents: number
  /** A client-side estimate in US dollars, not a bill; null where no ledger is kept. */
  costUsd: number | null
}

export type DeckFleet = {
  entries: DeckHeartbeat[]
  readAt: number | null
  /** Why the board could not be read; null when it was. */
  reason: string | null
}

export type DeckCheckState = 'pass' | 'fail' | 'running' | 'skipped'

export type DeckCheck = { name: string; state: DeckCheckState }

export type DeckPullRequest = {
  number: number
  url: string
  /** OPEN, MERGED or CLOSED, as gh spells it. */
  state: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or '' when GitHub gives none. */
  review: string
  checks: DeckCheck[]
}

/** What the failed CI run on this branch said, read from its log. */
export type DeckCiFailure = {
  runId: number
  url: string
  /** The failed job and step, as the log names them. */
  job: string
  step: string
  /** The first line that reads as the error: a best guess, null when none does. */
  line: string | null
}

export type DeckPrReadout = {
  branch: string | null
  /** null when the branch has no pull request, or it could not be read. */
  pr: DeckPullRequest | null
  /** Why it could not be read; null when it was read, a missing PR included. */
  reason: string | null
  fetchedAt: number | null
  /** Set while checks fail and the failed run's log could be read. */
  failure: DeckCiFailure | null
}

/**
 * The one condition of the deck, worked out in one place from what waits on
 * the person, the checks, the rate limits and the disk. Other mods may read
 * it: the console in terminal-looks does.
 */
export type DeckCondition = {
  level: 'nominal' | 'caution' | 'alert'
  /** Why, in a sentence. Never empty. */
  reason: string
  /** The same in a few capital words, for a narrow place. */
  brief: string
}

/**
 * What the console in terminal-looks shows of the deck, in one plain value
 * another mod can read as it is. Numbers are null where they were not read.
 */
export type DeckConsoleFeed = {
  /** Sessions running this mod whose heartbeat is fresh. */
  liveSessions: number
  /** Of those, the ones waiting on the person, this session included. */
  needsYou: number
  /** The repository of the longest-waiting session; null when none waits. */
  firstWaiting: string | null
  /** This branch's pull request number; null when it has none or it was not read. */
  prNumber: number | null
  checksFailing: number
  checksPassing: number
  checksRunning: number
  /** The failed CI job and step, as the log names them; null when none failed or the log was not read. */
  failedStep: string | null
  contextPercent: number | null
  fiveHourPercent: number | null
  sevenDayPercent: number | null
  /** A client-side estimate in US dollars, not a bill. */
  costUsd: number | null
}

export type DeckRateLimit = { kind: string; percentUsed: number; resetsAt: string | null }

export type DeckUsage = {
  contextPercent: number | null
  rateLimits: DeckRateLimit[]
  /** A client-side estimate in US dollars, not a bill. */
  costUsd: number | null
  /** The subagent with the highest cost estimate so far. */
  topAgent: { description: string; costUsd: number } | null
}

export type DeckAgent = {
  id: string
  description: string
  status: string
  kind: string
  costUsd: number | null
}

export type DeckAwsBadge = {
  profile: string | null
  account: string | null
  region: string | null
  verdict: 'allowed' | 'ask' | 'denied'
}

/** What one Bash call's row shows beside the engine's own drawing. */
export type DeckToolBadge = {
  durationMs?: number
  /** `exit 0`, `exit 2`, `failed` or `interrupted`. */
  exit?: string
  aws?: DeckAwsBadge
}

declare module 'claude-code' {
  interface PluginState {
    'command-deck': {
      status: Shaped<DeckStatus>
      fleet: Shaped<DeckFleet>
      pr: Shaped<DeckPrReadout>
      usage: Shaped<DeckUsage>
      agents: Shaped<DeckAgent[]>
      toolBadge: StateFamily<DeckToolBadge>
      /** Kept plain, with no shape tag, so another mod reads its fields as they are. */
      condition: DeckCondition
      /** Kept plain, with no shape tag, so the console in terminal-looks reads its fields as they are. */
      console: DeckConsoleFeed | null
      /** Free space on the home volume at the last minute's reading, in decimal gigabytes. */
      freeGb: number | null
      /** The Mac's offset from UTC in minutes, read from `date +%z`; null until read. */
      utcOffsetMinutes: number | null
    }
  }
}
