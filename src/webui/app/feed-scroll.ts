export const FEED_BOTTOM_THRESHOLD = 80

export interface FeedScrollMetrics {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

export interface FeedScrollState {
  pinnedToLatest: boolean
  showJumpButton: boolean
}

export function getFeedMountScrollTop(input: {
  historyHydrated: boolean
  savedScrollTop: number | null
  clientHeight: number
  scrollHeight: number
}): number | null {
  if (!input.historyHydrated) return null
  const maximumScrollTop = Math.max(0, input.scrollHeight - input.clientHeight)
  if (input.savedScrollTop === null) return maximumScrollTop
  return Math.min(Math.max(0, input.savedScrollTop), maximumScrollTop)
}

export function getFeedScrollState(metrics: FeedScrollMetrics, threshold = FEED_BOTTOM_THRESHOLD): FeedScrollState {
  const distanceFromLatest = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop
  const pinnedToLatest = distanceFromLatest <= threshold
  return {
    pinnedToLatest,
    showJumpButton: !pinnedToLatest && metrics.scrollHeight > metrics.clientHeight,
  }
}

export function shouldScrollToLatest(input: {
  historyHydrated: boolean
  pinnedToLatest: boolean
  prepending: boolean
  force?: boolean
}): boolean {
  if (input.prepending) return false
  if (input.force) return true
  return !input.historyHydrated || input.pinnedToLatest
}

export function shouldReleaseForcedScroll(input: { force: boolean; finalReply: boolean }): boolean {
  return input.force && input.finalReply
}
