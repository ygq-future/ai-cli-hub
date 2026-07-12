/**
 * 本地测试工具：关闭白名单用户在默认 cwd/claude 的遗留活跃会话。
 * 用途：本机重启服务后，进程内 convChat 映射丢失、旧会话被复用（不发 SessionCreated）导致
 * 出站无法路由；跑本脚本清掉旧会话，下条消息即新建会话、映射重建。非生产逻辑。
 */
import { createDb } from '../src/storage'
import { createRepositories } from '../src/repository'
import { loadConfig } from '../src/config'
import type { ConversationId } from '../src/shared'

const config = loadConfig()
const repos = createRepositories(createDb(config.DATABASE_URL))
const userId = config.WHITELIST_USER_IDS[0]!

const active = await repos.conversations.findLatestOpen('telegram', userId, 'claude')
if (active) {
  await repos.conversations.updateStatus(active.id as ConversationId, 'closed')
  console.log('closed stale conversation:', active.id)
} else {
  console.log('no active conversation for', userId)
}
