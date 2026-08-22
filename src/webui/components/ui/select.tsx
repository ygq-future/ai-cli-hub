import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown, X } from 'lucide-react'

export function Select({
  value,
  onValueChange,
  options,
  onClear,
  clearLabel = 'Clear',
  ...props
}: {
  value: string
  onValueChange: (value: string) => void
  options: { value: string; label: string }[]
  'aria-label': string
  onClear?: () => void
  clearLabel?: string
}) {
  return (
    <span className={`ui-select-control${onClear ? 'has-clear' : ''}`}>
      <SelectPrimitive.Root value={value} onValueChange={onValueChange}>
        <SelectPrimitive.Trigger className="ui-select-trigger" {...props}>
          <SelectPrimitive.Value />{' '}
          <SelectPrimitive.Icon className="ui-select-chevron">
            <ChevronDown size={15} />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content className="ui-select-content" position="popper" sideOffset={7}>
            <SelectPrimitive.Viewport>
              {options.map(option => (
                <SelectPrimitive.Item className="ui-select-item" value={option.value} key={option.value}>
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator>
                    <Check size={14} />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {onClear && (
        <button
          className="ui-select-clear"
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
