import * as React from 'react'
import { useFormContext, Controller, ControllerProps, FieldPath, FieldValues } from 'react-hook-form'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

// ============================================================================
// Form Field Wrapper with Error Display
// ============================================================================

interface FormFieldProps<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
> extends Omit<ControllerProps<TFieldValues, TName>, 'render'> {
  label?: string
  description?: string
  children: (field: {
    value: unknown
    onChange: (...event: unknown[]) => void
    onBlur: () => void
    name: TName
    ref: React.Ref<unknown>
  }) => React.ReactNode
}

export function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>
>({ name, label, description, children, ...props }: FormFieldProps<TFieldValues, TName>) {
  const { control, formState: { errors } } = useFormContext<TFieldValues>()
  
  // Get nested error
  const error = name.split('.').reduce((acc: unknown, key) => {
    if (acc && typeof acc === 'object' && key in acc) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, errors) as { message?: string } | undefined

  return (
    <div className="space-y-2">
      {label && (
        <Label htmlFor={name} className={cn(error && 'text-destructive')}>
          {label}
        </Label>
      )}
      <Controller
        name={name}
        control={control}
        {...props}
        render={({ field }) => <>{children(field)}</>}
      />
      {description && !error && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      {error?.message && (
        <p className="text-sm text-destructive">{error.message}</p>
      )}
    </div>
  )
}

// ============================================================================
// Pre-built Form Input Components
// ============================================================================

interface FormInputProps {
  name: string
  label?: string
  description?: string
  type?: string
  placeholder?: string
  className?: string
  disabled?: boolean
}

export function FormInput({ 
  name, 
  label, 
  description, 
  type = 'text',
  placeholder,
  className,
  disabled 
}: FormInputProps) {
  const { register, formState: { errors } } = useFormContext()
  
  const error = name.split('.').reduce((acc: unknown, key) => {
    if (acc && typeof acc === 'object' && key in acc) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, errors) as { message?: string } | undefined

  return (
    <div className="space-y-2">
      {label && (
        <Label htmlFor={name} className={cn(error && 'text-destructive')}>
          {label}
        </Label>
      )}
      <Input
        id={name}
        type={type}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(error && 'border-destructive', className)}
        {...register(name, { valueAsNumber: type === 'number' })}
      />
      {description && !error && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      {error?.message && (
        <p className="text-sm text-destructive">{error.message}</p>
      )}
    </div>
  )
}

// ============================================================================
// Form Submit Button with Loading State
// ============================================================================

interface FormSubmitButtonProps {
  children: React.ReactNode
  isLoading?: boolean
  loadingText?: string
  className?: string
  disabled?: boolean
}

export function FormSubmitButton({
  children,
  isLoading,
  loadingText = 'Saving...',
  className,
  disabled,
}: FormSubmitButtonProps) {
  const { formState: { isSubmitting } } = useFormContext()
  const loading = isLoading ?? isSubmitting

  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className={cn(
        'inline-flex items-center justify-center rounded-md text-sm font-medium',
        'ring-offset-background transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50',
        'bg-primary text-primary-foreground hover:bg-primary/90',
        'h-10 px-4 py-2',
        className
      )}
    >
      {loading ? loadingText : children}
    </button>
  )
}

// ============================================================================
// Form Error Summary (shows all errors at once)
// ============================================================================

export function FormErrorSummary() {
  const { formState: { errors } } = useFormContext()
  
  const errorMessages = Object.entries(errors)
    .filter(([, error]) => error?.message)
    .map(([field, error]) => ({
      field,
      message: (error as { message?: string })?.message || 'Invalid',
    }))

  if (errorMessages.length === 0) return null

  return (
    <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
      <p className="text-sm font-medium text-destructive mb-1">Please fix the following errors:</p>
      <ul className="text-sm text-destructive list-disc list-inside">
        {errorMessages.map(({ field, message }) => (
          <li key={field}>{message}</li>
        ))}
      </ul>
    </div>
  )
}
