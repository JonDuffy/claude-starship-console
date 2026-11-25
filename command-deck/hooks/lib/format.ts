// Pure text helpers: how sizes, times, money and paths are written. Nothing
// here reaches outside the module.

export function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').at(-1) ?? path
}

/** The first line that says something, cut to a short reason. */
export function shortReason(text: string, limit = 90): string | null {
  const line = text
    .split('\n')
    .map(part => part.trim())
    .find(part => part !== '')

  if (line === undefined) {
    return null
  }

  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

export function cut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Kibibytes as du counts them, written in decimal units as Finder does. */
export function formatKb(kb: number): string {
  const bytes = kb * 1024

  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(1)} GB`
  }
  if (bytes >= 1e6) {
    return `${Math.round(bytes / 1e6)} MB`
  }

  return `${Math.round(bytes / 1e3)} kB`
}

/** A size's change since the scan before, signed. */
export function formatGrowthKb(kb: number): string {
  if (kb === 0) {
    return 'no change'
  }

  return `${kb > 0 ? '+' : '-'}${formatKb(Math.abs(kb))}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`
  }
  const seconds = ms / 1000

  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) {
    return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
  }

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** A cost estimate in US dollars. The caller says it is an estimate. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`
}

/** `date +%z` output (`+0100`, `-0530`) as minutes east of UTC. */
export function parseUtcOffset(text: string): number | null {
  const found = /^([+-])(\d\d)(\d\d)$/.exec(text.trim())

  if (found === null) {
    return null
  }
  const minutes = Number(found[2]) * 60 + Number(found[3])

  return found[1] === '-' ? -minutes : minutes
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

// The module's own clock is UTC whatever the Mac's zone, so local time is
// worked out from the offset the Mac reported. With no offset, the time is
// written as UTC and says so.
function shifted(ms: number, offsetMinutes: number | null): Date {
  return new Date(ms + (offsetMinutes ?? 0) * 60_000)
}

export function clockTime(ms: number, offsetMinutes: number | null): string {
  const local = shifted(ms, offsetMinutes)
  const time = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`

  return offsetMinutes === null ? `${time} UTC` : time
}

/** A time further off than a day carries its weekday. */
export function clockTimeFrom(ms: number, now: number, offsetMinutes: number | null): string {
  const time = clockTime(ms, offsetMinutes)

  if (Math.abs(ms - now) < 24 * 3_600_000) {
    return time
  }

  return `${WEEKDAYS[shifted(ms, offsetMinutes).getUTCDay()]} ${time}`
}

/** How long ago a moment was, in round words. */
export function formatAgo(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000)

  if (minutes < 1) {
    return 'just now'
  }
  if (minutes < 60) {
    return `${minutes} min ago`
  }
  const hours = Math.floor(minutes / 60)

  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} days ago`
}

/** Text safe to use as one file name. */
export function fileSlug(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-150)
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * A table's entry for a key that came from outside (a command line, GitHub, a
 * shared file): only the table's own entries answer, never a name every
 * object has, such as `constructor`.
 */
export function lookUp<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/** A JSON text read as a plain object, or null when it is anything else. */
export function parseObject(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json)

    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
