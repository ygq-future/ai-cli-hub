import type { ReactNode } from 'react'
import { Button } from './ui/button'

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <div className="admin-state">{label}</div>
}

export function EmptyState({ label = 'No records found.' }: { label?: string }) {
  return <div className="admin-state">{label}</div>
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="admin-filter-bar">{children}</div>
}

export function CursorPager({
  hasNext,
  onNext,
  onReset,
}: {
  hasNext: boolean
  onNext: () => void
  onReset?: () => void
}) {
  return (
    <div className="admin-pager">
      {onReset && (
        <Button variant="ghost" onClick={onReset}>
          First page
        </Button>
      )}
      <Button variant="secondary" disabled={!hasNext} onClick={onNext}>
        Next page
      </Button>
    </div>
  )
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="admin-confirm" role="dialog" aria-modal="true" aria-labelledby="admin-confirm-title">
      <div className="admin-confirm-card">
        <h3 id="admin-confirm-title">{title}</h3>
        <p>{message}</p>
        <div className="admin-actions">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="default" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function DataTable({ children }: { children: ReactNode }) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">{children}</table>
    </div>
  )
}
