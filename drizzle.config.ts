/**
 * drizzle-kit 配置 —— 迁移生成/应用（docs/04-Data-Model.md §8）。
 * 仅供构建期 CLI（db:generate / db:migrate），非运行时模块，故此处允许读 env。
 * generate 离线工作（无需连库）；migrate 使用 dbCredentials.url。
 */
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/storage/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // 迁移 0001 需前置 `CREATE EXTENSION vector`（memories.embedding 依赖），
  // drizzle-kit 不为 customType 自动建扩展，生成后手工补入迁移文件顶部。
})
