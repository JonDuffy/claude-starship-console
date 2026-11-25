// A shell command line read just far enough to tell which programs it
// starts: the two guards judge by the program and its first arguments. This
// is no shell parser: quotes, substitutions and aliases are not followed, so
// a command built to hide its program is not seen.

import { basename } from './format'

export type Invocation = {
  /** `NAME=value` words written before the program. */
  env: Record<string, string>
  /** The program's name, wrappers such as `npx` taken off, then its arguments. */
  words: string[]
}

const PREFIXES = new Set(['sudo', 'time', 'command', 'nohup', 'exec', 'env'])
const RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
const PACKAGE_MANAGERS = new Set(['pnpm', 'yarn', 'npm', 'bun'])
const RUN_WORDS = new Set(['exec', 'dlx', 'x'])
// A package manager runs a project's own program by its bare name.
const DIRECT_PROGRAMS = new Set(['aws', 'cdk', 'sst', 'terraform', 'next'])

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

function unquote(word: string): string {
  return word.replace(/^(['"])(.*)\1$/, '$2')
}

function dropFlags(words: string[]): string[] {
  let rest = words

  while (rest[0]?.startsWith('-') === true) {
    rest = rest.slice(1)
  }

  return rest
}

function readInvocation(segment: string): Invocation | null {
  let words = segment.trim().split(/\s+/).filter(word => word !== '').map(unquote)
  const env: Record<string, string> = {}

  for (;;) {
    const first = words[0]
    const assignment = first === undefined ? null : ASSIGNMENT.exec(first)

    if (first === undefined) {
      return null
    }
    if (assignment !== null) {
      env[assignment[1] as string] = unquote(assignment[2] as string)
      words = words.slice(1)
    } else if (PREFIXES.has(first)) {
      words = dropFlags(words.slice(1))
    } else if (RUNNERS.has(first)) {
      words = dropFlags(words.slice(1))
    } else if (PACKAGE_MANAGERS.has(first) && RUN_WORDS.has(words[1] ?? '')) {
      words = dropFlags(words.slice(2))
    } else if (PACKAGE_MANAGERS.has(first) && DIRECT_PROGRAMS.has(words[1] ?? '')) {
      words = words.slice(1)
    } else {
      return { env, words: [basename(first), ...words.slice(1)] }
    }
  }
}

/** Each program a command line starts, in order: split at `&&`, `||`, `;`, `|`, `&` and line ends. */
export function readInvocations(command: string): Invocation[] {
  return command
    .split(/&&|\|\||[;|&\n]/)
    .map(readInvocation)
    .filter(invocation => invocation !== null)
}

/** The value of `--name value` or `--name=value` among a program's arguments. */
export function flagValue(words: readonly string[], name: string): string | null {
  for (const [index, word] of words.entries()) {
    if (word === name) {
      return words[index + 1] ?? null
    }
    if (word.startsWith(`${name}=`)) {
      return word.slice(name.length + 1)
    }
  }

  return null
}
