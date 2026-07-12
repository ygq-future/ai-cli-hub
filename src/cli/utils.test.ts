import { describe, expect, test } from 'bun:test'
import { isReadOnlyShellCommand } from './utils'

describe('isReadOnlyShellCommand', () => {
  test.each([
    'ls -la /tmp',
    'dir /a',
    'cat README.md',
    'rg TODO src',
    'git status --short',
    'git -C /repo log -5',
    'git remote -v',
    'git reflog show',
    'git branch --list feature/*',
    'where.exe bun',
    'hostname --fqdn',
    'ipconfig /all',
    'Get-ChildItem -Force',
    'Get-Content $PROFILE',
    'Get-Process',
    'Test-Path C:\\temp',
    'powershell -NoProfile -Command "Get-ChildItem -Force"',
    'pwsh -Command "Select-String TODO README.md"',
    'cmd /c dir',
    'node --version',
  ])('allows read-only query: %s', command => {
    expect(isReadOnlyShellCommand(command)).toBe(true)
  })

  test.each([
    'rm -rf /tmp/x',
    'Remove-Item C:\\temp\\x -Recurse',
    'Set-Content a.txt hello',
    'git branch feature/new',
    'git branch -D feature/old',
    'git checkout main',
    'git reflog expire --all',
    'git diff --output=patch.txt',
    'git -c alias.x=!rm x',
    'echo hello > a.txt',
    'ls | grep txt',
    'Get-Content a.txt | Remove-Item',
    'ls; rm -rf x',
    'echo $(rm -rf x)',
    'env rm -rf x',
    'date --set tomorrow',
    'hostname changed-host',
    'ipconfig /release',
    'powershell -Command "Set-Content a.txt hello"',
    `node -e "require('fs').writeFileSync('x','y')"`,
  ])('requires approval for mutating or composed command: %s', command => {
    expect(isReadOnlyShellCommand(command)).toBe(false)
  })
})
