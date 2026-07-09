import { describe, expect, test } from 'bun:test'

import { migrateEnvText, parseEnvValues } from './env-migrate'

describe('parseEnvValues', () => {
  test('parses active dotenv key-values and ignores comments', () => {
    expect(parseEnvValues(['# COMMENTED=value', 'FOO=bar', ' export BAR = baz # local note', ''].join('\n'))).toEqual(
      new Map([
        ['FOO', 'bar'],
        ['BAR', 'baz # local note'],
      ]),
    )
  })

  test('keeps quoted multiline values as one env value', () => {
    expect(parseEnvValues(['AGENT_DESCRIPTION="line one', 'line two"', 'NEXT=value'].join('\n'))).toEqual(
      new Map([
        ['AGENT_DESCRIPTION', '"line one\nline two"'],
        ['NEXT', 'value'],
      ]),
    )
  })
})

describe('migrateEnvText', () => {
  test('creates .env from .env.example when there is no existing file', () => {
    const example = ['# section', 'FOO=example', '', 'BAR=default'].join('\n')

    expect(migrateEnvText(example).text).toBe(`${example}\n`)
    expect(migrateEnvText(example).stats).toEqual({
      preserved: 0,
      added: 2,
      extra: 0,
    })
  })

  test('keeps existing configured values while replacing comments and order', () => {
    const example = ['# new comments', 'FOO=example', 'BAR=default'].join('\n')
    const existing = ['BAR=local-bar', '# old comment', 'FOO=local-foo'].join('\n')

    expect(migrateEnvText(example, existing).text).toBe(
      ['# new comments', 'FOO=local-foo', 'BAR=local-bar', ''].join('\n'),
    )
    expect(migrateEnvText(example, existing).stats).toEqual({
      preserved: 2,
      added: 0,
      extra: 0,
    })
  })

  test('keeps extra local keys at the end instead of dropping them', () => {
    const example = ['# template', 'FOO=example'].join('\n')
    const existing = ['FOO=local', 'LOCAL_ONLY=secret'].join('\n')

    expect(migrateEnvText(example, existing).text).toBe(
      ['# template', 'FOO=local', '', '# ── 本地额外配置（未出现在 .env.example）──', 'LOCAL_ONLY=secret', ''].join(
        '\n',
      ),
    )
    expect(migrateEnvText(example, existing).stats).toEqual({
      preserved: 1,
      added: 0,
      extra: 1,
    })
  })

  test('does not activate commented optional template keys', () => {
    const example = ['# UPDATE_WORKDIR=/srv/ai-cli-hub', 'FOO=example'].join('\n')
    const existing = ['UPDATE_WORKDIR=/home/app', 'FOO=local'].join('\n')

    expect(migrateEnvText(example, existing).text).toBe(
      [
        '# UPDATE_WORKDIR=/srv/ai-cli-hub',
        'FOO=local',
        '',
        '# ── 本地额外配置（未出现在 .env.example）──',
        'UPDATE_WORKDIR=/home/app',
        '',
      ].join('\n'),
    )
  })

  test('preserves existing quoted multiline values when refreshing from template', () => {
    const example = ['# agent prompt', 'AGENT_DESCRIPTION="example"', 'RECENT_CONTEXT_LIMIT=10'].join('\n')
    const existing = [
      'AGENT_DESCRIPTION="你是运行在个人 VPS 上的 AI CLI 远程会话管理助手，负责协助用户安全、高效地管理本机项目、命令执行、审批和长期记忆。',
      '不要使用任何除了当前环境下其他会话的污染信息，不要使用任何skill，不要使用任何插件，只关注当前会话用户的指令和上下文信息。"',
      'RECENT_CONTEXT_LIMIT=20',
    ].join('\n')

    expect(migrateEnvText(example, existing).text).toBe(
      [
        '# agent prompt',
        'AGENT_DESCRIPTION="你是运行在个人 VPS 上的 AI CLI 远程会话管理助手，负责协助用户安全、高效地管理本机项目、命令执行、审批和长期记忆。',
        '不要使用任何除了当前环境下其他会话的污染信息，不要使用任何skill，不要使用任何插件，只关注当前会话用户的指令和上下文信息。"',
        'RECENT_CONTEXT_LIMIT=20',
        '',
      ].join('\n'),
    )
  })
})
