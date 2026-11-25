// The fleet: every session running this mod writes one small heartbeat file,
// and each reads the fresh ones back once a minute. The condition and the
// console in terminal-looks count from them how many sessions are live and
// how many wait on the person.

import type { EngineInterface } from 'claude-code'

import { fileSlug, parseObject, shortReason } from '../lib/format'
import { currentPlace, deckFolder } from '../lib/host'
import { readAgents, readStatus, readUsage, writeFleetBoard } from '../state'

import type { DeckHeartbeat, DeckSessionState } from '../../types'

export const HEARTBEAT_MS = 60_000
/** A heartbeat this old is marked stale: its session has likely stopped. */
export const STALE_MS = 180_000
/** A heartbeat this old is left off the board. */
export const IGNORE_MS = 30 * 60_000
const READ_LIMIT = 60

const ACTIVE_AGENT = new Set(['pending', 'running', 'waiting'])

export const isActiveAgent = (agentStatus: string) => ACTIVE_AGENT.has(agentStatus)

const STATES: readonly DeckSessionState[] = ['needs-you', 'working', 'idle', 'ended']

export function parseHeartbeat(json: string): DeckHeartbeat | null {
  const beat = parseObject(json)

  if (
    beat === null ||
    beat.version !== 1 ||
    typeof beat.sessionId !== 'string' ||
    typeof beat.repo !== 'string' ||
    typeof beat.cwd !== 'string' ||
    typeof beat.updatedAt !== 'number' ||
    typeof beat.since !== 'number' ||
    !STATES.includes(beat.state as DeckSessionState)
  ) {
    return null
  }

  return {
    version: 1,
    sessionId: beat.sessionId,
    repo: beat.repo,
    cwd: beat.cwd,
    branch: typeof beat.branch === 'string' ? beat.branch : null,
    state: beat.state as DeckSessionState,
    waitingOn: typeof beat.waitingOn === 'string' ? beat.waitingOn : null,
    since: beat.since,
    updatedAt: beat.updatedAt,
    activeSubagents: typeof beat.activeSubagents === 'number' ? beat.activeSubagents : 0,
    costUsd: typeof beat.costUsd === 'number' ? beat.costUsd : null,
  }
}

export type RankedHeartbeat = DeckHeartbeat & { isStale: boolean }

/** The board's rows: ended and very old sessions left out, sessions that need the person first, stale ones last. */
export function rankFleet(entries: readonly DeckHeartbeat[], now: number): RankedHeartbeat[] {
  return entries
    .filter(beat => beat.state !== 'ended' && now - beat.updatedAt < IGNORE_MS)
    .map(beat => ({ ...beat, isStale: now - beat.updatedAt >= STALE_MS }))
    .sort(
      (a, b) =>
        Number(a.isStale) - Number(b.isStale) ||
        STATES.indexOf(a.state) - STATES.indexOf(b.state) ||
        a.since - b.since,
    )
}

let sessionId: string | null = null

/** This session's id, which names its heartbeat file. */
export async function ownSessionId($: EngineInterface): Promise<string> {
  sessionId ??= await $.session.id()

  return sessionId
}

async function heartbeatPath($: EngineInterface): Promise<string | null> {
  const folder = await deckFolder($)

  if (folder === null) {
    return null
  }
  sessionId ??= await $.session.id()

  return `${folder}/fleet/${fileSlug(sessionId)}.json`
}

/** Writes this session's heartbeat. `ended` is written once, as the session closes. */
export async function writeHeartbeat($: EngineInterface, ended = false): Promise<void> {
  const path = await heartbeatPath($)

  if (path === null || sessionId === null) {
    return
  }
  const [place, now, standing, list, spent] = await Promise.all([
    currentPlace($),
    $.clock.now(),
    readStatus($),
    readAgents($),
    readUsage($),
  ])
  const beat: DeckHeartbeat = {
    version: 1,
    sessionId,
    repo: place.repoName,
    cwd: place.cwd,
    branch: place.branch,
    state: ended ? 'ended' : standing.state,
    waitingOn: ended ? null : standing.waitingOn,
    since: ended || standing.since === 0 ? now : standing.since,
    updatedAt: now,
    activeSubagents: list.filter(agent => isActiveAgent(agent.status)).length,
    costUsd: spent.costUsd,
  }

  await $.fs.write(path, `${JSON.stringify(beat)}\n`)
}

/** Reads every fresh heartbeat in the shared folder into the board. */
export async function readFleet($: EngineInterface): Promise<void> {
  const folder = await deckFolder($)
  const now = await $.clock.now()

  if (folder === null) {
    await writeFleetBoard($, { entries: [], readAt: now, reason: 'HOME is not set' })

    return
  }
  try {
    const files = (await $.fs.list(`${folder}/fleet`))
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.json') && now - entry.mtimeMs < IGNORE_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, READ_LIMIT)
    const beats = await Promise.all(
      files.map(async file => {
        try {
          return parseHeartbeat(await $.fs.read(`${folder}/fleet/${file.name}`))
        } catch {
          return null
        }
      }),
    )

    await writeFleetBoard($, { entries: beats.filter(beat => beat !== null), readAt: now, reason: null })
  } catch (error) {
    await writeFleetBoard($, { entries: [], readAt: now, reason: shortReason(String(error)) ?? 'not read' })
  }
}
