// The console frame behind the conversation, built on the RIGHT edge: the
// app's sidebar covers the left edge, and the chat column sits in the middle.
// Sizes are screen points (no viewBox), so the bars keep their thickness on any
// window. The right-hand parts sit in nested svgs placed at 100% with overflow
// visible and draw at negative coordinates, so they hug the right and bottom
// edges. The top starts below the title bar and the bottom stays above the
// status row.
//
// The column is an instrument panel. Each block is one live readout, and the
// scene is drawn again from the session's state whenever a readout changes.
// Motion means something: the lamps beside the column chase while Claude
// works, a lamp pulses beside a readout that wants a look, and a block
// breathes when its readout is in trouble. At rest (reduced motion) every
// part is fully lit.

import type { ConsoleReadouts } from '../types'

// How many processor scans the trace keeps: at one every half minute, the
// last eight minutes.
export const TRACE_LENGTH = 16
// gh search answers at most this many, so a count this high means "or more".
export const PULL_REQUEST_LIMIT = 100

/**
 * The condition command-deck worked out, when that mod is loaded: one
 * condition for the deck's pane, its band and this console. The console then
 * shows it in its head in place of its own reading of the disk and processor.
 */
export type DeckCondition = { level: 'nominal' | 'caution' | 'alert'; brief: string }

/**
 * command-deck's summary for this console, when that mod is loaded: its
 * sessions, this branch's checks and the usage. Words are already cleaned
 * for the backdrop's markup by readDeckFeed.
 */
export type DeckFeed = {
  liveSessions: number
  needsYou: number
  firstWaiting: string | null
  prNumber: number | null
  checksFailing: number
  checksPassing: number
  checksRunning: number
  failedStep: string | null
  contextPercent: number | null
  fiveHourPercent: number | null
  sevenDayPercent: number | null
  costUsd: number | null
}

export type ConsoleView = {
  readouts: ConsoleReadouts
  isWorking: boolean
  activeSubagents: number
  /** Absent or null where command-deck is not loaded, or has written nothing yet. */
  deckCondition?: DeckCondition | null
  /** Absent or null where command-deck is not loaded: the console then draws its own blocks alone. */
  deckFeed?: DeckFeed | null
  /** When the person last clicked the backdrop, in epoch milliseconds; 0 for never. */
  sweptAt: number
  /** The time of this drawing, in epoch milliseconds. */
  now: number
}

export const DISK_CAUTION_GB = 50
export const DISK_ALERT_GB = 20
export const CPU_CAUTION_PERCENT = 90

export type Condition = { level: 'NOMINAL' | 'CAUTION' | 'ALERT' | 'UNKNOWN'; reason: string }

const gigabytes = (size: number) => (size < 10 ? size.toFixed(1) : String(Math.round(size)))

// The console's condition is read off the readouts, never set by hand: an
// alert means the disk really is nearly full, and with the disk unread the
// console does not claim to be fine.
export function consoleCondition(readouts: ConsoleReadouts): Condition {
  const { diskFreeGb, cpuPercent, scannedAt } = readouts

  if (diskFreeGb === null) {
    return { level: 'UNKNOWN', reason: scannedAt === null ? 'AWAITING FIRST SCAN' : 'DISK NOT READ' }
  }
  if (diskFreeGb < DISK_ALERT_GB) {
    return { level: 'ALERT', reason: `DISK ${gigabytes(diskFreeGb)} GB FREE` }
  }
  if (diskFreeGb < DISK_CAUTION_GB) {
    return { level: 'CAUTION', reason: `DISK ${gigabytes(diskFreeGb)} GB FREE` }
  }
  if (cpuPercent !== null && cpuPercent >= CPU_CAUTION_PERCENT) {
    return { level: 'CAUTION', reason: `CPU AT ${Math.round(cpuPercent)}%` }
  }

  if (cpuPercent === null) {
    return { level: 'NOMINAL', reason: 'CPU NOT READ' }
  }

  return { level: 'NOMINAL', reason: 'ALL SYSTEMS' }
}

// The head's reason line holds about this many capital letters.
const BRIEF_LENGTH = 24

/**
 * Another mod's value, read as data: a condition only if it has a level this
 * console knows and words to show. The words are held to capitals, digits and
 * plain punctuation, since they are written into the backdrop's markup.
 */
export function readDeckCondition(value: unknown): DeckCondition | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { level, brief } = value as { level?: unknown; brief?: unknown }
  const words = typeof brief === 'string' ? brief.toUpperCase().replace(/[^A-Z0-9 .%:/-]/g, '').trim().slice(0, BRIEF_LENGTH) : ''

  return (level === 'nominal' || level === 'caution' || level === 'alert') && words !== '' ? { level, brief: words } : null
}

// Words from another mod go into the backdrop's markup, so they are held to
// capitals, digits and plain punctuation, and cut to fit a block.
const markupWords = (value: unknown, length: number): string | null =>
  typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9 .%:/_-]/g, '').trim().slice(0, length) || null : null
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const whole = (value: unknown): number => Math.max(0, Math.round(finite(value) ?? 0))

/** Another mod's summary, read as data: numbers only where they are numbers, words cleaned. */
export function readDeckFeed(value: unknown): DeckFeed | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const feed = value as Record<string, unknown>

  return {
    liveSessions: whole(feed.liveSessions),
    needsYou: whole(feed.needsYou),
    firstWaiting: markupWords(feed.firstWaiting, 16),
    prNumber: finite(feed.prNumber),
    checksFailing: whole(feed.checksFailing),
    checksPassing: whole(feed.checksPassing),
    checksRunning: whole(feed.checksRunning),
    failedStep: markupWords(feed.failedStep, 30),
    contextPercent: finite(feed.contextPercent),
    fiveHourPercent: finite(feed.fiveHourPercent),
    sevenDayPercent: finite(feed.sevenDayPercent),
    costUsd: finite(feed.costUsd),
  }
}

/** What the console's head shows: command-deck's condition when there is one, else the console's own. */
export function headCondition(view: ConsoleView): Condition {
  const deck = view.deckCondition ?? null

  return deck === null
    ? consoleCondition(view.readouts)
    : { level: deck.level === 'alert' ? 'ALERT' : deck.level === 'caution' ? 'CAUTION' : 'NOMINAL', reason: deck.brief }
}

const count = (value: number | null) => (value === null ? '-' : String(value))
const pullRequests = (value: number | null) =>
  value !== null && value >= PULL_REQUEST_LIMIT ? `${PULL_REQUEST_LIMIT}+` : count(value)

// What the scene says, for a reader that cannot see it.
export function describeConsole(view: ConsoleView): string {
  const { readouts } = view
  const condition = headCondition(view)

  return [
    `A sci-fi console frame of pastel bars with live readouts. Condition ${condition.level.toLowerCase()}: ${condition.reason.toLowerCase()}`,
    `disk ${readouts.diskFreeGb === null ? 'unknown' : `${gigabytes(readouts.diskFreeGb)} GB free`}`,
    `processor ${readouts.cpuPercent === null ? 'unknown' : `${Math.round(readouts.cpuPercent)}%`}`,
    `claude processes ${count(readouts.claudeProcesses)}`,
    `active subagents ${view.activeSubagents}`,
    `pull requests to review ${pullRequests(readouts.reviewRequests)}`,
    `your open pull requests ${pullRequests(readouts.openPullRequests)}`,
    view.isWorking ? 'Claude is working' : 'Claude is standing by',
  ].join(', ')
}

// The column, in screen points. A block is drawn in its own nested svg, so
// its parts are placed from the block's top left corner.
const COLUMN = 190
const BLOCK = 84
const GAP = 6
const FIRST_BLOCK_Y = 188
const INSET = 10
const GAUGE = COLUMN - 2 * INSET

// Icons, each in an 18 point box.
const ICONS = {
  disk: 'M3 5.2C3 3.4 15 3.4 15 5.2V12.8C15 14.6 3 14.6 3 12.8ZM3 5.2C3 7 15 7 15 5.2M3 9C3 10.8 15 10.8 15 9',
  chip: 'M5.5 4.5H12.5Q13.5 4.5 13.5 5.5V12.5Q13.5 13.5 12.5 13.5H5.5Q4.5 13.5 4.5 12.5V5.5Q4.5 4.5 5.5 4.5ZM7.5 7.5H10.5V10.5H7.5ZM7 2V4.5M11 2V4.5M7 13.5V16M11 13.5V16M2 7H4.5M2 11H4.5M13.5 7H16M13.5 11H16',
  terminal: 'M3.5 3.5H14.5Q16 3.5 16 5V13Q16 14.5 14.5 14.5H3.5Q2 14.5 2 13V5Q2 3.5 3.5 3.5ZM5 7L7.5 9L5 11M9.5 11.5H13',
  branches: 'M2 9a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M12 4a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M12 14a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M6 9H7.5Q9.5 9 9.5 7V6Q9.5 4 11.5 4H12M7.5 9Q9.5 9 9.5 11V12Q9.5 14 11.5 14H12',
  sessions: 'M2 4H12V11H2ZM6 7H16V14H6Z',
  check: 'M9 2L15 4.5V9Q15 13.5 9 16Q3 13.5 3 9V4.5ZM6 9L8.2 11.2L12 7',
  gauge: 'M2.5 13A6.5 6.5 0 1 1 15.5 13M9 13L12 7.5',
  pullRequest: 'M2 4a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M2 14a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M12 14a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M4 6V12M14 12V7.5Q14 5 11.5 5H9.5M11.5 3L9.5 5L11.5 7',
}

// A fill bar: the share of the whole it names (for the disk, what is free).
const bar = (fraction: number) =>
  `<rect class="track" x="${INSET}" y="68" width="${GAUGE}" height="8"/>` +
  `<rect class="ink" x="${INSET}" y="68" width="${(Math.min(1, Math.max(0, fraction)) * GAUGE).toFixed(1)}" height="8"/>`

// One thin bar per scan, newest on the right.
const trace = (samples: readonly number[]) =>
  Array.from({ length: TRACE_LENGTH }, (_, slot) => {
    const sample = samples[samples.length - TRACE_LENGTH + slot]
    const x = (INSET + slot * 10.8).toFixed(1)
    const height = sample === undefined ? 0 : Math.max(2, Math.round((sample / 100) * 18))

    return (
      `<rect class="track" x="${x}" y="62" width="8" height="18"/>` +
      (height > 0 ? `<rect class="ink" x="${x}" y="${80 - height}" width="8" height="${height}"/>` : '')
    )
  }).join('')

// One pip per thing counted, 20 to a row.
const pips = (lit: number, rows: number) =>
  Array.from({ length: rows * 20 }, (_, slot) => {
    const x = (INSET + (slot % 20) * 8.6).toFixed(1)
    const y = (rows === 1 ? 68 : 62) + Math.floor(slot / 20) * 10

    return `<rect class="${slot < lit ? 'ink' : 'track'}" x="${x}" y="${y}" width="6.5" height="8"/>`
  }).join('')

type Readout = {
  icon: string
  label: string
  value: string
  detail: string
  /** The strip under the value, in the block's own coordinates. */
  gauge: string
  /** The block's fill, by class. */
  tone: string
  /** In trouble: the block breathes. */
  isAlarmed?: boolean
  /** Wants a look: its lamp pulses. */
  wantsALook?: boolean
}

function consoleReadouts(view: ConsoleView): Readout[] {
  const { readouts } = view
  const { diskFreeGb, diskTotalGb, cpuPercent } = readouts
  const isDiskLow = diskFreeGb !== null && diskFreeGb < DISK_CAUTION_GB
  const isDiskCritical = diskFreeGb !== null && diskFreeGb < DISK_ALERT_GB
  const isCpuHigh = cpuPercent !== null && cpuPercent >= CPU_CAUTION_PERCENT

  const own: Readout[] = [
    {
      icon: ICONS.disk,
      label: isDiskLow ? 'DISK LOW' : 'DISK FREE',
      value: diskFreeGb === null ? '-' : `${gigabytes(diskFreeGb)} GB`,
      detail: diskTotalGb === null ? 'NO DATA' : `OF ${Math.round(diskTotalGb)}`,
      gauge: bar(diskFreeGb === null || diskTotalGb === null ? 0 : diskFreeGb / diskTotalGb),
      tone: isDiskCritical ? 'bad' : isDiskLow ? 'warn' : 'c3',
      isAlarmed: isDiskCritical,
      wantsALook: isDiskLow,
    },
    {
      icon: ICONS.chip,
      label: 'PROCESSOR',
      value: cpuPercent === null ? '-' : `${Math.round(cpuPercent)}%`,
      detail: readouts.cpuCores === null ? 'NO DATA' : `${readouts.cpuCores} CORES`,
      gauge: trace(readouts.cpuTrace),
      tone: isCpuHigh ? 'warn' : 'c2',
      wantsALook: isCpuHigh,
    },
    {
      icon: ICONS.terminal,
      label: 'CLAUDE PROCESSES',
      value: count(readouts.claudeProcesses),
      detail: readouts.claudeProcesses === null ? 'NO DATA' : 'ON THIS MAC',
      gauge: pips(readouts.claudeProcesses ?? 0, 2),
      tone: 'c4',
    },
    {
      icon: ICONS.branches,
      label: 'SUBAGENTS',
      value: String(view.activeSubagents),
      detail: 'THIS SESSION',
      gauge: pips(view.activeSubagents, 1),
      tone: 'c3',
      wantsALook: view.activeSubagents > 0,
    },
    {
      icon: ICONS.pullRequest,
      label: 'PULL REQUESTS',
      value: pullRequests(readouts.reviewRequests),
      detail:
        readouts.reviewRequests === null
          ? 'NO DATA'
          : readouts.githubCheckedAt === null
            ? 'TO REVIEW'
            : `TO REVIEW AT ${readouts.githubCheckedAt}`,
      gauge:
        `<text class="ink det" x="${INSET}" y="77">YOURS OPEN</text>` +
        `<text class="ink lab" x="${COLUMN - INSET}" y="77" text-anchor="end">${pullRequests(readouts.openPullRequests)}</text>`,
      tone: 'c2',
      wantsALook: (readouts.reviewRequests ?? 0) > 0,
    },
  ]
  const feed = view.deckFeed ?? null

  return feed === null ? own : [sessionsReadout(feed), ...own, ciReadout(feed), usageReadout(feed)]
}

// The three blocks fed by command-deck, drawn only while it is loaded.

function sessionsReadout(feed: DeckFeed): Readout {
  const isWaiting = feed.needsYou > 0

  return {
    icon: ICONS.sessions,
    label: isWaiting ? 'NEEDS YOU' : 'SESSIONS',
    value: isWaiting ? String(feed.needsYou) : String(feed.liveSessions),
    detail: isWaiting ? (feed.firstWaiting ?? 'THIS SESSION') : 'LIVE, NONE WAIT',
    gauge: pips(feed.liveSessions, 1),
    tone: isWaiting ? 'bad' : 'c1',
    isAlarmed: isWaiting,
    wantsALook: isWaiting,
  }
}

function ciReadout(feed: DeckFeed): Readout {
  const isFailing = feed.checksFailing > 0
  const detail =
    feed.prNumber === null
      ? 'NO PR'
      : isFailing
        ? `${feed.checksFailing} FAILED`
        : feed.checksRunning > 0
          ? `${feed.checksRunning} RUNNING`
          : feed.checksPassing > 0
            ? 'ALL PASS'
            : 'NO CHECKS'
  const total = feed.checksFailing + feed.checksPassing + feed.checksRunning

  return {
    icon: ICONS.check,
    label: 'BRANCH CHECKS',
    value: feed.prNumber === null ? '-' : `#${feed.prNumber}`,
    detail,
    gauge:
      isFailing && feed.failedStep !== null
        ? `<text class="ink det" x="${INSET}" y="77">${feed.failedStep}</text>`
        : bar(total === 0 ? 0 : feed.checksPassing / total),
    tone: isFailing ? 'bad' : 'c3',
    wantsALook: isFailing,
  }
}

function usageReadout(feed: DeckFeed): Readout {
  const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value)}%`)
  const isNearLimit = [feed.fiveHourPercent, feed.sevenDayPercent].some(value => value !== null && value >= 80)

  return {
    icon: ICONS.gauge,
    label: 'CONTEXT',
    value: percent(feed.contextPercent),
    detail: feed.costUsd === null ? 'NO COST' : `EST $${feed.costUsd.toFixed(2)}`,
    gauge:
      `<text class="ink det" x="${INSET}" y="77">5H ${percent(feed.fiveHourPercent)}</text>` +
      `<text class="ink det" x="${COLUMN - INSET}" y="77" text-anchor="end">7D ${percent(feed.sevenDayPercent)}</text>`,
    tone: isNearLimit ? 'warn' : 'c4',
    wantsALook: isNearLimit,
  }
}

const LAMP_TONES = ['c4', 'c1', 'c3', 'c2', 'c4']

function block(readout: Readout, index: number, isWorking: boolean): string {
  const lamp = isWorking ? ` chase k${index}` : readout.wantsALook ? ' pulse' : ''

  return `<svg x="${-COLUMN}" y="${FIRST_BLOCK_Y + index * (BLOCK + GAP)}" overflow="visible">
<rect class="${readout.tone}${readout.isAlarmed ? ' alarm' : ''}" x="0" y="0" width="${COLUMN}" height="${BLOCK}"/>
<rect class="${LAMP_TONES[index % LAMP_TONES.length]}${lamp}" x="-14" y="0" width="8" height="${BLOCK}"/>
<svg x="${INSET}" y="9" overflow="visible"><path class="ic" d="${readout.icon}"/></svg>
<text class="ink lab" x="36" y="23">${readout.label}</text>
<text class="ink val" x="${INSET}" y="54">${readout.value}</text>
<text class="ink det" x="${COLUMN - INSET}" y="54" text-anchor="end">${readout.detail}</text>
${readout.gauge}
</svg>`
}

// A redraw swaps the whole picture, which starts its animations afresh. A
// negative delay puts each loop where it would be had it run since the epoch,
// so a redraw carries on from the same point of the cycle.
const phase = (now: number, periodSeconds: number, offsetSeconds = 0) =>
  `-${((now / 1000 + periodSeconds - offsetSeconds) % periodSeconds).toFixed(2)}s`

const SWEEP_SECONDS = 1.6

export function starshipScene(view: ConsoleView): string {
  const condition = headCondition(view)
  const headTone = condition.level === 'ALERT' ? 'bad alarm' : condition.level === 'CAUTION' ? 'warn' : 'c1'
  const blocks = consoleReadouts(view)
  const fillerY = FIRST_BLOCK_Y + blocks.length * (BLOCK + GAP)
  // A click sends one bright band down the column while the readouts are
  // read again. A redraw during its run picks it up where it was, and at
  // rest (reduced motion) it does not show.
  const sinceSweep = (view.now - view.sweptAt) / 1000
  const isSweeping = sinceSweep >= 0 && sinceSweep < SWEEP_SECONDS
  const sweepStyle = `.sweep { fill: #ffffff; opacity: 0; animation: sweep ${SWEEP_SECONDS}s linear 1 both; animation-delay: -${sinceSweep.toFixed(2)}s; }
.trail { opacity: 0.3; }
@keyframes sweep { 0% { opacity: 0.8; transform: translateY(0px); } 70% { opacity: 0.8; } 100% { opacity: 0; transform: translateY(1500px); } }`
  const sweepBand = `<g class="sweep"><rect class="trail" x="${-COLUMN - 14}" y="${FIRST_BLOCK_Y - 40}" width="${COLUMN + 14}" height="36"/><rect x="${-COLUMN - 14}" y="${FIRST_BLOCK_Y - 4}" width="${COLUMN + 14}" height="4"/></g>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
<style>
.ground { fill: #000000; }
.c1 { fill: #ff9966; }
.c2 { fill: #cc99cc; }
.c3 { fill: #9999ff; }
.c4 { fill: #ffcc99; }
.warn { fill: #ffe14d; }
.bad { fill: #ff6670; }
.ink { fill: #000000; font-family: sans-serif; }
.lab { font-size: 10.5px; font-weight: bold; letter-spacing: 1.2px; }
.val { font-size: 24px; font-weight: bold; }
.det { font-size: 10.5px; letter-spacing: 1px; }
.ic { fill: none; stroke: #000000; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.track { fill: #000000; opacity: 0.2; }
.pulse { opacity: 1; animation: glow 4s ease-in-out infinite; animation-delay: ${phase(view.now, 4)}; }
.blink { opacity: 1; animation: glow 5s ease-in-out infinite; animation-delay: ${phase(view.now, 5, 1)}; }
@keyframes glow { 0% { opacity: 1; } 50% { opacity: 0.25; } 100% { opacity: 1; } }
.alarm { opacity: 1; animation: breathe 3s ease-in-out infinite; animation-delay: ${phase(view.now, 3)}; }
@keyframes breathe { 0% { opacity: 1; } 50% { opacity: 0.72; } 100% { opacity: 1; } }
.chase { opacity: 1; animation: chase 3s ease-in-out infinite; }
${blocks.map((_, index) => `.k${index} { animation-delay: ${phase(view.now, 3, index * 0.4)}; }`).join(' ')}
@keyframes chase { 0% { opacity: 1; } 12% { opacity: 0.25; } 30% { opacity: 1; } 100% { opacity: 1; } }
${isSweeping ? sweepStyle : ''}
@media (prefers-color-scheme: light) {
  .ground { fill: #e8e2d6; }
  .c1 { fill: #d9733f; }
  .c2 { fill: #a678a6; }
  .c3 { fill: #6f6fcf; }
  .c4 { fill: #e0a868; }
  .warn { fill: #e8c21a; }
  .bad { fill: #e05a66; }
}
</style>
<rect class="ground" x="0" y="0" width="100%" height="100%"/>

<!-- top right elbow and its arm, which carry the condition of the console -->
<svg x="100%" y="0" overflow="visible">
<path class="${headTone}" d="M0 152Q0 56 -96 56H-300V90H-232Q-190 90 -190 132V182H0Z"/>
<text class="ink lab" x="-178" y="122">CONDITION</text>
<text class="ink val" x="-178" y="149">${condition.level}</text>
<text class="ink det" x="-178" y="169">${condition.reason}</text>
<rect class="c4 blink" x="-360" y="56" width="54" height="34"/>
<rect class="c2 pulse" x="-420" y="56" width="54" height="34"/>

<!-- the column, one block a readout, then a plain run to the bottom -->
${blocks.map((readout, index) => block(readout, index, view.isWorking)).join('\n')}
<rect class="c1" x="${-COLUMN}" y="${fillerY}" width="${COLUMN}" height="100%"/>
${isSweeping ? sweepBand : ''}
</svg>

<!-- bottom right elbow and its arm, which say what Claude is doing and when the last scan was -->
<svg x="100%" y="100%" overflow="visible">
<rect class="ground" x="${-COLUMN - 14}" y="-196" width="${COLUMN + 14}" height="196"/>
<path class="c1" d="M0 -136Q0 -40 -96 -40H-300V-66H-232Q-190 -66 -190 -108V-190H0Z"/>
<text class="ink lab" x="-178" y="-162">CLAUDE</text>
<text class="ink val" x="-178" y="-135">${view.isWorking ? 'WORKING' : 'STANDBY'}</text>
<text class="ink det" x="-178" y="-115">${view.readouts.scannedAt === null ? 'NO SCAN YET' : `LAST SCAN ${view.readouts.scannedAt}`}</text>
<rect class="c3" x="-360" y="-66" width="54" height="26"/>
<rect class="c4" x="-420" y="-66" width="54" height="26"/>
</svg>
</svg>`
}
