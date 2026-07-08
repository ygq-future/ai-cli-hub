/**
 * MessageAggregator —— 消息聚合器（docs/03-Interface-Contracts.md §4）。
 *
 * 职责：把 Adapter 的输出字符串流（PTY 家族=高频字节剥 ANSI 后的碎片；
 * SDK 家族=离散 SDKMessage 转成的文本片段）缓冲/去抖/限流/超长拆分，
 * 聚合成「面向平台的消息」后发 `MessageGenerated` 事件。
 *
 * 设计（三个旋钮，见 AggregatorConfig）：
 *  - Buffer：按 conversationId 累积当前消息的**累计文本**。
 *  - Debounce（debounceMs）：最后一次 push 后静默 debounceMs 触发一次流式 emit(final=false)。
 *  - Throttle（minEditIntervalMs）：两次 emit 至少间隔 minEditIntervalMs，规避平台 editMessage 限流；
 *    被限流时挂起，冷却结束后补发（trailing-edge）。
 *  - 拆分（maxChunkChars）：累计文本达到上限即切出一条完整消息（final=true）并开启下一条；
 *    优先在换行处切，避免拦腰截断。
 *
 * 内容语义（决策 D12）：`MessageGenerated.content` 为**当前消息的累计全文**（非增量 delta）——
 * Transport 侧 editMessage 是「整条替换」，需要全文；final=true 表示该条消息定稿。
 *
 * 依赖矩阵：core/ 仅依赖 event/ 与 shared/（本模块只吃字符串，不感知 OutputDelta/字节，
 * 故不触碰 cli/；OutputDelta→字符串 的转换在 cli/format-output，接线在 Composition Root）。
 */
import type { ConversationId } from '../shared'
import type { EventBus } from '../event'

/** 聚合三旋钮（契约 §4）。 */
export interface AggregatorConfig {
  /** 静默多久触发一次流式 flush（ms） */
  debounceMs: number
  /** 最小 emit 间隔，规避平台限流（ms） */
  minEditIntervalMs: number
  /** 单条消息字符上限，超出拆分（如 TG 4096） */
  maxChunkChars: number
}

/** 默认值：SDK 家族输出离散，debounce 压力小；4096 对齐 Telegram 单条上限。 */
export const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfig = {
  debounceMs: 400,
  minEditIntervalMs: 1000,
  maxChunkChars: 4096,
}

export interface MessageAggregator {
  /** 喂入原始片段（来自 adapter 输出，经 format 转字符串）。 */
  push(conversationId: ConversationId, chunk: string): void
  /** 强制冲刷当前会话缓冲（会话结束/审批前/本轮 final）——发 final=true 并清空。 */
  flush(conversationId: ConversationId): void
  /** 强制冲刷所有会话缓冲；用于优雅关闭前定稿所有草稿。 */
  flushAll(): void
  /** 清理所有会话的定时器与状态（优雅关闭/测试收尾）。 */
  destroy(): void
}

type Timer = ReturnType<typeof setTimeout>

interface ConvState {
  /** 当前消息的累计文本（流式 emit 不清空；拆分/flush 才推进） */
  buffer: string
  /** buffer 自上次流式 emit 后是否有新内容 */
  dirty: boolean
  /** 是否已就当前消息发过 final=false（草稿在途，flush 时即便无新内容也需收尾） */
  draftOpen: boolean
  /** debounce 定时器 */
  debounce: Timer | null
  /** throttle 冷却定时器（非 null 即处于冷却期） */
  cooldown: Timer | null
  /** 冷却期内是否有待发的流式 emit */
  pending: boolean
}

/**
 * 计算拆分点：优先在 max 范围内最后一个换行处切（换行含入前段），
 * 换行过于靠前（< max/2）则硬切在 max，避免切出过短的首段。
 */
function splitIndex(s: string, max: number): number {
  if (s.length <= max) return s.length
  const nl = s.lastIndexOf('\n', max - 1)
  if (nl >= Math.floor(max / 2)) return nl + 1
  return max
}

export function createMessageAggregator(
  bus: EventBus,
  config: AggregatorConfig = DEFAULT_AGGREGATOR_CONFIG,
): MessageAggregator {
  const { debounceMs, minEditIntervalMs, maxChunkChars } = config
  const states = new Map<ConversationId, ConvState>()

  function getState(cid: ConversationId): ConvState {
    let st = states.get(cid)
    if (!st) {
      st = { buffer: '', dirty: false, draftOpen: false, debounce: null, cooldown: null, pending: false }
      states.set(cid, st)
    }
    return st
  }

  function emitMessage(cid: ConversationId, content: string, final: boolean) {
    bus.emit('MessageGenerated', { conversationId: cid, content, final })
  }

  function startCooldown(cid: ConversationId, st: ConvState) {
    if (st.cooldown !== null) clearTimeout(st.cooldown)
    if (minEditIntervalMs <= 0) {
      st.cooldown = null
      return
    }
    st.cooldown = setTimeout(() => {
      st.cooldown = null
      if (st.pending) {
        st.pending = false
        tryStreamingEmit(cid, st)
      }
    }, minEditIntervalMs)
  }

  /** 流式 emit（final=false）：受 throttle 门控，被限流则挂起待冷却后补发。 */
  function tryStreamingEmit(cid: ConversationId, st: ConvState) {
    if (!st.dirty || st.buffer.length === 0) return
    if (st.cooldown !== null) {
      st.pending = true
      return
    }
    emitMessage(cid, st.buffer, false)
    st.dirty = false
    st.draftOpen = true
    startCooldown(cid, st)
  }

  function scheduleDebounce(cid: ConversationId, st: ConvState) {
    if (st.debounce !== null) clearTimeout(st.debounce)
    st.debounce = setTimeout(() => {
      st.debounce = null
      tryStreamingEmit(cid, st)
    }, debounceMs)
  }

  return {
    push(cid, chunk) {
      if (!chunk) return
      const st = getState(cid)
      st.buffer += chunk

      // 达到上限即切出完整消息（final=true）并开启下一条
      while (st.buffer.length >= maxChunkChars) {
        const idx = splitIndex(st.buffer, maxChunkChars)
        const part = st.buffer.slice(0, idx)
        st.buffer = st.buffer.slice(idx)
        emitMessage(cid, part, true)
        st.draftOpen = false
        startCooldown(cid, st)
      }

      st.dirty = st.buffer.length > 0
      scheduleDebounce(cid, st)
    },

    flush(cid) {
      const st = states.get(cid)
      if (!st) return
      if (st.debounce !== null) {
        clearTimeout(st.debounce)
        st.debounce = null
      }
      if (st.cooldown !== null) {
        clearTimeout(st.cooldown)
        st.cooldown = null
      }

      // 收尾当前消息：有内容，或草稿在途（需告知 Transport 定稿）。
      // 无需在此兜底拆分：push 已保证 buffer 长度 < maxChunkChars。
      if (st.buffer.length > 0 || st.draftOpen) {
        emitMessage(cid, st.buffer, true)
      }
      states.delete(cid)
    },

    flushAll() {
      for (const cid of Array.from(states.keys())) {
        this.flush(cid)
      }
    },

    destroy() {
      for (const st of states.values()) {
        if (st.debounce !== null) clearTimeout(st.debounce)
        if (st.cooldown !== null) clearTimeout(st.cooldown)
      }
      states.clear()
    },
  }
}
