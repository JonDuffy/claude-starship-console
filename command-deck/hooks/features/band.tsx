// The band above the prompt: the condition, this branch's pull request and
// checks, and the usage figures, in one row. Under the starship look the row
// is a run of flat colour segments with rounded ends; under any other look
// it is one line of plain words. Both carry the same facts.
//
// While checks fail, the row names the failed job and step and holds the
// "Fix it" button, and the first error line of the log sits under it.

import type { ElementTable, EngineInterface, RenderElement } from 'claude-code'

import { clockTimeFrom, cut, formatUsd, lookUp } from '../lib/format'
import { AMBER, BLUE, CAP_HEIGHT, CAP_WIDTH, capSvg, ICE, INK, LILAC, MINT, PEACH, RED, ROSE, SAND, VIOLET } from '../lib/lcars'
import { readCondition, readLook, readPr, readUsage, readUtcOffsetMinutes } from '../state'
import { checksLabel, failurePlace, fillFix, REVIEW_WORDS, summarizeChecks } from './pr-strip'
import { usageParts } from './usage-gauge'

import type { DeckCondition, DeckPrReadout, DeckUsage } from '../../types'

/** One flat block of the starship band. A segment with an address is a link: the pull request's. */
export type Segment = { text: string; color: string; href?: string }

const LIMIT_WORDS: Record<string, string> = { five_hour: '5H', seven_day: '7D', spend_limit: 'SPEND' }
const REVIEW_SEGMENTS: Record<string, string> = {
  APPROVED: 'APPROVED',
  CHANGES_REQUESTED: 'CHANGES ASKED',
  REVIEW_REQUIRED: 'REVIEW',
}
const LEVEL_COLORS = { nominal: BLUE, caution: AMBER, alert: RED } as const

export type BandInputs = {
  condition: DeckCondition
  pr: DeckPrReadout
  usage: DeckUsage
  now: number
  offsetMinutes: number | null
}

/** Whether the band has anything to say: before the first reading of anything, it draws nothing. */
export function isBandQuiet(inputs: BandInputs): boolean {
  return (
    inputs.condition.level === 'nominal' &&
    inputs.pr.pr === null &&
    inputs.pr.reason === null &&
    usageParts(inputs.usage, inputs.now, inputs.offsetMinutes).length === 0
  )
}

/** The starship band's segments, left to right. The condition leads and always carries its reason when it is not nominal. */
export function bandSegments(inputs: BandInputs): Segment[] {
  const { condition, usage } = inputs
  const found = inputs.pr.pr
  const segments: Segment[] = [
    {
      text: condition.level === 'nominal' ? 'NOMINAL' : `${condition.level.toUpperCase()} · ${condition.brief}`,
      color: LEVEL_COLORS[condition.level],
    },
  ]

  if (found === null && inputs.pr.reason !== null) {
    segments.push({ text: `PR - (${cut(inputs.pr.reason, 40)})`, color: LILAC })
  }
  if (found !== null && found.state !== 'OPEN') {
    segments.push({ text: `PR ${found.number} ${found.state}`, color: LILAC, href: found.url })
  }
  if (found !== null && found.state === 'OPEN') {
    const counted = found.checks.filter(check => check.state !== 'skipped')
    const count = (state: string) => counted.filter(check => check.state === state).length
    const verdict = summarizeChecks(found.checks)

    segments.push({ text: `PR ${found.number}`, color: BLUE, href: found.url })
    segments.push({ text: lookUp(REVIEW_SEGMENTS, found.review) ?? 'NO REVIEW STATE', color: LILAC })
    if (verdict === 'fail') {
      segments.push({ text: `CI FAILED ${count('pass')}/${counted.length}`, color: RED })
      if (inputs.pr.failure !== null) {
        segments.push({ text: cut(failurePlace(inputs.pr.failure), 48).toUpperCase(), color: PEACH })
      }
    } else if (verdict === 'running') {
      segments.push({ text: `CI ${count('pass')}/${counted.length} · ${count('running')} RUNNING`, color: PEACH })
    } else {
      segments.push({ text: verdict === 'pass' ? `CI ${count('pass')}/${counted.length}` : 'NO CHECKS', color: MINT })
    }
  }
  if (usage.contextPercent !== null) {
    segments.push({ text: `CTX ${Math.round(usage.contextPercent)}%`, color: ICE })
  }
  for (const [index, limit] of usage.rateLimits.entries()) {
    const resetsAt = limit.resetsAt === null ? Number.NaN : Date.parse(limit.resetsAt)
    const reset = Number.isFinite(resetsAt) ? ` ${clockTimeFrom(resetsAt, inputs.now, inputs.offsetMinutes)}` : ''

    segments.push({
      text: `${lookUp(LIMIT_WORDS, limit.kind) ?? limit.kind} ${Math.round(limit.percentUsed)}%${reset}`,
      color: limit.percentUsed >= 80 ? AMBER : index % 2 === 0 ? PEACH : SAND,
    })
  }
  if (usage.costUsd !== null) {
    segments.push({ text: `EST ${formatUsd(usage.costUsd)}`, color: VIOLET })
  }
  if (usage.topAgent !== null) {
    segments.push({ text: `TOP AGENT EST ${formatUsd(usage.topAgent.costUsd)}`, color: ROSE })
  }

  return segments
}

/** The plain band's words after the condition and the pull request's link, in the same order as the segments. */
export function bandWords(inputs: BandInputs): string[] {
  const found = inputs.pr.pr
  const words: string[] = []

  if (found === null && inputs.pr.reason !== null) {
    words.push(`PR - (${inputs.pr.reason})`)
  }
  if (found !== null && found.state !== 'OPEN') {
    words.push(found.state.toLowerCase())
  }
  if (found !== null && found.state === 'OPEN') {
    words.push(lookUp(REVIEW_WORDS, found.review) ?? 'no review state', checksLabel(found.checks))
    if (inputs.pr.failure !== null && summarizeChecks(found.checks) === 'fail') {
      words.push(`failed: ${failurePlace(inputs.pr.failure)}`)
    }
  }

  return [...words, ...usageParts(inputs.usage, inputs.now, inputs.offsetMinutes)]
}

/** The band's row, or null while there is nothing to say. */
export async function drawBand($: EngineInterface, ui: ElementTable): Promise<RenderElement | null> {
  const { Box, Button, Link, Text } = ui
  const inputs: BandInputs = {
    condition: await readCondition($),
    pr: await readPr($),
    usage: await readUsage($),
    now: await $.clock.now(),
    offsetMinutes: await readUtcOffsetMinutes($),
  }

  if (isBandQuiet(inputs)) {
    return null
  }
  const found = inputs.pr.pr
  const isFailing = found !== null && found.state === 'OPEN' && summarizeChecks(found.checks) === 'fail'
  const fix = isFailing ? <Button key="fix" variant="primary" label="Fix it" onPress={() => fillFix($)} /> : null
  const errorLine =
    isFailing && inputs.pr.failure?.line != null ? (
      <Text mono color="warning">
        {inputs.pr.failure.line}
      </Text>
    ) : null

  if ((await readLook($)) !== 'starship') {
    const { condition } = inputs
    const words = bandWords(inputs)

    return (
      <Box flexDirection="column">
        <Box columnGap={1} flexWrap="wrap">
          {condition.level !== 'nominal' && (
            <Text color={condition.level === 'alert' ? 'error' : 'warning'}>
              {condition.level === 'alert' ? 'Alert' : 'Caution'}: {condition.reason}
            </Text>
          )}
          {found !== null && <Link href={found.url} label={`PR #${found.number}`} />}
          {words.length > 0 && <Text dimColor>{words.join(' · ')}</Text>}
          {fix}
        </Box>
        {errorLine}
      </Box>
    )
  }
  const segments = bandSegments(inputs)
  // The button sits right after the checks, where the failure is named.
  const fixAfter = segments.findIndex(segment => segment.text.startsWith('CI FAILED')) + (inputs.pr.failure === null ? 0 : 1)
  const Svg = 'Svg' in ui ? ui.Svg : undefined
  const cap = (side: 'left' | 'right', color: string) =>
    Svg === undefined ? null : <Svg source={capSvg(side, color)} alt="rounded end" width={CAP_WIDTH} height={CAP_HEIGHT} />

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap="xs">
        {cap('left', segments[0]?.color ?? BLUE)}
        {segments.flatMap((segment, index) => [
          <Box backgroundColor={segment.color} paddingX={1} flexShrink={0}>
            {segment.href === undefined ? (
              <Text color={INK} weight="semibold">
                {segment.text}
              </Text>
            ) : (
              <Link href={segment.href}>
                <Text color={INK} weight="semibold">
                  {segment.text}
                </Text>
              </Link>
            )}
          </Box>,
          isFailing && index === fixAfter ? fix : null,
        ])}
        {cap('right', segments.at(-1)?.color ?? BLUE)}
      </Box>
      {errorLine}
    </Box>
  )
}
