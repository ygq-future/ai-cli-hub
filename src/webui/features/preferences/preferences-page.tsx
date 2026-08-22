import { useEffect, useState } from 'react'
import type { CliType, PreferenceScope, PreferenceScopeView, PreferenceSnapshot } from '../../../shared'
import { getPreferenceScopes, getPreferences, updateCliPreference, updatePreferences } from '../../api/preference-api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { CursorPager, EmptyState, LoadingState } from '../../components/admin'

export function PreferencesPage({ locale }: { locale: 'zh-CN' | 'en' }) {
  const zh = locale === 'zh-CN'
  const [scopes, setScopes] = useState<PreferenceScopeView[]>([])
  const [scopeCursor, setScopeCursor] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<PreferenceScope | null>(null)
  const [snapshot, setSnapshot] = useState<PreferenceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const loadScopes = async (before?: string) => {
    setLoading(true)
    try {
      const page = await getPreferenceScopes({ limit: 40, before })
      setScopes(page.items)
      setScopeCursor(before ?? null)
      setNextCursor(page.nextCursor)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => void loadScopes(), [])
  useEffect(() => {
    if (!selected) return
    setSnapshot(null)
    void getPreferences(selected)
      .then(setSnapshot)
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [selected])

  const saveGeneral = async () => {
    if (!selected || !snapshot) return
    setSaving(true)
    try {
      const next = await updatePreferences(selected, {
        language: snapshot.language,
        defaultCli: snapshot.defaultCli,
        autoApproveEnabled: snapshot.autoApproveEnabled,
        autoApproveSeconds: snapshot.autoApproveSeconds,
      })
      setSnapshot(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const saveCli = async (cli: CliType, cwd: string, modelId: string | null) => {
    if (!selected || !snapshot) return
    setSaving(true)
    try {
      const next = await updateCliPreference(selected, cli, { cwd, modelId })
      setSnapshot(current =>
        current ? { ...current, cli: current.cli.map(item => (item.cli === cli ? next : item)) } : current,
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <p className="admin-kicker">{zh ? '偏好范围' : 'PREFERENCE SCOPES'}</p>
          <h1>{zh ? '用户与 CLI 偏好' : 'User & CLI preferences'}</h1>
          <p>
            {zh
              ? '管理所有平台用户的语言、审批和工作目录偏好。'
              : 'Manage language, approval, and working-directory preferences for every platform user.'}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void loadScopes()}>
          {zh ? '刷新' : 'Refresh'}
        </Button>
      </div>
      {error && <p className="admin-error">{error}</p>}
      <div className="admin-split preferences-layout">
        <div className="admin-panel">
          {loading ? (
            <LoadingState />
          ) : !scopes.length ? (
            <EmptyState label={zh ? '暂无持久化偏好范围。' : 'No persisted preference scopes.'} />
          ) : (
            <ul className="admin-scope-list">
              {scopes.map(item => (
                <li
                  key={`${item.platform}:${item.userId}`}
                  className={selected?.platform === item.platform && selected.userId === item.userId ? 'selected' : ''}>
                  <button type="button" onClick={() => setSelected(item)}>
                    <strong>{item.userId}</strong>
                    <span>
                      {item.platform} · {new Date(item.updatedAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <CursorPager
            hasNext={Boolean(nextCursor)}
            onNext={() => void loadScopes(nextCursor ?? undefined)}
            onReset={scopeCursor ? () => void loadScopes() : undefined}
          />
        </div>
        <div className="admin-panel admin-form-panel">
          {!snapshot ? (
            <EmptyState label={zh ? '选择一个用户范围。' : 'Select a user scope.'} />
          ) : (
            <>
              <div className="admin-detail-header">
                <div>
                  <span className="admin-kicker">{snapshot.scope.platform}</span>
                  <h2>{snapshot.scope.userId}</h2>
                </div>
                <Button disabled={saving} onClick={() => void saveGeneral()}>
                  {zh ? '保存偏好' : 'Save preferences'}
                </Button>
              </div>
              <div className="admin-form-grid">
                <label>
                  {zh ? '语言' : 'Language'}
                  <select
                    className="ui-select-trigger"
                    value={snapshot.language}
                    onChange={event => setSnapshot({ ...snapshot, language: event.target.value as 'zh' | 'en' })}>
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                  </select>
                </label>
                <label>
                  {zh ? '默认 CLI' : 'Default CLI'}
                  <select
                    className="ui-select-trigger"
                    value={snapshot.defaultCli}
                    onChange={event => setSnapshot({ ...snapshot, defaultCli: event.target.value as CliType })}>
                    <option value="claude">Claude</option>
                    <option value="opencode">OpenCode</option>
                  </select>
                </label>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={snapshot.autoApproveEnabled}
                    onChange={event => setSnapshot({ ...snapshot, autoApproveEnabled: event.target.checked })}
                  />{' '}
                  {zh ? '启用自动审批' : 'Automatic approval'}
                </label>
                <label>
                  {zh ? '自动审批秒数' : 'Approval seconds'}
                  <Input
                    type="number"
                    min={1}
                    max={300}
                    value={snapshot.autoApproveSeconds}
                    onChange={event => setSnapshot({ ...snapshot, autoApproveSeconds: Number(event.target.value) })}
                  />
                </label>
              </div>
              <h3>{zh ? 'CLI 配置' : 'CLI configuration'}</h3>
              <div className="admin-cli-grid">
                {snapshot.cli.map(item => (
                  <CliPreferenceCard
                    key={item.cli}
                    cli={item.cli}
                    cwd={item.cwd}
                    modelId={item.modelId}
                    zh={zh}
                    saving={saving}
                    onSave={saveCli}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function CliPreferenceCard({
  cli,
  cwd,
  modelId,
  zh,
  saving,
  onSave,
}: {
  cli: CliType
  cwd: string
  modelId: string | null
  zh: boolean
  saving: boolean
  onSave: (cli: CliType, cwd: string, modelId: string | null) => Promise<void>
}) {
  const [nextCwd, setNextCwd] = useState(cwd)
  const [nextModel, setNextModel] = useState(modelId ?? '')
  return (
    <div className="admin-cli-card">
      <h4>{cli}</h4>
      <label>
        {zh ? '工作目录' : 'Working directory'}
        <Input value={nextCwd} onChange={event => setNextCwd(event.target.value)} />
      </label>
      <label>
        {zh ? '模型 ID' : 'Model ID'}
        <Input
          value={nextModel}
          onChange={event => setNextModel(event.target.value)}
          placeholder={zh ? '需要活跃会话验证' : 'Validated by active session'}
        />
      </label>
      <Button variant="secondary" disabled={saving} onClick={() => void onSave(cli, nextCwd, nextModel || null)}>
        {zh ? '保存 CLI' : 'Save CLI'}
      </Button>
    </div>
  )
}
