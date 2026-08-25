import { describe, expect, test } from 'bun:test'
import { appendOutput, type TimelineItem } from './app'

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
