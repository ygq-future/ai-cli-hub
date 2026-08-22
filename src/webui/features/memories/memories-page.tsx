import { useEffect, useState } from 'react'
import type { MemoryType, MemoryView } from '../../../shared'
import { deleteMemory, getMemories, refreshEnvironmentMemories, updateMemory } from '../../api/memory-api'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { ConfirmDialog, CursorPager, EmptyState, FilterBar, LoadingState } from '../../components/admin'

export function MemoriesPage({ locale }: { locale: 'zh-CN' | 'en' }) {
  const zh = locale === 'zh-CN'
  const [items, setItems] = useState<MemoryView[]>([])
  const [search, setSearch] = useState('')
  const [type, setType] = useState<MemoryType | ''>('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [confirming, setConfirming] = useState<MemoryView | null>(null)

  const load = async (before?: string) => {
    setLoading(true)
    try {
      const page = await getMemories({ limit: 30, before, search: search || undefined, type: type || undefined })
      setItems(page.items)
      setCursor(before ?? null)
      setNextCursor(page.nextCursor)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => void load(), [search, type])

  const save = async (item: MemoryView) => {
    try {
      const content = editing[item.id]
      const next = await updateMemory(item.id, {
        content: content === undefined ? item.content : content,
        importance: item.importance,
      })
      setItems(current => current.map(value => (value.id === next.id ? next : value)))
      setEditing(current => {
        const copy = { ...current }
        delete copy[item.id]
        return copy
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const remove = async () => {
    if (!confirming) return
    try {
      await deleteMemory(confirming.id)
      setConfirming(null)
      await load(cursor ?? undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setConfirming(null)
    }
  }

  return (
    <section className="admin-page">
      <div className="admin-heading">
        <div>
          <p className="admin-kicker">{zh ? '全局命名空间' : 'GLOBAL NAMESPACE'}</p>
          <h1>{zh ? '长期记忆' : 'Long-term memories'}</h1>
          <p>
            {zh
              ? '环境快照可查看但不可修改，其余全局记忆可编辑和删除。'
              : 'Environment snapshots are view-only; other global memories can be edited and deleted.'}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() =>
            void refreshEnvironmentMemories()
              .then(() => load())
              .catch(reason => setError(String(reason)))
          }>
          {zh ? '刷新环境' : 'Refresh environment'}
        </Button>
      </div>
      <FilterBar>
        <Input
          placeholder={zh ? '搜索记忆内容' : 'Search memory content'}
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <select
          className="ui-select-trigger"
          value={type}
          onChange={event => setType(event.target.value as MemoryType | '')}>
          <option value="">{zh ? '全部类型' : 'All types'}</option>
          <option value="episodic">episodic</option>
          <option value="semantic">semantic</option>
          <option value="preference">preference</option>
        </select>
      </FilterBar>
      {error && <p className="admin-error">{error}</p>}
      <div className="admin-panel">
        {loading ? (
          <LoadingState />
        ) : !items.length ? (
          <EmptyState label={zh ? '暂无匹配记忆。' : 'No matching memories.'} />
        ) : (
          <div className="memory-grid">
            {items.map(item => {
              const readOnly = item.tag?.startsWith('env.') === true
              return (
                <article className="memory-card" key={item.id}>
                  <div className="memory-card-header">
                    <span className="status-pill">{item.type}</span>
                    <small>{readOnly ? 'env.* · read-only' : (item.tag ?? item.id)}</small>
                  </div>
                  <textarea
                    disabled={readOnly}
                    value={editing[item.id] ?? item.content}
                    onChange={event => setEditing(current => ({ ...current, [item.id]: event.target.value }))}
                  />
                  <div className="memory-card-footer">
                    <span>
                      {item.accessCount} hits · importance {item.importance.toFixed(2)}
                    </span>
                    <div className="admin-actions">
                      {!readOnly && (
                        <>
                          <Button variant="secondary" onClick={() => void save(item)}>
                            {zh ? '保存' : 'Save'}
                          </Button>
                          <Button variant="ghost" onClick={() => setConfirming(item)}>
                            {zh ? '删除' : 'Delete'}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
        <CursorPager
          hasNext={Boolean(nextCursor)}
          onNext={() => void load(nextCursor ?? undefined)}
          onReset={cursor ? () => void load() : undefined}
        />
      </div>
      {confirming && (
        <ConfirmDialog
          title={zh ? '删除这条记忆？' : 'Delete this memory?'}
          message={zh ? '删除后会从全局召回池移除。' : 'This removes the memory from the global recall pool.'}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void remove()}
          confirmLabel={zh ? '确认删除' : 'Confirm delete'}
        />
      )}
    </section>
  )
}
