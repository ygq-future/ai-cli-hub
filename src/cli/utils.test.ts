import { describe, expect, test } from 'bun:test'
import { classifyShellCommand, isReadOnlyShellCommand } from './utils'

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
    'ls -la && cat README.md',
    'cat package.json; git status --short',
    'rg TODO src | head -20',
    'cat missing 2>&1 || echo "not found"',
    "docker inspect npm --format '{{json .Mounts}}' | python3 -m json.tool 2>&1",
    'docker exec npm nginx -v 2>&1 && docker exec npm node --version 2>&1',
    'docker exec npm npm --version 2>&1; docker exec pm2 --version 2>&1 || docker exec npm which pm2 2>&1 || echo "pm2 not in npm container"',
    'docker exec -u root npm sh -c "cat /etc/os-release && nginx -v"',
    'bash -c "git status --short && ls -la"',
    'cat < README.md',
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
    'Get-Content a.txt | Remove-Item',
    'ls; rm -rf x',
    'echo $(rm -rf x)',
    'env rm -rf x',
    'date --set tomorrow',
    'hostname changed-host',
    'ipconfig /release',
    'powershell -Command "Set-Content a.txt hello"',
    `node -e "require('fs').writeFileSync('x','y')"`,
    'ls | tee output.txt',
    'cat README.md 2> error.log',
    'docker exec npm rm -rf /data',
    'docker exec npm sh -c "cat /etc/os-release; rm -rf /data"',
    'docker run --rm alpine cat /etc/os-release',
    "docker inspect npm | python3 -c \"open('x', 'w').write('y')\"",
  ])('requires approval for mutating or composed command: %s', command => {
    expect(isReadOnlyShellCommand(command)).toBe(false)
  })

  test.each([
    ['rm -rf /tmp/x', 'mutating'],
    ['git branch -D old', 'mutating'],
    ['cat README.md > copy.txt', 'mutating'],
    ['docker exec npm unknown-tool --check', 'unknown'],
    ['$COMMAND --version', 'unknown'],
    ['echo $(cat README.md)', 'read-only'],
    ['echo $(rm -rf /tmp/x)', 'mutating'],
  ] as const)('classifies command effect: %s → %s', (command, effect) => {
    expect(classifyShellCommand(command)).toBe(effect)
  })
})
