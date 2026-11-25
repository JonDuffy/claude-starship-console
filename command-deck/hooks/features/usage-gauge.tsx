// Feature 3, the usage gauge: the context window's fill, the rate-limit
// windows with their reset times, the session's cost estimate and the
// subagent that has cost most. The band (band.tsx) draws them. The engine pushes the
// figures (`session.measure`); nothing is polled.

import type { EngineInterface } from 'claude-code'

import { clockTimeFrom, cut, formatUsd, lookUp } from '../lib/format'
import { writeUsage } from '../state'

import type { DeckRateLimit, DeckUsage } from '../../types'

type Measured = {
  context: { percent?: number }
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

/** Takes the engine's figures as measured, keeping the top agent this mod worked out. */
export async function recordUsage($: EngineInterface, measured: Measured): Promise<void> {
  await writeUsage($, last => ({
    contextPercent: measured.context.percent ?? last.contextPercent,
    rateLimits: measured.rateLimits.map(limit => ({
      kind: limit.kind,
      percentUsed: limit.percentUsed,
      resetsAt: limit.resetsAt ?? null,
    })),
    costUsd: measured.cost?.usd ?? last.costUsd,
    topAgent: last.topAgent,
  }))
}

const LIMIT_WORDS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

export function limitLabel(limit: DeckRateLimit, now: number, offsetMinutes: number | null): string {
  const name = lookUp(LIMIT_WORDS, limit.kind) ?? limit.kind
  const resetsAt = limit.resetsAt === null ? Number.NaN : Date.parse(limit.resetsAt)
  const reset = Number.isFinite(resetsAt) ? `, resets ${clockTimeFrom(resetsAt, now, offsetMinutes)}` : ''

  return `${name} ${Math.round(limit.percentUsed)}%${reset}`
}

/** The gauge's parts in reading order; empty before the first reading. */
export function usageParts(readout: DeckUsage, now: number, offsetMinutes: number | null): string[] {
  const parts: string[] = []

  if (readout.contextPercent !== null) {
    parts.push(`context ${Math.round(readout.contextPercent)}%`)
  }
  for (const limit of readout.rateLimits) {
    parts.push(limitLabel(limit, now, offsetMinutes))
  }
  if (readout.costUsd !== null) {
    parts.push(`cost est. ${formatUsd(readout.costUsd)}`)
  }
  if (readout.topAgent !== null) {
    parts.push(`top subagent est. ${formatUsd(readout.topAgent.costUsd)} (${cut(readout.topAgent.description, 30)})`)
  }

  return parts
}
