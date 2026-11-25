// command-deck: small instruments for a person running many sessions. Each
// feature lives in a file under ./features. The engine takes one hook per event from a module unless a
// matcher tells them apart, so the events several features share (a turn's
// start and end, a prompt, a tool call's end) are hooked once here and handed
// to each feature in turn. A feature that fails costs its own step and no
// other: see `quietly`.

import type { EngineInterface, Register, Timer } from 'claude-code'

import { shortReason } from './lib/format'
import { currentPlace, homeFolder, quietly, readFreeGb, readUtcOffset } from './lib/host'
import { mergeToolBadge, readAgents, readToolBadge, writeFreeGb, writeStatus, writeUtcOffsetMinutes } from './state'
import { awsTargets, judgeAws } from './features/aws-guard'
import { endWord, refreshAgents } from './features/agents'
import { drawBand } from './features/band'
import {
  beginPermissionWait,
  beginWait,
  endPermissionWait,
  endPermissionWaits,
  endWait,
  publishStatus,
  questionLabel,
} from './features/call-lights'
import { syncCondition } from './features/condition'
import { runDeck } from './features/deck-command'
import { heavyStep, judgeDisk } from './features/disk-guard'
import type { GuardVerdict } from './features/disk-guard'
import {
  ciContext,
  codexPrompt,
  drawToolBadges,
  exitOf,
  explainPrompt,
  mentionsCi,
  spinnerWords,
} from './features/extras'
import { HEARTBEAT_MS, isActiveAgent, readFleet, writeHeartbeat } from './features/fleet'
import { currentFooter, isPersonPrompt, noteStop, noteTurnStart } from './features/footer'
import { keptLogContext, LOG_ATTACHED, pollJitterMs, PR_POLL_MS, refreshPr } from './features/pr-strip'
import { recordUsage } from './features/usage-gauge'

import type { DeckAgent } from '../types'

/** How often the agent list is read again while a subagent runs. */
const AGENT_TICK_MS = 15_000

let timers: Timer[] = []
// Subagents whose turn started and has not ended, told by the turn events:
// the engine's list may not show a new one yet.
const runningTurns = new Set<string>()

function commandOf(input: unknown): string {
  const command = typeof input === 'object' && input !== null ? (input as { command?: unknown }).command : undefined

  return typeof command === 'string' ? command : ''
}

const isGuarded = (command: string) => awsTargets(command).length > 0 || heavyStep(command) !== null

async function tickAgents($: EngineInterface): Promise<void> {
  if (runningTurns.size > 0 || (await readAgents($)).some(agent => isActiveAgent(agent.status))) {
    await refreshAgents($)
    await publishStatus($)
  }
}

// The minute's tick: this session's heartbeat, every session's, the free
// space on the disk, and the condition those add up to.
async function tickMinute($: EngineInterface): Promise<void> {
  await writeHeartbeat($)
  await readFleet($)
  await writeFreeGb($, await readFreeGb($, (await homeFolder($)) ?? (await $.session.cwd())))
  await syncCondition($)
}

// What gh is asked on one timer: this branch's pull request.
async function pollGithub($: EngineInterface): Promise<void> {
  await quietly($, 'the pull request', () => refreshPr($))
}

function startTimers($: EngineInterface, sessionId: string): void {
  for (const timer of timers) {
    timer.cancel()
  }
  timers = [
    $.clock.every(HEARTBEAT_MS, () => void quietly($, 'the minute tick', () => tickMinute($))),
    $.clock.every(AGENT_TICK_MS, () => void quietly($, 'the agent list', () => tickAgents($))),
    // Sessions restored together would all ask gh at once: each waits its own few seconds first.
    $.clock.after(pollJitterMs(sessionId), () => {
      void pollGithub($)
      timers.push($.clock.every(PR_POLL_MS, () => void pollGithub($)))
    }),
  ]
}

async function firstReadings($: EngineInterface): Promise<void> {
  startTimers($, await $.session.id())
  const offset = await readUtcOffset($)

  if (offset !== null) {
    await writeUtcOffsetMinutes($, offset)
  }
  await quietly($, 'the first usage reading', async () => recordUsage($, await $.session.usage()))
  await quietly($, 'the first agent list', () => refreshAgents($))
  await publishStatus($)
  await tickMinute($)
}

// The panes earlier versions opened. This version opens none, and closes any that a restored session still holds.
const OLD_PANES = ['deck-fleet', 'deck-agents', 'deck-away', 'deck-disk', 'deck-worktrees', 'command-deck']

function strictest(verdicts: readonly GuardVerdict[]): GuardVerdict {
  const denied = verdicts.find(verdict => verdict.kind === 'deny')
  const asked = verdicts.filter(verdict => verdict.kind === 'ask')

  if (denied !== undefined) {
    return denied
  }

  return asked.length === 0 ? { kind: 'pass' } : { kind: 'ask', reason: asked.map(verdict => verdict.reason).join(' Also: ') }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await quietly($, 'registering /deck', () =>
      $.command.register({
        name: 'deck',
        description: 'command-deck: bundle size, AWS allow-list, test the call light',
        argumentHint: 'bundle | notify | aws list | aws allow <id> | aws remove <id>',
      }),
    )
    await quietly($, 'closing the old panes', () => Promise.all(OLD_PANES.map(id => $.ui.close({ id }))))
    // No turn of the main conversation runs as a session starts, whatever an earlier load left written.
    await quietly($, 'the status reset', () => writeStatus($, last => ({ ...last, isMainWorking: false })))
    // Not awaited: the first prompt does not wait on git, gh or du.
    void quietly($, 'the first readings', () => firstReadings($))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await quietly($, 'the last heartbeat', () => writeHeartbeat($, true))

    return next(e)
  })

  on('command.run', { command: 'deck' }, async ($, e) => ({ text: await runDeck($, e.args, e.origin.kind) }))

  // ---- Turns: working or idle, the footer, subagent toasts

  on('turn.start', async ($, e, next) => {
    await quietly($, 'a turn start', async () => {
      if (e.agentId === undefined) {
        noteTurnStart()
        await publishStatus($, { isMainWorking: true })
      } else {
        runningTurns.add(e.agentId)
        await refreshAgents($)
        await publishStatus($)
      }
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    let rows: DeckAgent[] = []

    await quietly($, 'a turn end', async () => {
      if (e.agentId !== undefined) {
        runningTurns.delete(e.agentId)
      }
      rows = await refreshAgents($)
      if (e.agentId === undefined) {
        await endPermissionWaits($)
        await publishStatus($, { isMainWorking: false })
      } else {
        const agent = rows.find(row => row.id === e.agentId)
        const note = `Subagent ${endWord(e.reason)}: ${agent?.description ?? e.agentId}`

        await endPermissionWaits($, e.agentId)
        await publishStatus($)
        // A teammate ends a turn each time it goes idle: too often for a toast.
        if (agent?.kind !== 'in_process_teammate') {
          $.ui.toast(note)
        }
      }
    })
    const ended = await next(e)
    const footer = e.agentId === undefined && e.reason === 'answer' ? currentFooter(rows) : null

    return footer === null ? ended : { ...ended, text: footer }
  })

  on('prompt.submit', async ($, e, next) => {
    let context: string | null = null

    try {
      if (isPersonPrompt(e)) {
        // The person is here: nothing waits on them unseen.
        await endPermissionWaits($)
        // A prompt that says its log is attached gets the log kept when the failure was read, or a fresh one.
        if (e.text.includes(LOG_ATTACHED)) {
          context = (await keptLogContext($)) ?? (await ciContext($))
        } else if (mentionsCi(e.text)) {
          context = await ciContext($)
        }
      }
    } catch (error) {
      $.ui.log(`command-deck: a prompt step failed: ${shortReason(String(error)) ?? 'unknown'}`, { to: 'debug' })
    }

    return next(context === null ? e : { ...e, context: [...(e.context ?? []), context] })
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await quietly($, 'the usage gauge', async () => {
      await recordUsage($, e)
      await syncCondition($)
    })

    return next(e)
  })

  on('session.stop', async ($, e, next) => {
    await quietly($, 'a stop', () => endPermissionWaits($))

    return next(e)
  })

  // ---- Call lights: what holds the session for the person

  on('tool.call', { tool: ['AskUserQuestion', 'ExitPlanMode'] }, async ($, e, next) => {
    const key = `question:${e.tool_use_id}`

    await quietly($, 'the call light', () => beginWait($, key, questionLabel(e.tool, e)))
    try {
      return await next(e)
    } finally {
      await quietly($, 'the call light', () => endWait($, key))
    }
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    await quietly($, 'the call light', () => beginPermissionWait($, e))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PermissionDenied', async ($, e, next) => {
    await quietly($, 'the call light', () => endPermissionWait($, e))

    return next(e)
  }).catch(($, e, next) => next(e))

  // Every call of the batch has resolved, allowed or refused: no prompt of this loop is still open.
  on('classic.PostToolBatch', async ($, e, next) => {
    await quietly($, 'the call light', () => endPermissionWaits($, e.agent_id))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    await quietly($, 'a tool end', async () => {
      await endPermissionWait($, e)
      if (e.tool_name === 'Bash') {
        await mergeToolBadge($, e.tool_use_id, { durationMs: e.duration_ms, exit: 'exit 0' })
      }
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', async ($, e, next) => {
    await quietly($, 'a tool failure', async () => {
      await endPermissionWait($, e)
      if (e.tool_name === 'Bash') {
        await mergeToolBadge($, e.tool_use_id, { durationMs: e.duration_ms, exit: exitOf(e.error, e.is_interrupt === true) })
      }
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    if (e.agent_id === undefined) {
      noteStop(e.background_tasks)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- Guards: asked or denied before a Bash command runs

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const command = commandOf(e.input)

    if (!isGuarded(command)) {
      return next(e)
    }
    const aws = await judgeAws($, command, (await currentPlace($)).repoRoot)

    if (aws.badge !== null && e.tool_use_id !== undefined) {
      await mergeToolBadge($, e.tool_use_id, { aws: aws.badge })
    }
    const verdict = strictest([aws.verdict, await judgeDisk($, command)])

    if (verdict.kind === 'deny') {
      return { decision: 'deny', reason: verdict.reason }
    }
    const beneath = await next(e)

    // A guard only tightens: what is refused beneath stays refused.
    return verdict.kind === 'pass' || beneath.decision === 'deny' ? beneath : { decision: 'ask', reason: verdict.reason }
  }).catch(($, e, next) =>
    // A guard that broke must not wave through what it was there to question.
    isGuarded(commandOf(e.input))
      ? { decision: 'ask', reason: `command-deck: a guard on this command failed (${next.error.message ?? next.error.kind}). Check it before it runs.` }
      : next(e),
  )

  // ---- Drawing: the band, Bash rows, the right-click menu, the spinner

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    return (await drawBand($, $.ui.resolve(e))) ?? next(e)
  })

  on('ui.render', { component: 'ToolUse', props: { tool: 'Bash' } }, async ($, e, next) => {
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const badge = await readToolBadge($, e)
    const extra = drawToolBadges(ui, badge, {
      command: commandOf(e.props.input),
      isRunning: e.props.isRunning,
      isErrored: e.props.isErrored,
      output: e.props.output,
    })

    return extra === null ? next(e) : (
      <Box flexDirection="column">
        {await next(e)}
        {extra}
      </Box>
    )
  })

  on('ui.render', { component: 'ContextMenu' }, ($, e, next) => {
    const text = e.props.selection?.text ?? e.props.code?.text

    if (text === undefined || text.trim() === '') {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Button key="codex-review" onPress={() => $.prompt.fill({ text: codexPrompt(text), mode: 'insert' })}>
          Ask Codex to review this <Text dimColor>Adds to the prompt</Text>
        </Button>
        <Button key="explain" onPress={() => $.prompt.fill({ text: explainPrompt(text), mode: 'insert' })}>
          Explain this <Text dimColor>Adds to the prompt</Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const running = (await readAgents($)).filter(agent => isActiveAgent(agent.status)).length

    return next({ ...e, props: { ...e.props, ...spinnerWords(e.props, e.surface, running) } })
  })

}
