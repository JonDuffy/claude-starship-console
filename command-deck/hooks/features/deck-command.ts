// `/deck`: the one slash command. The deck pane is gone: what the deck reads
// shows in the console column of the starship look and the band above the
// prompt, so the command keeps only what needs no pane.

import type { EngineInterface } from 'claude-code'

import { shortReason } from '../lib/format'
import { currentPlace } from '../lib/host'
import { allowedAccounts, editAllowed, isAccountId } from './aws-guard'
import { testCallLight } from './call-lights'
import { reportBundle } from './extras'

export const DECK_HELP = [
  'The deck\'s readouts are in the console column (the starship look) and the band above the prompt. Subcommands:',
  'bundle: the newest build against the last recorded size',
  'aws list, aws allow <id>, aws remove <id>: this repo\'s AWS allow-list',
  'notify: test the call light',
].join('\n')

// The allow-list decides which AWS accounts a session may act on, so only the
// person's own typed command edits it: not a plugin's, a channel's or another session's.
const PERSON_ORIGINS = new Set(['composer', 'sdk', 'bridge'])

async function runAws($: EngineInterface, words: readonly string[], originKind: string): Promise<string> {
  const { repoRoot } = await currentPlace($)
  const [action, account] = words

  if ((action === 'allow' || action === 'remove') && !PERSON_ORIGINS.has(originKind)) {
    return `The AWS allow-list was not changed: /deck aws ${action} must be typed by the person, and this one came from "${originKind}".`
  }

  if (action === 'list') {
    const allowed = await allowedAccounts($, repoRoot)

    return allowed.length === 0
      ? `No AWS allow-list for ${repoRoot}. The guard asks before each aws, cdk, sst or terraform command that reaches AWS.`
      : `AWS accounts allowed for ${repoRoot}: ${allowed.join(', ')}. Any other account is denied.`
  }
  if ((action === 'allow' || action === 'remove') && account !== undefined && isAccountId(account)) {
    const allowed = await editAllowed($, repoRoot, account, action)

    return `${action === 'allow' ? 'Allowed' : 'Removed'} ${account} for ${repoRoot}. The list is now: ${allowed.length === 0 ? 'empty, so the guard asks each time' : allowed.join(', ')}.`
  }

  return 'Usage: /deck aws allow <12-digit account id> | /deck aws remove <id> | /deck aws list'
}

/** Runs one `/deck` line and answers the text the command prints. It never throws. */
export async function runDeck($: EngineInterface, args: string, originKind: string): Promise<string> {
  // `aws-list` reads as `aws list`.
  const [typed = '', ...rest] = args.trim().replace(/^aws-/i, 'aws ').split(/\s+/)
  const subcommand = typed.toLowerCase()

  try {
    switch (subcommand) {
      case '':
      case 'help':
        return DECK_HELP
      case 'bundle':
        return await reportBundle($)
      case 'notify':
        return await testCallLight($)
      case 'aws':
        return await runAws($, rest, originKind)
      default:
        return `No /deck subcommand "${typed}".\n${DECK_HELP}`
    }
  } catch (error) {
    return `/deck ${typed} failed: ${shortReason(String(error)) ?? 'unknown'}`
  }
}
