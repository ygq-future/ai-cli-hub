import { describe, expect, test } from 'bun:test'
import { summarizeMigrationSql } from './migration-report'

describe('migration report', () => {
  test('summarizes common Drizzle DDL and data operations', () => {
    const changes = summarizeMigrationSql(`
      ALTER TABLE "messages" ADD COLUMN "attachments" jsonb;
      --> statement-breakpoint
      ALTER TABLE "messages" ALTER COLUMN "attachments" SET NOT NULL;
      --> statement-breakpoint
      CREATE UNIQUE INDEX "uniq_messages" ON "messages" USING btree ("id");
      --> statement-breakpoint
      UPDATE "messages" SET "attachments" = '[]'::jsonb;
    `)

    expect(changes).toEqual([
      'messages：新增字段 attachments',
      'messages：修改字段 attachments',
      'messages：新增索引 uniq_messages',
      'messages：更新数据',
    ])
  })

  test('summarizes tables, types, constraints, and deletes', () => {
    const changes = summarizeMigrationSql(`
      CREATE TYPE "public"."state" AS ENUM('open');
      --> statement-breakpoint
      CREATE TABLE "jobs" ("id" text PRIMARY KEY);
      --> statement-breakpoint
      ALTER TABLE "jobs" ADD CONSTRAINT "jobs_id_fk" FOREIGN KEY ("id") REFERENCES "users"("id");
      --> statement-breakpoint
      DELETE FROM "jobs";
      --> statement-breakpoint
      DROP TABLE "jobs";
    `)

    expect(changes).toEqual([
      '新增类型 public.state',
      '新增表 jobs',
      'jobs：新增约束 jobs_id_fk',
      'jobs：清理数据',
      '删除表 jobs',
    ])
  })
})
