/** SDK 家族 CLI Adapter 共用的输出与行为常量。 */
export const OPERATION_RESULT_GUARDRAIL = [
  'Remote operation guardrail:',
  '- When the user asks you to create, modify, delete, move, or inspect local files or run shell commands, use the available tools to actually do or verify it.',
  '- Never claim a filesystem or shell operation succeeded unless you received a successful tool result in this turn.',
  '- If a required tool was not called, was denied, or failed, say the operation was not completed.',
].join('\n')

export const EMPTY_VISIBLE_RESULT_MESSAGE = '本轮没有生成可见回复，请重试。'
