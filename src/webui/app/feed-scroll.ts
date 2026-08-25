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
}): boolean {
  if (input.prepending) return false
  return !input.historyHydrated || input.pinnedToLatest
}
