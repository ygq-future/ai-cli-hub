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
import { ConfirmDialog, CursorPager, DataTable, EmptyState, FilterBar, LoadingState } from '../../components/admin'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'

export function ConversationsPage({ locale }: { locale: 'zh-CN' | 'en' }) {
  const zh = locale === 'zh-CN'
  const [filters, setFilters] = useState<ConversationFilters>({ limit: 30 })
  const [items, setItems] = useState<ConversationView[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<ConversationId | null>(null)
  const [detail, setDetail] = useState<ConversationView | null>(null)
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [files, setFiles] = useState<Awaited<ReturnType<typeof getConversationFiles>>['items']>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)

  const load = async (before: string | null = null) => {
    setLoading(true)
    setError('')
    try {
      const page = await getConversations({ ...filters, before: before ?? undefined })
      setItems(page.items)
      setCursor(before)
      setNextCursor(page.nextCursor)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
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
      await load(cursor)
    } catch (reason) {
      setError(reason instanceof HttpClientError ? reason.message : String(reason))
      setConfirming(false)
    }
  }

  const updateFilter = (key: keyof ConversationFilters, value: string) => {
    setFilters(current => ({ ...current, [key]: value || undefined }))
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
        <Button variant="secondary" onClick={() => void load()}>
          {zh ? '刷新' : 'Refresh'}
        </Button>
      </div>
      <FilterBar>
        <Input
          placeholder={zh ? '用户 ID' : 'User ID'}
          value={filters.userId ?? ''}
          onChange={event => updateFilter('userId', event.target.value)}
        />
        <select
          className="ui-select-trigger"
          value={filters.platform ?? ''}
          onChange={event => updateFilter('platform', event.target.value)}>
          <option value="">{zh ? '全部平台' : 'All platforms'}</option>
          <option value="telegram">Telegram</option>
          <option value="qq">QQ</option>
          <option value="web">Web</option>
        </select>
        <select
          className="ui-select-trigger"
          value={filters.cli ?? ''}
          onChange={event => updateFilter('cli', event.target.value)}>
          <option value="">{zh ? '全部 CLI' : 'All CLIs'}</option>
          <option value="claude">Claude</option>
          <option value="opencode">OpenCode</option>
        </select>
        <select
          className="ui-select-trigger"
          value={filters.status ?? ''}
          onChange={event => updateFilter('status', event.target.value)}>
          <option value="">{zh ? '全部状态' : 'All statuses'}</option>
          <option value="idle">idle</option>
          <option value="running">running</option>
          <option value="closed">closed</option>
        </select>
      </FilterBar>
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
            hasNext={Boolean(nextCursor)}
            onNext={() => void load(nextCursor)}
            onReset={cursor ? () => void load() : undefined}
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
