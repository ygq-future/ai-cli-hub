import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/utils'

const variants = cva('ui-button', {
  variants: { variant: { default: 'ui-button-default', ghost: 'ui-button-ghost', secondary: 'ui-button-secondary' } },
  defaultVariants: { variant: 'default' },
})
export function Button({
  className,
  variant,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof variants>) {
  return <button className={cn(variants({ variant }), className)} {...props} />
}
