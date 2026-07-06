/**
 * 依赖矩阵铁律的机器化校验（见 CLAUDE.md §3 / docs/02-Architecture.md §2）。
 * 依赖只能指向抽象，不能指向具体实现。违反即 error。
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: '禁止循环依赖',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-no-impl',
      comment: 'core/ 禁止依赖具体实现（transport/cli/runtime/storage/approval/memory）',
      severity: 'error',
      from: { path: '^src/core' },
      to: { path: '^src/(transport|cli|runtime|storage|approval|memory)' },
    },
    {
      name: 'shared-is-leaf',
      comment: 'shared/ 是叶子，不依赖任何业务模块',
      severity: 'error',
      from: { path: '^src/shared' },
      to: {
        path: '^src/(core|event|config|transport|cli|runtime|approval|repository|storage|audit|memory)',
      },
    },
    {
      name: 'config-is-leaf',
      comment: 'config/ 是叶子（仅依赖 shared/第三方）',
      severity: 'error',
      from: { path: '^src/config' },
      to: { path: '^src/(core|event|transport|cli|runtime|approval|repository|storage|audit|memory)' },
    },
    {
      name: 'storage-no-business',
      comment: 'storage/ 不依赖任何业务模块',
      severity: 'error',
      from: { path: '^src/storage' },
      to: { path: '^src/(core|event|transport|cli|runtime|approval|repository|audit|memory|config)' },
    },
    {
      name: 'repository-scope',
      comment: 'repository/ 只依赖 storage/shared',
      severity: 'error',
      from: { path: '^src/repository' },
      to: { path: '^src/(core|transport|cli|runtime|approval|audit|memory)' },
    },
    {
      name: 'transport-scope',
      comment: 'transport/ 不依赖 core 内部与 storage',
      severity: 'error',
      from: { path: '^src/transport' },
      to: { path: '^src/(core|storage|audit)' },
    },
    {
      name: 'cli-scope',
      comment: 'cli/ 不依赖 transport 与 storage',
      severity: 'error',
      from: { path: '^src/cli' },
      to: { path: '^src/(transport|storage|audit)' },
    },
    {
      name: 'memory-scope',
      comment: 'memory/ 不依赖 core 与 transport',
      severity: 'error',
      from: { path: '^src/memory' },
      to: { path: '^src/(core|transport|audit)' },
    },
    {
      name: 'audit-scope',
      comment: 'audit/ 只依赖 event/repository/shared，不碰具体实现与 core',
      severity: 'error',
      from: { path: '^src/audit' },
      to: { path: '^src/(core|transport|cli|runtime|storage|approval|memory|config)' },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
  },
}
