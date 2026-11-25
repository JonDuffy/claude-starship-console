// The deck's one condition: nominal, caution or alert, with the reason always
// named. It is worked out here and nowhere else. The pane's frame, the band
// above the prompt and the console in terminal-looks all draw from the value
// this file writes.
//
// Alert: a session waits on the person, or under 10 GB of disk is free.
// Caution: this branch's checks fail, a rate limit is at 80% or more, or
// under 20 GB of disk is free. Nominal: none of those.

import type { EngineInterface } from 'claude-code'

import { cut, lookUp } from '../lib/format'
import { readFleetBoard, readFreeGb, readPr, readStatus, readUsage, writeCondition, writeConsoleFeed } from '../state'
import { ownSessionId, rankFleet } from './fleet'

import type { DeckCondition, DeckConsoleFeed, DeckHeartbeat, DeckPrReadout, DeckStatus, DeckUsage } from '../../types'

export const DISK_CAUTION_GB = 20
export const DISK_ALERT_GB = 10
export const LIMIT_CAUTION_PERCENT = 80

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

export type ConditionInputs = {
  now: number
  /** This session's id, so its own heartbeat is not counted a second time. */
  ownSessionId: string | null
  status: DeckStatus
  fleet: readonly DeckHeartbeat[]
  pr: DeckPrReadout
  usage: DeckUsage
  freeGb: number | null
}

type Finding = { reason: string; brief: string }

/** The other sessions that wait on the person now, longest wait first. */
export function waitingSessions(inputs: Pick<ConditionInputs, 'fleet' | 'now' | 'ownSessionId'>): DeckHeartbeat[] {
  return rankFleet(inputs.fleet, inputs.now)
    .filter(row => !row.isStale && row.state === 'needs-you' && row.sessionId !== inputs.ownSessionId)
    .sort((a, b) => a.since - b.since)
}

// One decimal where the thresholds are, so 19.9 GB is not written as the 20 it is under.
const gigabytes = (size: number) => (size < DISK_CAUTION_GB ? size.toFixed(1) : String(Math.round(size)))

function alerts(inputs: ConditionInputs): Finding[] {
  const found: Finding[] = []
  const others = waitingSessions(inputs)
  const waiting = others.length + (inputs.status.waitingOn === null ? 0 : 1)

  if (waiting > 1) {
    found.push({ reason: `${waiting} sessions need you`, brief: `${waiting} SESSIONS NEED YOU` })
  } else if (inputs.status.waitingOn !== null) {
    found.push({ reason: `This session needs you: ${cut(inputs.status.waitingOn, 80)}`, brief: 'THIS SESSION WAITS' })
  } else if (others[0] !== undefined) {
    found.push({
      reason: `${others[0].repo} needs you${others[0].waitingOn === null ? '' : `: ${cut(others[0].waitingOn, 80)}`}`,
      brief: '1 SESSION NEEDS YOU',
    })
  }
  if (inputs.freeGb !== null && inputs.freeGb < DISK_ALERT_GB) {
    found.push({
      reason: `Disk ${gigabytes(inputs.freeGb)} GB free, under ${DISK_ALERT_GB} GB`,
      brief: `DISK ${gigabytes(inputs.freeGb)} GB FREE`,
    })
  }

  return found
}

function cautions(inputs: ConditionInputs): Finding[] {
  const found: Finding[] = []
  const failing = inputs.pr.pr?.state === 'OPEN' ? inputs.pr.pr.checks.filter(check => check.state === 'fail') : []

  if (inputs.pr.pr !== null && failing.length > 0) {
    found.push({
      reason: `CI failing on PR #${inputs.pr.pr.number}: ${cut(failing.map(check => check.name).join(', '), 60)}`,
      brief: `CI FAILING PR ${inputs.pr.pr.number}`,
    })
  }
  for (const limit of inputs.usage.rateLimits) {
    if (limit.percentUsed >= LIMIT_CAUTION_PERCENT) {
      const name = lookUp(LIMIT_NAMES, limit.kind) ?? limit.kind

      found.push({
        reason: `The ${name} limit is at ${Math.round(limit.percentUsed)}%`,
        brief: `${name.toUpperCase()} LIMIT ${Math.round(limit.percentUsed)}%`,
      })
    }
  }
  if (inputs.freeGb !== null && inputs.freeGb < DISK_CAUTION_GB && inputs.freeGb >= DISK_ALERT_GB) {
    found.push({
      reason: `Disk ${gigabytes(inputs.freeGb)} GB free, under ${DISK_CAUTION_GB} GB`,
      brief: `DISK ${gigabytes(inputs.freeGb)} GB FREE`,
    })
  }

  return found
}

// Nominal still says what it rests on, and what it could not read.
function nominalReason(inputs: ConditionInputs): string {
  const found = inputs.pr.pr
  let checks = 'no pull request on this branch'

  if (inputs.pr.reason !== null) {
    checks = 'pull request not read'
  } else if (found !== null && found.state !== 'OPEN') {
    checks = `PR #${found.number} ${found.state.toLowerCase()}`
  } else if (found !== null) {
    const isRunning = found.checks.some(check => check.state === 'running')
    const isPassing = found.checks.some(check => check.state === 'pass')

    checks = isRunning ? 'checks running' : isPassing ? 'checks pass' : 'no checks'
  }
  const disk = inputs.freeGb === null ? 'disk not read' : `${gigabytes(inputs.freeGb)} GB free`

  return `Nothing waits on you, ${checks}, ${disk}`
}

/** The condition, from what is known now. The worst finding leads; a second one of the same level follows it. */
export function judgeCondition(inputs: ConditionInputs): DeckCondition {
  const [alert, caution] = [alerts(inputs), cautions(inputs)]
  const level = alert.length > 0 ? 'alert' : caution.length > 0 ? 'caution' : 'nominal'
  const [first, second] = level === 'alert' ? alert : caution

  if (first === undefined) {
    return { level: 'nominal', reason: `${nominalReason(inputs)}.`, brief: 'NOTHING WAITS' }
  }

  // A reason may end in what a session said it waits on, which often ends a sentence already.
  const plain = (reason: string) => reason.replace(/[.\s]+$/, '')
  const also = second === undefined ? '' : `. Also: ${second.reason.charAt(0).toLowerCase()}${plain(second.reason).slice(1)}`

  return { level, reason: `${plain(first.reason)}${also}.`, brief: first.brief }
}

/** The console's summary of the deck: the fleet, this branch's checks and the usage, as plain numbers. */
export function consoleFeed(inputs: {
  now: number
  status: DeckStatus
  ownSessionId: string | null
  fleet: readonly DeckHeartbeat[]
  pr: DeckPrReadout
  usage: DeckUsage
}): DeckConsoleFeed {
  const live = rankFleet(inputs.fleet, inputs.now).filter(row => !row.isStale)
  const others = live.filter(row => row.sessionId !== inputs.ownSessionId)
  const waiting = others.filter(row => row.state === 'needs-you')
  const isOwnWaiting = inputs.status.state === 'needs-you'
  const checks = inputs.pr.pr?.checks ?? []
  const count = (state: string) => checks.filter(check => check.state === state).length
  const limit = (kind: string) => inputs.usage.rateLimits.find(found => found.kind === kind)?.percentUsed ?? null
  const failure = inputs.pr.failure

  return {
    liveSessions: others.length + 1,
    needsYou: waiting.length + (isOwnWaiting ? 1 : 0),
    firstWaiting: waiting[0]?.repo ?? null,
    prNumber: inputs.pr.pr?.number ?? null,
    checksFailing: count('fail'),
    checksPassing: count('pass'),
    checksRunning: count('running'),
    failedStep: failure === null ? null : `${failure.job} / ${failure.step}`,
    contextPercent: inputs.usage.contextPercent,
    fiveHourPercent: limit('five_hour'),
    sevenDayPercent: limit('seven_day'),
    costUsd: inputs.usage.costUsd,
  }
}

/** Works the condition out again from the session's values, and writes it when it changed. */
export async function syncCondition($: EngineInterface): Promise<void> {
  const [now, status, board, pr, usage, freeGb] = await Promise.all([
    $.clock.now(),
    readStatus($),
    readFleetBoard($),
    readPr($),
    readUsage($),
    readFreeGb($),
  ])

  const own = await ownSessionId($)

  await writeCondition($, judgeCondition({ now, ownSessionId: own, status, fleet: board.entries, pr, usage, freeGb }))
  await writeConsoleFeed($, consoleFeed({ now, status, ownSessionId: own, fleet: board.entries, pr, usage }))
}

