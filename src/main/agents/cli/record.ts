import type { AgentEvent } from '../../../shared/events'

/** Loose JSON readers shared by the CLI stream parsers: wrong-typed fields read as absent. */
export type Rec = Record<string, unknown>

export function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function str(source: Rec, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

export function num(source: Rec, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function sub(source: Rec, key: string): Rec | undefined {
  const value = source[key]
  return isRec(value) ? value : undefined
}

export function list(source: Rec, key: string): Rec[] {
  const value = source[key]
  return Array.isArray(value) ? value.filter(isRec) : []
}

/** One JSONL line as an object, or undefined for blank, malformed or non-object lines. */
export function tryParseRecord(line: string): Rec | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRec(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function errorEvent(turnId: string, code: string, message: string, retryable: boolean): AgentEvent {
  return { type: 'error', turnId, code, message, retryable }
}
