import type { InputHTMLAttributes } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('ui-input', className)} {...props} />
}

export function ClearableInput({
  value,
  onClear,
  clearLabel = 'Clear',
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> & {
  value: string
  onClear: () => void
  clearLabel?: string
}) {
  return (
    <span className="ui-input-control">
      <Input {...props} className={cn('ui-input-with-clear', className)} value={value} />
      {value && (
        <button
          className="ui-input-clear"
          type="button"
          aria-label={clearLabel}
          title={clearLabel}
          onPointerDown={event => event.preventDefault()}
          onClick={onClear}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </span>
  )
}
