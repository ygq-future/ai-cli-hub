import type { Unsubscribe } from '../shared'
import { OPERATION_RESULT_GUARDRAIL } from './constants'

export function buildSystemPromptAppend(systemLanguageHint?: string): string {
  return [systemLanguageHint, OPERATION_RESULT_GUARDRAIL].filter(Boolean).join('\n\n')
}

export function emitHandlers<T>(handlers: Array<(value: T) => void>, value: T): void {
  for (const handler of handlers) handler(value)
}

export function unsubscribeHandler<T>(handlers: T[], handler: T): Unsubscribe {
  return () => {
    const index = handlers.indexOf(handler)
    if (index >= 0) handlers.splice(index, 1)
  }
}
