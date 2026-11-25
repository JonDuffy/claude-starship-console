// Feature 7, the AWS guard: before a Bash command that reaches AWS runs, read
// which account it would act on and hold it to this repository's allow-list.
//
// The one AWS call made is `aws sts get-caller-identity`, which reads who the
// credentials are and changes nothing. It is made only for a command that
// itself reaches AWS: `cdk synth`, `aws configure`, `terraform fmt` and the
// like work offline and are let through unread.

import type { EngineInterface } from 'claude-code'

import { lookUp, parseObject } from '../lib/format'
import { findTool, run } from '../lib/host'
import { flagValue, readInvocations } from '../lib/shell'

import type { GuardVerdict } from './disk-guard'
import type { DeckAwsBadge } from '../../types'

const ALLOW_KEY = 'aws.allow'
const IDENTITY_KEPT_MS = 5 * 60_000
/** A failed identity check is asked again sooner than a good one. */
const FAILURE_KEPT_MS = 30_000

// Subcommands that never reach AWS, by program. A bare program prints its usage.
const OFFLINE: Record<string, readonly string[]> = {
  aws: ['help', 'configure'],
  cdk: ['synth', 'synthesize', 'init', 'doctor', 'docs', 'context', 'acknowledge', 'version'],
  sst: ['version'],
  terraform: ['fmt', 'validate', 'version'],
}

export type AwsTarget = {
  program: string
  /** The profile the command names, with `--profile` or `AWS_PROFILE=`; null when it names none. */
  profile: string | null
  /** The region the command names, with `--region` or `AWS_REGION=`; null when it names none. */
  region: string | null
}

// Flags that take the next word as their value, so that word is no subcommand.
const VALUE_FLAGS = new Set(['--profile', '--region', '--output', '--app', '-a', '--context', '-c', '--endpoint-url'])

/** The first argument that is neither a flag nor a flag's value: `deploy` in `cdk --profile x deploy`. */
function subcommandOf(words: readonly string[]): string | null {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] as string

    if (VALUE_FLAGS.has(word)) {
      index += 1
    } else if (!word.startsWith('-')) {
      return word
    }
  }

  return null
}

/** Each step of a command line that reaches AWS, with the profile and region it names. */
export function awsTargets(command: string): AwsTarget[] {
  return readInvocations(command).flatMap(({ env, words }) => {
    const program = words[0] ?? ''
    const offline = lookUp(OFFLINE, program)
    const subcommand = subcommandOf(words)
    const isOffline =
      offline === undefined ||
      subcommand === null ||
      offline.includes(subcommand) ||
      words.some(word => ['--version', '-version', '--help', '-h'].includes(word))

    if (isOffline) {
      return []
    }

    return [
      {
        program,
        profile: flagValue(words, '--profile') ?? env.AWS_PROFILE ?? null,
        region: flagValue(words, '--region') ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? null,
      },
    ]
  })
}

/** `aws sts get-caller-identity --output json`, read: the twelve-digit account. */
export function parseIdentity(json: string): string | null {
  const account = parseObject(json)?.Account

  return typeof account === 'string' && /^\d{12}$/.test(account) ? account : null
}

type Identity = { at: number; account: string | null; reason: string | null }

// Per profile, for a few minutes: a run of aws commands asks sts once.
const identities = new Map<string, Identity>()

async function readIdentity($: EngineInterface, profile: string | null): Promise<Identity> {
  const now = await $.clock.now()
  const kept = identities.get(profile ?? '')

  if (kept !== undefined && now - kept.at < (kept.account === null ? FAILURE_KEPT_MS : IDENTITY_KEPT_MS)) {
    return kept
  }
  const aws = await findTool($, 'aws')
  let found: Identity = { at: now, account: null, reason: 'the aws CLI was not found' }

  if (aws !== null) {
    const ran = await run(
      $,
      [aws, 'sts', 'get-caller-identity', '--output', 'json', ...(profile === null ? [] : ['--profile', profile])],
      { timeoutMs: 15_000 },
    )
    const account = ran.exitCode === 0 ? parseIdentity(ran.stdout) : null

    found = { at: now, account, reason: account === null ? (ran.reason ?? 'sts answered no account') : null }
  }
  identities.set(profile ?? '', found)

  return found
}

async function readRegion($: EngineInterface, target: AwsTarget, profile: string | null): Promise<string | null> {
  const fromEnv = (await $.env.get('AWS_REGION')) ?? (await $.env.get('AWS_DEFAULT_REGION'))

  if (target.region !== null || (fromEnv !== undefined && fromEnv !== '')) {
    return target.region ?? fromEnv ?? null
  }
  const aws = await findTool($, 'aws')

  if (aws === null) {
    return null
  }
  // Reads the local config file; no call to AWS.
  const ran = await run($, [aws, 'configure', 'get', 'region', ...(profile === null ? [] : ['--profile', profile])], {
    timeoutMs: 5_000,
  })
  const region = ran.stdout.trim()

  return ran.exitCode === 0 && region !== '' ? region : null
}

function readAllowed(stored: unknown): Record<string, string[]> {
  const lists: Record<string, string[]> = {}

  if (typeof stored === 'object' && stored !== null) {
    for (const [repo, accounts] of Object.entries(stored)) {
      if (Array.isArray(accounts)) {
        lists[repo] = accounts.filter((account): account is string => typeof account === 'string')
      }
    }
  }

  return lists
}

export async function allowedAccounts($: EngineInterface, repoRoot: string): Promise<string[]> {
  return readAllowed(await $.store.get(ALLOW_KEY))[repoRoot] ?? []
}

/** Adds or removes one account on a repository's allow-list, and answers the list as it then stands. */
export async function editAllowed(
  $: EngineInterface,
  repoRoot: string,
  account: string,
  change: 'allow' | 'remove',
): Promise<string[]> {
  const lists = readAllowed(await $.store.get(ALLOW_KEY))
  const without = (lists[repoRoot] ?? []).filter(kept => kept !== account)
  const next = change === 'allow' ? [...without, account] : without

  await $.store.set(ALLOW_KEY, { ...lists, [repoRoot]: next })

  return next
}

export const isAccountId = (text: string) => /^\d{12}$/.test(text)

export type AwsJudgement = { verdict: GuardVerdict; badge: DeckAwsBadge | null }

const RANK = { pass: 0, ask: 1, deny: 2 } as const

/**
 * Judges a command by the account its credentials belong to:
 * - not on the repository's allow-list: denied;
 * - no allow-list set for the repository: asked;
 * - the identity check itself failed: asked;
 * - on the allow-list: let through.
 */
export async function judgeAws($: EngineInterface, command: string, repoRoot: string): Promise<AwsJudgement> {
  const targets = awsTargets(command)
  let worst: AwsJudgement = { verdict: { kind: 'pass' }, badge: null }

  if (targets.length === 0) {
    return worst
  }
  const allowed = await allowedAccounts($, repoRoot)
  const fromEnv = await $.env.get('AWS_PROFILE')

  for (const target of targets) {
    const profile = target.profile ?? (fromEnv === undefined || fromEnv === '' ? null : fromEnv)
    const identity = await readIdentity($, profile)
    const region = await readRegion($, target, profile)
    const named = `profile ${profile ?? 'default'}${region === null ? '' : `, region ${region}`}`
    let verdict: GuardVerdict = { kind: 'pass' }

    if (identity.account === null) {
      verdict = {
        kind: 'ask',
        reason: `command-deck AWS guard: could not confirm the AWS account for this ${target.program} command (${named}): ${identity.reason ?? 'unknown'}. Check it is the account you mean.`,
      }
    } else if (allowed.length === 0) {
      verdict = {
        kind: 'ask',
        reason: `command-deck AWS guard: this ${target.program} command acts on AWS account ${identity.account} (${named}). This repository has no allow-list yet: /deck aws allow ${identity.account} stops this question.`,
      }
    } else if (!allowed.includes(identity.account)) {
      verdict = {
        kind: 'deny',
        reason: `command-deck AWS guard: this ${target.program} command would act on AWS account ${identity.account} (${named}), which is not on this repository's allow-list (${allowed.join(', ')}). The person can add it with /deck aws allow ${identity.account}.`,
      }
    }
    const judged: AwsJudgement = {
      verdict,
      badge: {
        profile,
        account: identity.account,
        region,
        verdict: verdict.kind === 'pass' ? 'allowed' : verdict.kind === 'ask' ? 'ask' : 'denied',
      },
    }

    if (worst.badge === null || RANK[verdict.kind] > RANK[worst.verdict.kind]) {
      worst = judged
    }
  }

  return worst
}

export function awsBadgeText(badge: DeckAwsBadge): string {
  const words = { allowed: 'on the allow-list', ask: 'asked first', denied: 'denied: not on the allow-list' } as const

  return `AWS ${badge.account ?? 'account unknown'} · ${badge.region ?? 'region -'} · profile ${badge.profile ?? 'default'} · ${words[badge.verdict]}`
}
