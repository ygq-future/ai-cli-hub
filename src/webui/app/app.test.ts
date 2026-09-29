import { describe, expect, test } from 'bun:test'
import { appendOutput, resolveNextAgentActivity, type TimelineItem } from './app'

describe('Web 流式时间线', () => {
  test('审批卡插入期间仍更新同一个助手流式消息', () => {
    let timeline: TimelineItem[] = appendOutput([], '第一段', false)
    timeline = [
      ...timeline,
      {
        type: 'approval',
        id: 'approval:1',
        createdAt: 2,
        approvalId: 'approval-1',
        conversationId: 'conversation-1',
        command: 'rm -rf /tmp/example',
        detail: '{}',
        status: 'pending',
        operator: null,
        automatic: false,
      },
    ]

    timeline = appendOutput(timeline, '第二段', false)
    timeline = appendOutput(timeline, '最终内容', true)

    const assistants = timeline.filter(item => item.type === 'chat' && item.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({ content: '最终内容', streaming: false })
    expect(timeline.filter(item => item.type === 'approval')).toHaveLength(1)
  })
})

describe('Agent 实时动作状态机', () => {
  test('thinking 事件进入思考状态', () => {
    const next = resolveNextAgentActivity(null, { type: 'agent_activity', state: 'thinking' })
    expect(next).toEqual({ state: 'thinking', detail: undefined })
  })

  test('executing 事件带 detail 更新为执行命令状态', () => {
    const next = resolveNextAgentActivity(
      { state: 'thinking' },
      { type: 'agent_activity', state: 'executing', detail: 'git diff' },
    )
    expect(next).toEqual({ state: 'executing', detail: 'git diff' })
  })

  test('idle 事件清空当前动作状态', () => {
    const next = resolveNextAgentActivity(
      { state: 'executing', detail: 'git diff' },
      {
        type: 'agent_activity',
        state: 'idle',
      },
    )
    expect(next).toBeNull()
  })

  test('文本开始流出或结束回复时清空动作指示器', () => {
    expect(resolveNextAgentActivity({ state: 'thinking' }, { type: 'output', final: false })).toBeNull()
    expect(resolveNextAgentActivity({ state: 'executing' }, { type: 'output', final: true })).toBeNull()
  })

  test('审批或错误到达时重置动作状态', () => {
    expect(resolveNextAgentActivity({ state: 'executing' }, { type: 'approval' })).toBeNull()
    expect(resolveNextAgentActivity({ state: 'thinking' }, { type: 'error' })).toBeNull()
  })
})
