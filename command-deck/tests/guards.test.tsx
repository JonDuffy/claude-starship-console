// Features 6 and 7, the guards: what a Bash command is answered before it
// runs. `$.tool.check` asks the mod the question the engine asks for a real
// call, and runs nothing.

import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { COMMAND, failed, ok, REPO, START, world } from './world'

const GB = 1e9 / 1024
const ALLOWED = { 'aws.allow': { [REPO]: ['111111111111'] } }

const check = ($: Engine, command: string) => $.tool.check({ tool: 'Bash', input: { command } })
const identity = (account: string) => ok(JSON.stringify({ UserId: 'AIDAEXAMPLE', Account: account, Arn: `arn:aws:iam::${account}:user/x` }))
const sts = (answer: ReturnType<typeof ok>) => (argv: readonly string[]) => (argv.includes('get-caller-identity') ? answer : undefined)

test('the disk guard asks before a heavy command under 20 GB free, and only then', async ($, on) => {
  const w = world(on)

  await $.session.start(START)
  await w.clock.settle()
  w.freeKib = 75 * GB
  expect((await check($, 'pnpm install')).decision).toBe('allow')

  // The free-space reading is kept for a minute, then read again.
  w.freeKib = 14.2 * GB
  await w.clock.advance(61_000)
  const asked = await check($, 'cd app && pnpm install --frozen-lockfile')

  expect(asked.decision).toBe('ask')
  expect(asked.reason).toContain('14.2 GB free, under 20 GB')
  expect(asked.reason).toContain('"pnpm install"')
  expect((await check($, 'docker build -t home .')).decision).toBe('ask')
  expect((await check($, 'npx next build')).decision).toBe('ask')
  expect((await check($, 'cdk synth')).decision).toBe('ask')
  // Light commands are not asked about, however little space is free.
  expect((await check($, 'pnpm test')).decision).toBe('allow')
  expect((await check($, 'ls -la')).decision).toBe('allow')
})

test('free space that cannot be read stops nothing', async ($, on) => {
  const w = world(on)

  w.answers.push(argv => (argv[0] === '/bin/df' ? failed('df: /Users/test: No such file or directory') : undefined))
  await $.session.start(START)
  await w.clock.settle()
  expect((await check($, 'npm install')).decision).toBe('allow')
})

test('the AWS guard asks when the repository has no allow-list, naming the account', async ($, on) => {
  const w = world(on)

  w.answers.push(sts(identity('222222222222')))
  await $.session.start(START)
  await w.clock.settle()
  const asked = await check($, 'aws s3 ls --profile sandbox-admin --region eu-west-2')

  expect(asked.decision).toBe('ask')
  expect(asked.reason).toContain('AWS account 222222222222 (profile sandbox-admin, region eu-west-2)')
  expect(asked.reason).toContain('/deck aws allow 222222222222')
  // The identity was read with the profile the command named, and nothing else was asked of AWS.
  expect(w.runs.filter(run => run.includes('sts'))).toEqual([
    ['aws', 'sts', 'get-caller-identity', '--output', 'json', '--profile', 'sandbox-admin'],
  ])
  expect(w.runs.filter(run => run[0] === 'aws' && !run.includes('sts') && !run.includes('--version') && !run.includes('configure'))).toEqual([])
})

test('an account on the allow-list is let through; one that is not is denied', async ($, on) => {
  const w = world(on, ALLOWED)
  let account = '111111111111'

  w.answers.push(argv => (argv.includes('get-caller-identity') ? identity(account) : undefined))
  w.answers.push(argv => (argv.includes('configure') ? ok('eu-west-2\n') : undefined))
  await $.session.start(START)
  await w.clock.settle()
  expect((await check($, 'AWS_PROFILE=dev-admin npx cdk deploy --all')).decision).toBe('allow')

  // The same profile is not asked of sts again for five minutes.
  expect((await check($, 'AWS_PROFILE=dev-admin npx cdk diff')).decision).toBe('allow')
  expect(w.count('sts')).toBe(1)

  account = '999999999999'
  const denied = await check($, 'terraform apply --profile other')

  expect(denied.decision).toBe('deny')
  expect(denied.reason).toContain('AWS account 999999999999 (profile other, region eu-west-2), which is not on this repository\'s allow-list (111111111111)')

  // After five minutes the first profile is read again, and its new account is denied too.
  await w.clock.advance(5 * 60_000)
  expect((await check($, 'AWS_PROFILE=dev-admin npx cdk deploy')).decision).toBe('deny')
})

test('an identity check that fails asks, and never denies or allows by itself', async ($, on) => {
  const w = world(on, ALLOWED)

  w.answers.push(sts(failed('Error when retrieving token from sso: Token has expired and refresh failed', 255)))
  await $.session.start(START)
  await w.clock.settle()
  const asked = await check($, 'aws s3 ls')

  expect(asked.decision).toBe('ask')
  expect(asked.reason).toContain('could not confirm the AWS account')
  expect(asked.reason).toContain('Token has expired')
})

test('an AWS command without the aws CLI on this Mac is asked about', async ($, on) => {
  const w = world(on, ALLOWED)

  w.answers.push(argv => (/(^|\/)aws$/.test(argv[0] ?? '') ? failed('command not found', 127) : undefined))
  await $.session.start(START)
  await w.clock.settle()
  const asked = await check($, 'terraform apply')

  expect(asked.decision).toBe('ask')
  expect(asked.reason).toContain('the aws CLI was not found')
})

test('commands that work offline are let through with no call to AWS', async ($, on) => {
  const w = world(on, ALLOWED)

  await $.session.start(START)
  await w.clock.settle()
  for (const command of ['cdk synth', 'aws configure list', 'terraform fmt -check', 'aws --version', 'git push']) {
    expect((await check($, command)).decision, command).toBe('allow')
  }
  expect(w.count('sts')).toBe(0)
})

test('a guard only tightens: what the engine refuses stays refused', async ($, on) => {
  const w = world(on)

  w.answers.push(sts(identity('222222222222')))
  w.engineDecision = 'deny'
  await $.session.start(START)
  await w.clock.settle()
  // The guard alone would ask (no allow-list); the engine's deny beneath stands.
  expect((await check($, 'aws s3 rm s3://bucket --recursive')).decision).toBe('deny')
  expect((await check($, 'ls')).decision).toBe('deny')
})

test('a guard that breaks asks about the command it guards, and lets every other command through', async ($, on) => {
  // The store is where the allow-list is kept: here it cannot be read at all.
  on('store.get', { key: 'aws.allow' }, () => ({ deny: 'the store is broken' }))
  const w = world(on)

  await $.session.start(START)
  await w.clock.settle()
  const asked = await check($, 'aws s3 ls')

  expect(asked.decision).toBe('ask')
  expect(asked.reason).toContain('a guard on this command failed')
  expect((await check($, 'ls')).decision).toBe('allow')
})

test('a low disk and an unknown account ask once, with both reasons', async ($, on) => {
  const w = world(on)

  w.freeKib = 5 * GB
  w.answers.push(sts(identity('222222222222')))
  await $.session.start(START)
  await w.clock.settle()
  // `cdk synth` is heavy and offline; `cdk deploy` reaches AWS.
  const asked = await check($, 'cdk synth && cdk deploy')

  expect(asked.decision).toBe('ask')
  expect(asked.reason).toContain('AWS account 222222222222')
  expect(asked.reason).toContain('Also: command-deck disk guard: 5.0 GB free')
})

test('/deck aws allow, list and remove edit this repository\'s allow-list', async ($, on) => {
  const w = world(on)
  const deck = async (args: string) => (await $.command.run({ ...COMMAND, command: 'deck', args })).text ?? ''

  w.answers.push(sts(identity('222222222222')))
  await $.session.start(START)
  await w.clock.settle()
  expect(await deck('aws list')).toContain(`No AWS allow-list for ${REPO}`)
  expect(await deck('aws allow 12345')).toStartWith('Usage: /deck aws allow')
  expect(await deck('aws allow 222222222222')).toBe(`Allowed 222222222222 for ${REPO}. The list is now: 222222222222.`)
  expect(await deck('aws list')).toBe(`AWS accounts allowed for ${REPO}: 222222222222. Any other account is denied.`)
  expect((await check($, 'aws s3 ls')).decision).toBe('allow')

  expect(await deck('aws remove 222222222222')).toContain('The list is now: empty, so the guard asks each time.')
  expect((await check($, 'aws s3 ls')).decision).toBe('ask')

  // Only the person's own typed command edits the list: one a channel or a plugin sent does not.
  for (const origin of [{ kind: 'channel', server: 'slack' }, { kind: 'plugin', name: 'other' }, { kind: 'task-notification' }] as const) {
    const sent = await $.command.run({ ...COMMAND, origin, command: 'deck', args: 'aws allow 222222222222' })

    expect(sent.text).toContain('The AWS allow-list was not changed')
  }
  expect(await deck('aws list')).toContain('No AWS allow-list')
})

test('the Bash row of an AWS command shows the account, region and verdict', async ($, on) => {
  const w = world(on, ALLOWED)
  const props = { tool_use_id: 'tu-aws', tool: 'Bash', input: { command: 'aws s3 ls --region eu-west-1' }, isRunning: true, isErrored: false, isInterrupted: false }

  w.answers.push(sts(identity('111111111111')))
  await $.session.start(START)
  await w.clock.settle()
  // A real call carries its id, which is how the row finds its badge.
  await $.tool.call({ tool: 'Bash', command: 'aws s3 ls --region eu-west-1', tool_use_id: 'tu-aws' })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ plugin: 'command-deck', surface, component: 'ToolUse', requestId: 'tu-aws', props })

    expect((await ui.find({ type: 'Text', text: /^AWS / }))?.text).toBe('AWS 111111111111 · eu-west-1 · profile default · on the allow-list')
    expect(await ui.keepsBeneath()).toBe(true)
    await ui.unmount()
  }
})
