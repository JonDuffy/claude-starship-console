// Every value the mod keeps in the session, and the only file that reads or
// writes them: `claude plugin validate` reads each value's name off the file
// that touches it, so the features go through the functions here.
//
// Change a tag when a value's fields change: it declines what an earlier
// version stored, which outlives a reload.

import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'

import type {
  DeckAgent,
  DeckCondition,
  DeckConsoleFeed,
  DeckFleet,
  DeckPrReadout,
  DeckStatus,
  DeckToolBadge,
  DeckUsage,
} from '../types'

const status = atom(
  { plugin: 'command-deck', key: 'status' } as const,
  { isMainWorking: false, waitingOn: null, state: 'idle', since: 0 },
  { shape: 'status-1' },
)
const fleet = atom({ plugin: 'command-deck', key: 'fleet' } as const, { entries: [], readAt: null, reason: null }, {
  shape: 'fleet-1',
})
const pr = atom(
  { plugin: 'command-deck', key: 'pr' } as const,
  { branch: null, pr: null, reason: null, fetchedAt: null, failure: null },
  { shape: 'pr-2' },
)
const condition = atom({ plugin: 'command-deck', key: 'condition' } as const, {
  level: 'nominal',
  reason: 'Nothing has been read yet.',
  brief: 'NOT READ YET',
})
const consoleFeed = atom({ plugin: 'command-deck', key: 'console' } as const, null as DeckConsoleFeed | null)
const freeGb = atom({ plugin: 'command-deck', key: 'freeGb' } as const, null)
const usage = atom(
  { plugin: 'command-deck', key: 'usage' } as const,
  { contextPercent: null, rateLimits: [], costUsd: null, topAgent: null },
  { shape: 'usage-1' },
)
const agents = atom({ plugin: 'command-deck', key: 'agents' } as const, [], { shape: 'agents-2' })
const utcOffsetMinutes = atom({ plugin: 'command-deck', key: 'utcOffsetMinutes' } as const, null)
// One member per Bash call, by its tool_use_id, so a new badge draws its own
// row again and no other.
const toolBadge = { plugin: 'command-deck', key: 'toolBadge' } as const

const isSame = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function readStatus($: EngineInterface): Promise<DeckStatus> {
  return read($, status)
}

export function writeStatus($: EngineInterface, change: (last: DeckStatus) => DeckStatus): Promise<DeckStatus> {
  return update($, status, change)
}

export function readFleetBoard($: EngineInterface): Promise<DeckFleet> {
  return read($, fleet)
}

export function writeFleetBoard($: EngineInterface, board: DeckFleet): Promise<DeckFleet> {
  return update($, fleet, () => board)
}

export function readPr($: EngineInterface): Promise<DeckPrReadout> {
  return read($, pr)
}

/** Writes only a readout that differs, so an unchanged poll draws nothing again. */
export async function writePr($: EngineInterface, readout: DeckPrReadout): Promise<void> {
  if (!isSame(await read($, pr), readout)) {
    await update($, pr, () => readout)
  }
}

export function readUsage($: EngineInterface): Promise<DeckUsage> {
  return read($, usage)
}

export function writeUsage($: EngineInterface, change: (last: DeckUsage) => DeckUsage): Promise<DeckUsage> {
  return update($, usage, change)
}

export function readAgents($: EngineInterface): Promise<DeckAgent[]> {
  return read($, agents)
}

/** Writes only rows that differ, so a quiet agent list draws nothing again. */
export async function writeAgents($: EngineInterface, rows: DeckAgent[]): Promise<void> {
  if (!isSame(await read($, agents), rows)) {
    await update($, agents, () => rows)
  }
}

export function readUtcOffsetMinutes($: EngineInterface): Promise<number | null> {
  return read($, utcOffsetMinutes)
}

export async function writeUtcOffsetMinutes($: EngineInterface, minutes: number): Promise<void> {
  if ((await read($, utcOffsetMinutes)) !== minutes) {
    await update($, utcOffsetMinutes, () => minutes)
  }
}

/** The badge of the Bash call whose row is being drawn. */
export function readToolBadge($: EngineInterface, e: Pick<RenderInput, 'requestId'>): Promise<DeckToolBadge | undefined> {
  return read($, memberOf(toolBadge, e))
}

/** Adds to one call's badge; each call has its own value, so only its row is drawn again. */
export async function mergeToolBadge($: EngineInterface, toolUseId: string, more: DeckToolBadge): Promise<void> {
  const held = await $.state.get({ plugin: 'command-deck', key: 'toolBadge', id: toolUseId } as const)

  await $.state.set({ plugin: 'command-deck', key: 'toolBadge', id: toolUseId } as const, { ...held.value, ...more })
}

export function readCondition($: EngineInterface): Promise<DeckCondition> {
  return read($, condition)
}

/** Writes only a condition that differs, so the band and the console draw again only on a change. */
export async function writeCondition($: EngineInterface, judged: DeckCondition): Promise<void> {
  if (!isSame(await read($, condition), judged)) {
    await update($, condition, () => judged)
  }
}

/** Writes only a feed that differs, so the console draws again only on a change. */
export async function writeConsoleFeed($: EngineInterface, feed: DeckConsoleFeed): Promise<void> {
  if (!isSame(await read($, consoleFeed), feed)) {
    await update($, consoleFeed, () => feed)
  }
}

export function readFreeGb($: EngineInterface): Promise<number | null> {
  return read($, freeGb)
}

export async function writeFreeGb($: EngineInterface, gigabytes: number | null): Promise<void> {
  if ((await read($, freeGb)) !== gigabytes) {
    await update($, freeGb, () => gigabytes)
  }
}

/**
 * The look terminal-looks has on, read from that mod's own value: `starship`,
 * `catppuccin`, `off`, or null when that mod is not loaded. Read without its
 * contract, so this mod loads whether or not that one does.
 */
export async function readLook($: EngineInterface): Promise<string | null> {
  const held: { value?: unknown } = await $.state.get({ plugin: 'terminal-looks', key: 'look' } as never)

  return typeof held.value === 'string' ? held.value : null
}
