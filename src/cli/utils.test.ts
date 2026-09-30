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
    'cd /home/ubuntu/softs/webhook/webhook-backend && git remote -v && echo "---BRANCH---" && git branch -a && echo "---STATUS---" && git status --short',
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
    "docker inspect webdav --format '{{json .Mounts}}' 2>/dev/null || docker inspect $(docker ps -a --filter name=webdav --format '{{.ID}}' 2>/dev/null | head -1) --format '{{json .Mounts}}' 2>/dev/null || echo \"NOT_FOUND\"",
    'docker volume ls | grep -i webdav; echo "---"; find /home/ubuntu -maxdepth 4 -iname "webdav" -type d 2>/dev/null; echo "---"; docker ps -a --filter name=webdav --format "{{.Names}} {{.Status}}"',
    'du -sh /home/ubuntu/softs/webdav/data/ 2>/dev/null && ls -la /home/ubuntu/softs/webdav/data/',
    'sudo crontab -l',
    'crontab -l',
    'sudo -u ubuntu crontab -l',
    'systemctl list-timers --all | grep -i backup || true',
    'systemctl status nginx',
    'systemctl is-active docker',
    'journalctl -u nginx -n 50 --no-pager',
    'sudo journalctl -u nginx',
    'timedatectl status',
    'hostnamectl',
    'sudo ls -la /root',
    'true',
    ':',
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
    'git pull',
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
    'docker volume rm webdav-data',
    'find /tmp -delete',
    'find /tmp -exec rm -rf {} +',
    "docker inspect npm | python3 -c \"open('x', 'w').write('y')\"",
    'crontab -r',
    'crontab -e',
    'sudo crontab -r',
    'systemctl restart nginx',
    'systemctl stop docker',
    'sudo systemctl restart nginx',
    'journalctl --vacuum-time=2d',
    'sudo rm -rf /',
    'timedatectl set-timezone Asia/Shanghai',
    'sudo -i',
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

  test('honors custom read-only patterns', () => {
    const customPatterns = ['^systemctl restart my-custom-service$', '^my-query-tool .*']
    expect(isReadOnlyShellCommand('systemctl restart my-custom-service', customPatterns)).toBe(true)
    expect(isReadOnlyShellCommand('my-query-tool --json', customPatterns)).toBe(true)
    expect(isReadOnlyShellCommand('systemctl restart other-service', customPatterns)).toBe(false)
  })
})
