import { loadConfig } from '../src/config'
import { Telegraf } from 'telegraf'

const config = loadConfig()
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN)

console.log('检查 Telegram Bot 连通性...')
const me = await bot.telegram.getMe()
console.log('Bot 在线:', me.username, '| ID:', me.id)

console.log('\n重要提示：')
console.log('- transport.whitelistUserIds 需要填你的个人 Telegram 数字 ID，不是 bot token')
console.log('- 找你的 user ID：私聊 @userinfobot 或 @get_id_bot，会返回一个数字')
console.log('- 把这个数字填进 settings.json 的 transport.whitelistUserIds 数组')
