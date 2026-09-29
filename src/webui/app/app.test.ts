import { describe, expect, test } from 'bun:test'
import {
  appendOutput,
  formatApprovalDetail,
  resolveNextAgentActivity,
  upsertApproval,
  type Approval,
  type TimelineItem,
} from './app'

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
    expect(timeline.filter(item => item.type === 'approval')).toHaveLength(1)
  })

  test('流式进行中插入新审批时，始终保持流式消息在最下方', () => {
    // 1. 助手开始流式输出第一段
    let timeline: TimelineItem[] = appendOutput([], '正在检查系统环境...', false)
    expect(timeline).toHaveLength(1)
    expect(timeline[0]?.type).toBe('chat')

    // 2. 产生第一个审批（如 bash 权限）
    const approval1: Approval = {
      type: 'approval',
      id: 'approval:1',
      createdAt: 100,
      approvalId: 'approval-1',
      conversationId: 'conv-1',
      command: 'docker compose down',
      detail: '{\n  "permission": "bash"\n}',
      status: 'pending',
      operator: null,
      automatic: false,
    }
    timeline = upsertApproval(timeline, approval1)

    // 审批卡应该在流式消息上方，流式消息在最末尾
    expect(timeline).toHaveLength(2)
    expect(timeline[0]).toEqual(approval1)
    expect(timeline[1]?.type).toBe('chat')
    expect(timeline[1]).toMatchObject({ content: '正在检查系统环境...', streaming: true })

    // 3. 助手继续流式输出第二段
    timeline = appendOutput(timeline, '正在检查系统环境...\n正在执行停止...', false)
    expect(timeline).toHaveLength(2)
    expect(timeline[1]).toMatchObject({ content: '正在检查系统环境...\n正在执行停止...', streaming: true })

    // 4. 产生第二个审批（如第二个命令）
    const approval2: Approval = {
      type: 'approval',
      id: 'approval:2',
      createdAt: 200,
      approvalId: 'approval-2',
      conversationId: 'conv-1',
      command: 'docker compose up -d',
      detail: '{\n  "permission": "bash"\n}',
      status: 'pending',
      operator: null,
      automatic: false,
    }
    timeline = upsertApproval(timeline, approval2)

    // 两个审批按顺序排在前面，流式消息仍在最末尾
    expect(timeline).toHaveLength(3)
    expect(timeline[0]).toEqual(approval1)
    expect(timeline[1]).toEqual(approval2)
    expect(timeline[2]?.type).toBe('chat')
    expect(timeline[2]).toMatchObject({ streaming: true })

    // 5. 审批1决议更新（保持在原位置，不挪动）
    timeline = upsertApproval(timeline, { ...approval1, status: 'approved', operator: 'auto:web-admin' })
    expect(timeline[0]).toMatchObject({ approvalId: 'approval-1', status: 'approved' })
    expect(timeline[1]).toMatchObject({ approvalId: 'approval-2', status: 'pending' })
    expect(timeline[2]?.type).toBe('chat')

    // 6. 最终流式结束
    timeline = appendOutput(timeline, '全部命令执行完成。', true)
    expect(timeline).toHaveLength(3)
    expect(timeline[2]).toMatchObject({ content: '全部命令执行完成。', streaming: false })
  })

  test('统一格式化审批明细为 prettyJSON', () => {
    const compact = '{"tool":{"callID":"bash-1"},"patterns":["docker compose down"]}'
    const expected = JSON.stringify(JSON.parse(compact), null, 2)
    expect(formatApprovalDetail(compact)).toBe(expected)

    // 已解析的 Object 同样转为 prettyJSON
    const obj = { tool: { callID: 'bash-1' }, patterns: ['docker compose down'] }
    expect(formatApprovalDetail(obj)).toBe(expected)

    // 非 JSON 字符串原样返回
    expect(formatApprovalDetail('plain text command detail')).toBe('plain text command detail')
    expect(formatApprovalDetail(null)).toBe('')
    expect(formatApprovalDetail('')).toBe('')
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
