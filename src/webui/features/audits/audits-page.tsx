import { useEffect, useState } from 'react'
import type { AuditView, ApprovalStatus, CliType, Platform } from '../../../shared'
import { getAudits } from '../../api/audit-api'
import { CursorPager, DataTable, EmptyState, FilterBar, LoadingState } from '../../components/admin'
import { Input } from '../../components/ui/input'

export function AuditsPage({ locale }: { locale: 'zh-CN' | 'en' }) {
  const zh = locale === 'zh-CN'
  const [items, setItems] = useState<AuditView[]>([])
  const [status, setStatus] = useState<ApprovalStatus | ''>('')
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [cli, setCli] = useState<CliType | ''>('')
  const [userId, setUserId] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async (before?: string) => {
    setLoading(true)
    try {
      const page = await getAudits({
        limit: 40,
        before,
        status: status || undefined,
        platform: platform || undefined,
        cli: cli || undefined,
        userId: userId || undefined,
      })
      setItems(page.items)
      setCursor(before ?? null)
      setNextCursor(page.nextCursor)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => void load(), [status, platform, cli, userId])

  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <p className="admin-kicker">{zh ? '审批审计' : 'APPROVAL AUDIT'}</p>
          <h1>{zh ? '全局审批记录' : 'Global approval audit'}</h1>
          <p>
            {zh
              ? '按平台、用户、CLI 和状态查看所有审批决定。'
              : 'Review every approval decision by platform, user, CLI, and status.'}
          </p>
        </div>
      </div>
      <FilterBar>
        <Input
          placeholder={zh ? '用户 ID' : 'User ID'}
          value={userId}
          onChange={event => setUserId(event.target.value)}
        />
        <select
          className="ui-select-trigger"
          value={platform}
          onChange={event => setPlatform(event.target.value as Platform | '')}>
          <option value="">{zh ? '全部平台' : 'All platforms'}</option>
          <option value="telegram">Telegram</option>
          <option value="qq">QQ</option>
          <option value="web">Web</option>
        </select>
        <select
          className="ui-select-trigger"
          value={cli}
          onChange={event => setCli(event.target.value as CliType | '')}>
          <option value="">{zh ? '全部 CLI' : 'All CLIs'}</option>
          <option value="claude">Claude</option>
          <option value="opencode">OpenCode</option>
        </select>
        <select
          className="ui-select-trigger"
          value={status}
          onChange={event => setStatus(event.target.value as ApprovalStatus | '')}>
          <option value="">{zh ? '全部状态' : 'All statuses'}</option>
          <option value="pending">pending</option>
          <option value="approved">approved</option>
          <option value="rejected">rejected</option>
        </select>
      </FilterBar>
      {error && <p className="admin-error">{error}</p>}
      <div className="admin-panel">
        {loading ? (
          <LoadingState />
        ) : !items.length ? (
          <EmptyState label={zh ? '暂无审批记录。' : 'No approval records.'} />
        ) : (
          <DataTable>
            <thead>
              <tr>
                <th>{zh ? '时间' : 'Time'}</th>
                <th>{zh ? '范围' : 'Scope'}</th>
                <th>{zh ? '请求' : 'Request'}</th>
                <th>{zh ? '结果' : 'Decision'}</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id}>
                  <td>{new Date(item.createdAt).toLocaleString()}</td>
                  <td>
                    {item.platform} / {item.userId}
                    <small>
                      {item.cli} · {item.conversationId}
                    </small>
                  </td>
                  <td>
                    <strong>{item.request.command}</strong>
                    <small>{JSON.stringify(item.request.detail)}</small>
                  </td>
                  <td>
                    <span className={`status-pill ${item.status}`}>{item.status}</span>
                    <small>
                      {item.operator ?? '—'}
                      {item.automatic ? ' · automatic' : ''}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
        <CursorPager
          hasNext={Boolean(nextCursor)}
          onNext={() => void load(nextCursor ?? undefined)}
          onReset={cursor ? () => void load() : undefined}
        />
      </div>
    </section>
  )
}
