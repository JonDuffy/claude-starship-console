// This session's subagents, read from the engine's list: who is running and
// what each has cost. The heartbeat, the end-of-turn footer, the spinner and
// the band's "top agent" segment all read the rows kept here.

import type { EngineInterface } from 'claude-code'

import { readUsage, writeAgents, writeUsage } from '../state'

import type { DeckAgent, DeckUsage } from '../../types'

const ROW_LIMIT = 40

/** The agent with the highest cost estimate, if any has one. */
export function topAgentOf(rows: readonly DeckAgent[]): DeckUsage['topAgent'] {
  const priced = rows.filter(row => row.costUsd !== null && row.costUsd > 0)
  const top = priced.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))[0]

  return top === undefined ? null : { description: top.description, costUsd: top.costUsd ?? 0 }
}

/** Reads the session's agents into the kept rows, newest first. */
export async function refreshAgents($: EngineInterface): Promise<DeckAgent[]> {
  const rows = [...(await $.agent.list())]
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, ROW_LIMIT)
    .map(
      (agent): DeckAgent => ({
        id: agent.id,
        description: agent.description,
        status: agent.status,
        kind: agent.kind,
        costUsd: agent.cost?.usd ?? null,
      }),
    )

  await writeAgents($, rows)
  const top = topAgentOf(rows)

  if (JSON.stringify((await readUsage($)).topAgent) !== JSON.stringify(top)) {
    await writeUsage($, last => ({ ...last, topAgent: top }))
  }

  return rows
}

/** How an agent's turn ended, in a word. */
export function endWord(reason: string): string {
  if (reason === 'answer') {
    return 'finished'
  }
  if (reason === 'aborted') {
    return 'stopped'
  }

  return reason === 'refusal' ? 'refused' : 'failed'
}
