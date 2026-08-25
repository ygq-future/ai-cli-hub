import { useEffect, useState } from 'react'
import type { MemoryType, MemoryView } from '../../../shared'
import { deleteMemory, getMemories, updateMemory } from '../../api/memory-api'
import { Button } from '../../components/ui/button'
import { ClearableInput } from '../../components/ui/input'
import { Select } from '../../components/ui/select'
import { Textarea } from '../../components/ui/textarea'
import { ConfirmDialog, CursorPager, EmptyState, LoadingState } from '../../components/admin'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { useCursorPage } from '../../hooks/use-cursor-page'

export function MemoriesPage({ locale }: { locale: 'zh-CN' | 'en' }) {
  const zh = locale === 'zh-CN'
  const [items, setItems] = useState<MemoryView[]>([])
  const [search, setSearch] = useState('')
  const [type, setType] = useState<MemoryType | ''>('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<MemoryView | null>(null)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState<MemoryView | null>(null)
  const pager = useCursorPage()

  const load = async (before?: string) => {
    setLoading(true)
    try {
      const page = await getMemories({ limit: 10, before, search: search || undefined, type: type || undefined })
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
  }, [search, type])

  const openEditor = (item: MemoryView) => {
    setEditing(item)
    setEditContent(item.content)
  }

  const save = async () => {
    if (!editing) return
    setSaving(true)
    try {
      const next = await updateMemory(editing.id, {
        content: editContent,
        importance: editing.importance,
      })
      setItems(current => current.map(value => (value.id === next.id ? next : value)))
      setEditing(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!confirming) return
    try {
      await deleteMemory(confirming.id)
      setConfirming(null)
      await load(pager.currentCursor)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setConfirming(null)
    }
  }

  return (
    <section className="admin-page">
      <p className="admin-tip">
        {zh
          ? '环境快照可查看但不可修改，其余全局记忆可编辑和删除。'
          : 'Environment snapshots are view-only; other global memories can be edited and deleted.'}
      </p>
      <div className="admin-filter-bar">
        <ClearableInput
          placeholder={zh ? '搜索记忆内容' : 'Search memory content'}
          value={search}
          onChange={event => setSearch(event.target.value)}
          onClear={() => setSearch('')}
          clearLabel={zh ? '清除搜索' : 'Clear search'}
        />
        <Select
          aria-label={zh ? '记忆类型' : 'Memory type'}
          value={type || 'all'}
          onValueChange={value => setType(value === 'all' ? '' : (value as MemoryType))}
          onClear={type ? () => setType('') : undefined}
          clearLabel={zh ? '清除类型' : 'Clear type'}
          options={[
            { value: 'all', label: zh ? '全部类型' : 'All types' },
            { value: 'episodic', label: 'episodic' },
            { value: 'semantic', label: 'semantic' },
            { value: 'preference', label: 'preference' },
          ]}
        />
      </div>
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
                  <p className="memory-content" title={item.content}>
                    {item.content}
                  </p>
                  <div className="memory-card-footer">
                    <span>
                      {item.accessCount} hits · importance {item.importance.toFixed(2)}
                    </span>
                    <div className="admin-actions">
                      {!readOnly && (
                        <>
                          <Button variant="secondary" onClick={() => openEditor(item)}>
                            {zh ? '修改' : 'Edit'}
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
      <Dialog open={editing !== null} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent className="memory-edit-dialog">
          <DialogHeader>
            <DialogTitle>{zh ? '修改长期记忆' : 'Edit long-term memory'}</DialogTitle>
            <DialogDescription>
              {zh ? '修改后的内容会重新生成语义向量。' : 'Changing the content regenerates its semantic embedding.'}
            </DialogDescription>
          </DialogHeader>
          <div className="memory-edit-form">
            <label>
              <span>{zh ? '记忆内容' : 'Memory content'}</span>
              <Textarea value={editContent} onChange={event => setEditContent(event.target.value)} rows={8} autoFocus />
            </label>
          </div>
          <div className="admin-actions memory-edit-actions">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              {zh ? '取消' : 'Cancel'}
            </Button>
            <Button disabled={saving || !editContent.trim()} onClick={() => void save()}>
              {zh ? '保存修改' : 'Save changes'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
