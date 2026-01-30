import { useForm, FormProvider } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { FormInput, FormSubmitButton } from '@/components/ui/form-fields'
import { addUserFormSchema, type AddUserFormData } from '@/lib/validationSchemas'
import { playersApi } from '@/lib/api'
import { useToast } from '@/components/ui/use-toast'
import { useState } from 'react'

interface AddUserDialogProps {
  onSuccess?: () => void
}

/**
 * AddUserDialog - Demonstrates react-hook-form + zod validation pattern
 * 
 * This component can replace the inline add user logic in Players.tsx
 * Benefits:
 * - Declarative validation with zod schema
 * - Automatic error display per field
 * - Clean separation of form logic
 * - Type-safe form data
 * - Better UX with field-level validation
 */
export function AddUserDialog({ onSuccess }: AddUserDialogProps) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const { toast } = useToast()

  const form = useForm<AddUserFormData>({
    resolver: zodResolver(addUserFormSchema),
    defaultValues: {
      username: '',
      password: '',
    },
  })

  const handleSubmit = async (data: AddUserFormData) => {
    setSubmitting(true)
    try {
      await playersApi.addUser(data.username, data.password)
      toast({
        title: 'Success',
        description: 'User added successfully',
        variant: 'success' as const,
      })
      form.reset()
      setOpen(false)
      onSuccess?.()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to add user',
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen)
    if (!newOpen) {
      // Reset form when dialog closes
      form.reset()
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <UserPlus className="w-4 h-4 mr-2" />
          Add User
        </Button>
      </DialogTrigger>
      <DialogContent>
        <FormProvider {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)}>
            <DialogHeader>
              <DialogTitle>Add User</DialogTitle>
              <DialogDescription>
                Create a new user account for whitelist servers
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <FormInput
                name="username"
                label="Username"
                placeholder="Enter username..."
              />
              <FormInput
                name="password"
                label="Password"
                type="password"
                placeholder="Enter password (min 4 characters)..."
              />
            </div>
            <DialogFooter>
              <Button 
                type="button" 
                variant="outline" 
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <FormSubmitButton 
                isLoading={submitting}
                loadingText="Adding..."
              >
                <UserPlus className="w-4 h-4 mr-2" />
                Add User
              </FormSubmitButton>
            </DialogFooter>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  )
}

export default AddUserDialog
