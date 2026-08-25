import { describe, expect, test } from 'bun:test'
import { getFeedMountScrollTop, getFeedScrollState, shouldScrollToLatest } from './feed-scroll'

describe('Web 聊天滚动策略', () => {
  test('首屏历史加载完成时强制定位最新消息', () => {
    expect(
      shouldScrollToLatest({
        historyHydrated: false,
        pinnedToLatest: false,
        prepending: false,
      }),
    ).toBe(true)
  })

  test('用户上滑后保留当前位置并显示回到底部按钮', () => {
    expect(
      shouldScrollToLatest({
        historyHydrated: true,
        pinnedToLatest: false,
        prepending: false,
      }),
    ).toBe(false)
    expect(getFeedScrollState({ scrollTop: 120, clientHeight: 400, scrollHeight: 1200 })).toEqual({
      pinnedToLatest: false,
      showJumpButton: true,
    })
  })

  test('接近底部时隐藏按钮，加载更早消息时保持阅读位置', () => {
    expect(getFeedScrollState({ scrollTop: 760, clientHeight: 400, scrollHeight: 1200 })).toEqual({
      pinnedToLatest: true,
      showJumpButton: false,
    })
    expect(
      shouldScrollToLatest({
        historyHydrated: true,
        pinnedToLatest: true,
        prepending: true,
      }),
    ).toBe(false)
  })

  test('首次挂载定位底部，Tab 返回恢复已保存的位置', () => {
    expect(
      getFeedMountScrollTop({
        historyHydrated: true,
        savedScrollTop: null,
        clientHeight: 400,
        scrollHeight: 1400,
      }),
    ).toBe(1000)
    expect(
      getFeedMountScrollTop({
        historyHydrated: true,
        savedScrollTop: 0,
        clientHeight: 400,
        scrollHeight: 1400,
      }),
    ).toBe(0)
    expect(
      getFeedMountScrollTop({
        historyHydrated: true,
        savedScrollTop: 260,
        clientHeight: 400,
        scrollHeight: 1400,
      }),
    ).toBe(260)
  })
})
