import { useEffect, useState } from 'react'
import type { ConversationId, ConversationView, TimelineItem } from '../../../shared'
import {
  conversationFileUrl,
  deleteConversation,
  getConversation,
  getConversationFiles,
  getConversationTimeline,
  getConversations,
  type ConversationFilters,
} from '../../api/conversation-api'
import { HttpClientError } from '../../api/http-client'
import { ConfirmDialog, CursorPager, DataTable, EmptyState, LoadingState } from '../../components/admin'
import { Button } from '../../components/ui/button'
import { ClearableInput } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { useCursorPage } from '../../hooks/use-cursor-page'

export function ConversationsPage({ locale }: { locale: 'zh-CN' | 'en' }) {
  const zh = locale === 'zh-CN'
  const [filters, setFilters] = useState<ConversationFilters>({ limit: 10 })
  const [items, setItems] = useState<ConversationView[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<ConversationId | null>(null)
  const [detail, setDetail] = useState<ConversationView | null>(null)
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [files, setFiles] = useState<Awaited<ReturnType<typeof getConversationFiles>>['items']>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const pager = useCursorPage()

  const load = async (before: string | undefined = undefined) => {
    setLoading(true)
    setError('')
    try {
      const page = await getConversations({ ...filters, before: before ?? undefined })
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
  }, [filters.platform, filters.cli, filters.status, filters.userId])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      setTimeline([])
      setFiles([])
      return
    }
    let active = true
    void Promise.all([
      getConversation(selectedId),
      getConversationTimeline(selectedId),
      getConversationFiles(selectedId),
    ])
      .then(([conversation, history, filePage]) => {
        if (!active) return
        setDetail(conversation)
        setTimeline(history.items)
        setFiles(filePage.items)
      })
      .catch(reason => active && setError(reason instanceof Error ? reason.message : String(reason)))
    return () => {
      active = false
    }
  }, [selectedId])

  const remove = async () => {
    if (!selectedId) return
    try {
      await deleteConversation(selectedId)
      setConfirming(false)
      setSelectedId(null)
      await load(pager.currentCursor)
    } catch (reason) {
      setError(reason instanceof HttpClientError ? reason.message : String(reason))
      setConfirming(false)
    }
  }

  const updateFilter = (key: keyof ConversationFilters, value: string) => {
    setFilters(current => ({ ...current, limit: 10, [key]: value || undefined }))
  }

  const refresh = () => {
    pager.reset()
    void load()
  }

  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <p className="admin-kicker">{zh ? '全实例管理' : 'INSTANCE ADMINISTRATION'}</p>
          <h1>{zh ? '会话与文件' : 'Conversations & files'}</h1>
          <p>
            {zh
              ? '浏览所有平台、用户和 CLI 的会话历史，并安全清理会话聚合。'
              : 'Browse every platform, user, and CLI session with safe aggregate deletion.'}
          </p>
        </div>
        <Button variant="secondary" onClick={refresh}>
          {zh ? '刷新' : 'Refresh'}
        </Button>
      </div>
      <div className="admin-filter-bar">
        <ClearableInput
          placeholder={zh ? '用户 ID' : 'User ID'}
          value={filters.userId ?? ''}
          onChange={event => updateFilter('userId', event.target.value)}
          onClear={() => updateFilter('userId', '')}
          clearLabel={zh ? '清除用户 ID' : 'Clear user ID'}
        />
        <Select
          aria-label={zh ? '平台' : 'Platform'}
          value={filters.platform ?? 'all'}
          onValueChange={value => updateFilter('platform', value === 'all' ? '' : value)}
          onClear={filters.platform ? () => updateFilter('platform', '') : undefined}
          clearLabel={zh ? '清除平台' : 'Clear platform'}
          options={[
            { value: 'all', label: zh ? '全部平台' : 'All platforms' },
            { value: 'telegram', label: 'Telegram' },
            { value: 'qq', label: 'QQ' },
            { value: 'web', label: 'Web' },
          ]}
        />
        <Select
          aria-label={zh ? 'CLI' : 'CLI'}
          value={filters.cli ?? 'all'}
          onValueChange={value => updateFilter('cli', value === 'all' ? '' : value)}
          onClear={filters.cli ? () => updateFilter('cli', '') : undefined}
          clearLabel={zh ? '清除 CLI' : 'Clear CLI'}
          options={[
            { value: 'all', label: zh ? '全部 CLI' : 'All CLIs' },
            { value: 'claude', label: 'Claude' },
            { value: 'opencode', label: 'OpenCode' },
          ]}
        />
        <Select
          aria-label={zh ? '状态' : 'Status'}
          value={filters.status ?? 'all'}
          onValueChange={value => updateFilter('status', value === 'all' ? '' : value)}
          onClear={filters.status ? () => updateFilter('status', '') : undefined}
          clearLabel={zh ? '清除状态' : 'Clear status'}
          options={[
            { value: 'all', label: zh ? '全部状态' : 'All statuses' },
            { value: 'idle', label: 'idle' },
            { value: 'running', label: 'running' },
            { value: 'closed', label: 'closed' },
          ]}
        />
      </div>
      {error && <p className="admin-error">{error}</p>}
      <div className="admin-split">
        <div className="admin-panel">
          {loading ? (
            <LoadingState label={zh ? '正在加载会话…' : 'Loading conversations…'} />
          ) : !items.length ? (
            <EmptyState label={zh ? '没有匹配的会话。' : 'No matching conversations.'} />
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <th>{zh ? '会话' : 'Conversation'}</th>
                  <th>{zh ? '范围' : 'Scope'}</th>
                  <th>{zh ? '状态' : 'Status'}</th>
                  <th>{zh ? '计数' : 'Counts'}</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr
                    className={selectedId === item.id ? 'selected' : ''}
                    key={item.id}
                    onClick={() => setSelectedId(item.id)}>
                    <td>
                      <strong>{item.id}</strong>
                      <small>{new Date(item.updatedAt).toLocaleString()}</small>
                    </td>
                    <td>
                      {item.platform} / {item.userId}
                      <small>
                        {item.cli} · {item.cwd}
                      </small>
                    </td>
                    <td>
                      <span className={`status-pill ${item.status}`}>{item.status}</span>
                    </td>
                    <td>
                      {item.messageCount} msg · {item.fileCount} files · {item.auditCount} audit
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
        <div className="admin-panel admin-detail-panel">
          {!detail ? (
            <EmptyState label={zh ? '选择一个会话查看详情。' : 'Select a conversation to inspect details.'} />
          ) : (
            <>
              <div className="admin-detail-header">
                <div>
                  <span className="admin-kicker">
                    {detail.platform} / {detail.cli}
                  </span>
                  <h2>{detail.id}</h2>
                </div>
                <Button variant="default" onClick={() => setConfirming(true)}>
                  {zh ? '硬删除' : 'Delete aggregate'}
                </Button>
              </div>
              <dl className="admin-metadata">
                <div>
                  <dt>{zh ? '用户' : 'User'}</dt>
                  <dd>{detail.userId}</dd>
                </div>
                <div>
                  <dt>{zh ? '工作目录' : 'CWD'}</dt>
                  <dd>{detail.cwd}</dd>
                </div>
                <div>
                  <dt>{zh ? '状态' : 'Status'}</dt>
                  <dd>{detail.status}</dd>
                </div>
              </dl>
              <h3>{zh ? '时间线' : 'Timeline'}</h3>
              <div className="admin-timeline">
                {timeline.length ? (
                  timeline.map(item => (
                    <article key={item.id}>
                      <small>{new Date(item.createdAt).toLocaleString()}</small>
                      {item.type === 'chat' ? (
                        <p>
                          <b>{item.role}</b> {item.content}
                        </p>
                      ) : (
                        <p>
                          <b>approval</b> {item.approval?.status ?? (zh ? '审计记录缺失' : 'audit record missing')}
                        </p>
                      )}
                    </article>
                  ))
                ) : (
                  <EmptyState label={zh ? '暂无消息。' : 'No messages.'} />
                )}
              </div>
              <h3>{zh ? '文件' : 'Files'}</h3>
              {files.length ? (
                <ul className="admin-file-list">
                  {files.map(file => (
                    <li key={file.id}>
                      <a href={conversationFileUrl(detail.id, file.id)} target="_blank" rel="noreferrer">
                        #{file.sequence} {file.fileName ?? file.id}
                      </a>
                      <small>
                        {file.mimeType ?? 'binary'} · {file.fileSize ?? 0} bytes
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState label={zh ? '暂无文件。' : 'No files.'} />
              )}
            </>
          )}
        </div>
      </div>
      {confirming && (
        <ConfirmDialog
          title={zh ? '删除会话聚合？' : 'Delete conversation aggregate?'}
          message={
            zh
              ? '消息、文件映射和审批审计将被删除，磁盘文件也会清理。'
              : 'Messages, file mappings, and approval audits will be deleted, and managed files will be cleaned up.'
          }
          confirmLabel={zh ? '确认删除' : 'Confirm delete'}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void remove()}
        />
      )}
    </section>
  )
}
