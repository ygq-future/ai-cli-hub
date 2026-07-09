/**
 * approval —— PTY 家族专属的审批 scraping 预留层。
 *
 * Claude 这类 SDK 家族经 Agent SDK `canUseTool` 结构化审批，不经过本目录。
 * 只有后续接入“无 SDK 的 CLI”时，才在这里实现 per-CLI ApprovalDetector，
 * 由 PTY adapter 从字节流中识别审批点并统一转成 ApprovalRequested。
 *
 * 契约见 docs/03-Interface-Contracts.md §3.3；决策见 D11。
 */
export {}
