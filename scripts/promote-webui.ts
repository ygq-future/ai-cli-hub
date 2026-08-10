import { access, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export interface PromoteWebUiInput {
  stagedDir: string
  targetDir: string
  backupDir: string
}

export async function promoteWebUi(input: PromoteWebUiInput): Promise<void> {
  await assertBuild(input.stagedDir)
  await rm(input.backupDir, { recursive: true, force: true })

  const hadTarget = await pathExists(input.targetDir)
  if (hadTarget) await rename(input.targetDir, input.backupDir)

  try {
    await rename(input.stagedDir, input.targetDir)
  } catch (error) {
    if (hadTarget) await rename(input.backupDir, input.targetDir)
    throw error
  }

  await rm(input.backupDir, { recursive: true, force: true })
}

async function assertBuild(directory: string): Promise<void> {
  const indexPath = path.join(directory, 'index.html')
  try {
    await access(indexPath)
  } catch {
    throw new Error(`Staged WebUI is missing index.html: ${indexPath}`)
  }

  const assetsPath = path.join(directory, 'assets')
  try {
    if (!(await stat(assetsPath)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(`Staged WebUI is missing assets directory: ${assetsPath}`)
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

if (import.meta.main) {
  const appRoot = path.resolve(import.meta.dir, '..')
  await promoteWebUi({
    stagedDir: path.join(appRoot, '.data', 'update', 'webui-next'),
    targetDir: path.join(appRoot, 'public', 'webui'),
    backupDir: path.join(appRoot, '.data', 'update', 'webui-backup'),
  })
}
