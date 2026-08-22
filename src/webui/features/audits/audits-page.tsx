import { useEffect, useState } from 'react'
import type { AuditView, ApprovalStatus, CliType, Platform } from '../../../shared'
import { getAudits } from '../../api/audit-api'
import { CursorPager, DataTable, EmptyState, LoadingState } from '../../components/admin'
import { ClearableInput } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { useCursorPage } from '../../hooks/use-cursor-page'

export function AuditsPage({ locale }: { locale: 'zh-CN' | 'en' }) {
  const zh = locale === 'zh-CN'
  const [items, setItems] = useState<AuditView[]>([])
  const [status, setStatus] = useState<ApprovalStatus | ''>('')
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [cli, setCli] = useState<CliType | ''>('')
  const [userId, setUserId] = useState('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const pager = useCursorPage()

  const load = async (before?: string) => {
    setLoading(true)
    try {
      const page = await getAudits({
        limit: 10,
        before,
        status: status || undefined,
        platform: platform || undefined,
        cli: cli || undefined,
        userId: userId || undefined,
      })
      setItems(page.items)
      setNextCursor(page.nextCursor)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    pager.reset()
    void load()
  }, [status, platform, cli, userId])

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
      <div className="admin-filter-bar">
        <ClearableInput
          placeholder={zh ? '用户 ID' : 'User ID'}
          value={userId}
          onChange={event => setUserId(event.target.value)}
          onClear={() => setUserId('')}
          clearLabel={zh ? '清除用户 ID' : 'Clear user ID'}
        />
        <Select
          aria-label={zh ? '平台' : 'Platform'}
          value={platform || 'all'}
          onValueChange={value => setPlatform(value === 'all' ? '' : (value as Platform))}
          onClear={platform ? () => setPlatform('') : undefined}
          clearLabel={zh ? '清除平台' : 'Clear platform'}
          options={[
            { value: 'all', label: zh ? '全部平台' : 'All platforms' },
            { value: 'telegram', label: 'Telegram' },
            { value: 'qq', label: 'QQ' },
            { value: 'web', label: 'Web' },
          ]}
        />
        <Select
          aria-label="CLI"
          value={cli || 'all'}
          onValueChange={value => setCli(value === 'all' ? '' : (value as CliType))}
          onClear={cli ? () => setCli('') : undefined}
          clearLabel={zh ? '清除 CLI' : 'Clear CLI'}
          options={[
            { value: 'all', label: zh ? '全部 CLI' : 'All CLIs' },
            { value: 'claude', label: 'Claude' },
            { value: 'opencode', label: 'OpenCode' },
          ]}
        />
        <Select
          aria-label={zh ? '状态' : 'Status'}
          value={status || 'all'}
          onValueChange={value => setStatus(value === 'all' ? '' : (value as ApprovalStatus))}
          onClear={status ? () => setStatus('') : undefined}
          clearLabel={zh ? '清除状态' : 'Clear status'}
          options={[
            { value: 'all', label: zh ? '全部状态' : 'All statuses' },
            { value: 'pending', label: 'pending' },
            { value: 'approved', label: 'approved' },
            { value: 'rejected', label: 'rejected' },
          ]}
        />
      </div>
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
          hasPrevious={pager.hasPrevious}
          hasNext={Boolean(nextCursor)}
          onPrevious={() => void load(pager.goPrevious())}
          onNext={() => {
            if (!nextCursor) return
            pager.goNext(nextCursor)
            void load(nextCursor)
          }}
          previousLabel={zh ? '上一页' : 'Previous page'}
          nextLabel={zh ? '下一页' : 'Next page'}
        />
      </div>
    </section>
  )
}
