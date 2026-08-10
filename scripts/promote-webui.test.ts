import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promoteWebUi } from './promote-webui'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-cli-hub-webui-'))
  roots.push(root)
  return {
    stagedDir: path.join(root, 'webui-next'),
    targetDir: path.join(root, 'webui'),
    backupDir: path.join(root, 'webui-backup'),
  }
}

async function writeBuild(directory: string, marker: string) {
  await mkdir(path.join(directory, 'assets'), { recursive: true })
  await writeFile(path.join(directory, 'index.html'), `<html>${marker}</html>`, 'utf8')
  await writeFile(path.join(directory, 'assets', 'app.js'), `console.log('${marker}')`, 'utf8')
}

async function exists(target: string): Promise<boolean> {
  return Bun.file(target).exists()
}

describe('promote WebUI', () => {
  test('promotes a validated staged build and removes the backup', async () => {
    const paths = await fixture()
    await writeBuild(paths.targetDir, 'old')
    await writeBuild(paths.stagedDir, 'new')

    await promoteWebUi(paths)

    expect(await readFile(path.join(paths.targetDir, 'index.html'), 'utf8')).toContain('new')
    expect(await exists(paths.backupDir)).toBe(false)
    expect(await exists(paths.stagedDir)).toBe(false)
  })

  test('rejects an incomplete staged build and preserves the current build', async () => {
    const paths = await fixture()
    await writeBuild(paths.targetDir, 'old')
    await mkdir(paths.stagedDir, { recursive: true })

    await expect(promoteWebUi(paths)).rejects.toThrow('index.html')

    expect(await readFile(path.join(paths.targetDir, 'index.html'), 'utf8')).toContain('old')
    expect(await exists(paths.backupDir)).toBe(false)
  })
})
