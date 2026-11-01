import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck, ShieldAlert, Plus, Pencil, Trash2, Loader2, Lock, ChevronDown, AlertTriangle, Users as UsersIcon } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { PageSkeleton } from '@/components/PageSkeleton'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import { SectionCard } from '@/components/ui/section-card'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { HelpTip } from '@/components/HelpTip'
import { DisabledReason } from '@/components/DisabledReason'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { useAuth } from '@/contexts/AuthContext'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { isDemoMode } from '@/lib/demo'
import { useConfirm } from '@/contexts/ConfirmContext'
import {
  permissionsApi,
  usersApi,
  ApiError,
  type CapabilityGroup,
  type CapabilityInfo,
  type RoleInfo,
  type ManagedUserAccount,
} from '@/lib/api'
import { getUserErrorMessage } from '@/lib/errorMessage'

// Mirrors server/services/permissions.js's RECOVERY_CAPABILITIES -- the two
// capabilities the matrix's own lockout row header flags, since unchecking
// the last holder's box on one of these two rows is the one action on this
// screen that can lock an administrator out of the panel.
const RECOVERY_CAPABILITY_KEYS = new Set(['roles.manage', 'users.manage'])

// Rights that amount to shell access on the host (install a server, edit any file, run servers).
const HOST_ACCESS_CAPABILITY_KEYS = new Set(['server.install', 'files.manage', 'servers.manage'])

// Which of the two recovery capabilities (server/services/permissions.js
// RECOVERY_CAPABILITIES) a pending capability change would remove -- lets
// the client fill in the {{action}} placeholder in the server's
// ROLE_LOCKOUT_LAST_MANAGER / ROLE_SELF_CAPABILITY_LOSS_CONFIRM messages
// with a translated phrase instead of the server's own English fragment.
// Checked in the same order the server checks RECOVERY_CAPABILITIES.
function recoveryActionKey(
  existingCapabilities: string[],
  nextCapabilities: string[],
): 'lockout.actionManageRoles' | 'lockout.actionManageUsers' | null {
  const removes = (capability: string) =>
    existingCapabilities.includes(capability) && !nextCapabilities.includes(capability)
  if (removes('roles.manage')) return 'lockout.actionManageRoles'
  if (removes('users.manage')) return 'lockout.actionManageUsers'
  return null
}

// `embedded`: rendered inside a Settings tab panel instead of as its own
// route -- see the matching note on Users.tsx.
export default function RolesPermissions({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation(['roles', 'errors'])
  const { toast } = useToast()
  const confirm = useConfirm()
  const { can, authEnabled } = useAuth()

  // Moving a deleted role's members onto another role is assigning it to
  // them, so deleteRole() (server/services/permissions.js) refuses any
  // target granting a capability the caller doesn't hold. Grey those
  // targets out up front instead of failing on Delete. can() fails open on
  // an unresolved capability list -- the server still decides.
  function reassignTargetBlockedReason(target: RoleInfo): string | null {
    return target.capabilities.every((capability) => can(capability))
      ? null
      : t('deleteRoleDialog.reassignExceedsYours')
  }

  const [groups, setGroups] = useState<CapabilityGroup[]>([])
  const [roles, setRoles] = useState<RoleInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [permissionDenied, setPermissionDenied] = useState(false)

  // Which capability groups are collapsed in the matrix. Empty by default --
  // every group starts open, matching the matrix's pre-collapsible behavior,
  // so collapsing is something the operator opts into rather than a hidden
  // capability they have to know to expand.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  function toggleGroup(group: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  const [users, setUsers] = useState<ManagedUserAccount[] | null>(null)
  const [usersDenied, setUsersDenied] = useState(false)
  const [usersLoadError, setUsersLoadError] = useState<string | null>(null)

  const [savingCells, setSavingCells] = useState<Set<string>>(new Set())
  const [savingUserRows, setSavingUserRows] = useState<Set<string>>(new Set())

  // Latest capability set per role, including ones still in flight. A plain
  // ref rather than state -- it has to be readable synchronously by a second
  // toggle fired before the first one's response has re-rendered `roles`.
  // Without this, two toggles on the same role computed nextCapabilities
  // from the same stale `role.capabilities` snapshot; the server's
  // updateRole() is a hard replace (not a merge), so whichever request
  // landed second silently reverted the first -- fail-open on a revocation
  // (uncheck A, then uncheck B before A's response lands: request 2 still
  // has A in it, and if it resolves after request 1, A comes back).
  const pendingCapabilitiesRef = useRef<Map<string, string[]>>(new Map())

  // Focus-restore-after-delete pattern -- see Users.tsx's handleDelete /
  // effect (same fix, first written up there) for the full reasoning:
  // Radix restores focus correctly to the button that opened the delete
  // dialog, and this component then deletes the very column that button
  // lived in, stranding focus at document.body. Adapted here for a MATRIX,
  // not a row list -- each role is a <th> COLUMN, not a <tr>, so the
  // "neighbor" is the next/previous role column, and the target is each
  // role's RENAME button specifically (not delete) because a seeded role's
  // delete button is `disabled` -- an unfocusable target -- while rename
  // is always enabled regardless of seeded status.
  const roleHeaderButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const pendingFocusTargetRef = useRef<string | 'fallback' | null>(null)
  const addRoleButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const target = pendingFocusTargetRef.current
    if (target === null) return
    pendingFocusTargetRef.current = null
    if (target === 'fallback') {
      addRoleButtonRef.current?.focus()
      return
    }
    roleHeaderButtonRefs.current.get(target)?.focus()
  }, [roles])

  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<RoleInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RoleInfo | null>(null)

  const [formName, setFormName] = useState('')
  const [formCapabilities, setFormCapabilities] = useState<Set<string>>(new Set())
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [reassignTo, setReassignTo] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const fetchUsers = useCallback(async () => {
    try {
      const { users: list } = await usersApi.list()
      setUsers(Array.isArray(list) ? list : [])
      setUsersDenied(false)
      setUsersLoadError(null)
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setUsersDenied(true)
      } else {
        setUsersLoadError(getUserErrorMessage(error, t('toasts.unknownError')))
      }
    }
  }, [t])

  const fetchMatrix = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    setPermissionDenied(false)
    try {
      const [{ groups: g }, { roles: r }] = await Promise.all([
        permissionsApi.getCapabilities(),
        permissionsApi.getRoles(),
      ])
      // A reply without these lists (the demo build's catch-all answer had
      // neither) reads as empty ones, not undefined for roles.length below.
      setGroups(Array.isArray(g) ? g : [])
      setRoles(Array.isArray(r) ? r : [])
      // users.manage is a separate capability from roles.manage -- fetch it
      // independently so a 403 here doesn't block rendering the matrix itself.
      fetchUsers()
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setPermissionDenied(true)
      } else {
        setLoadError(getUserErrorMessage(error, t('toasts.unknownError')))
      }
    } finally {
      setLoading(false)
    }
  }, [fetchUsers, t])

  useEffect(() => {
    fetchMatrix()
  }, [fetchMatrix])

  function capabilityLabel(cap: CapabilityInfo): string {
    return t(`capabilities.${cap.key}.label`, { defaultValue: cap.label })
  }
  function capabilityDescription(cap: CapabilityInfo): string {
    return t(`capabilities.${cap.key}.description`, { defaultValue: cap.description })
  }
  function groupLabel(group: string): string {
    return t(`capabilityGroups.${group}`, { defaultValue: group })
  }

  async function applyRoleCapabilities(
    role: RoleInfo,
    nextCapabilities: string[],
    confirmSelfCapabilityLoss: boolean,
    existingCapabilities: string[],
  ): Promise<boolean> {
    try {
      const { role: updated } = await permissionsApi.updateRole(role.id, {
        capabilities: nextCapabilities,
        confirmSelfCapabilityLoss,
      })
      // Only commit this response if no newer toggle on this role has been
      // issued while it was in flight -- an older response landing after a
      // newer one already committed the right state must not clobber it
      // back (the mirror image of the request-construction race above: two
      // in-flight requests can resolve in either order over the network).
      if (pendingCapabilitiesRef.current.get(role.id) === nextCapabilities) {
        setRoles((prev) => prev.map((r) => (r.id === role.id ? { ...r, ...updated } : r)))
      }
      return true
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ROLE_SELF_CAPABILITY_LOSS_CONFIRM') {
        const actionKey = recoveryActionKey(existingCapabilities, nextCapabilities)
        const action = actionKey ? t(actionKey) : ''
        const ok = await confirm({
          title: t('confirmSelfCapabilityLoss.title'),
          description: t('confirmSelfCapabilityLoss.description', { action }),
          confirmLabel: t('confirmSelfCapabilityLoss.confirm'),
          cancelLabel: t('confirmSelfCapabilityLoss.cancel'),
        })
        if (ok) return applyRoleCapabilities(role, nextCapabilities, true, existingCapabilities)
        return false
      }
      if (error instanceof ApiError && error.code === 'ROLE_LOCKOUT_LAST_MANAGER') {
        const actionKey = recoveryActionKey(existingCapabilities, nextCapabilities)
        const action = actionKey ? t(actionKey) : ''
        toast({
          title: t('toasts.actionFailedTitle'),
          description: t('errors:ROLE_LOCKOUT_LAST_MANAGER', { action }),
          variant: 'destructive',
        })
        return false
      }
      toast({
        title: t('toasts.actionFailedTitle'),
        description: getUserErrorMessage(error, t('toasts.unknownError')),
        variant: 'destructive',
      })
      return false
    }
  }

  async function handleToggleCapability(role: RoleInfo, cap: CapabilityInfo, checked: boolean) {
    const cellKey = `${role.id}:${cap.key}`
    if (savingCells.has(cellKey)) return
    setSavingCells((prev) => new Set(prev).add(cellKey))

    // Base off the latest known set for this role (including any still
    // in-flight change), not the `role` object closed over at render time --
    // see pendingCapabilitiesRef's comment above.
    const baseCapabilities = pendingCapabilitiesRef.current.get(role.id) ?? role.capabilities
    const nextCapabilities = checked
      ? [...baseCapabilities, cap.key]
      : baseCapabilities.filter((c) => c !== cap.key)
    pendingCapabilitiesRef.current.set(role.id, nextCapabilities)

    const ok = await applyRoleCapabilities(role, nextCapabilities, false, baseCapabilities)

    // Only clear the pending marker if nothing newer has queued behind this
    // call while it was in flight -- otherwise a later toggle's own pending
    // value gets discarded here.
    if (pendingCapabilitiesRef.current.get(role.id) === nextCapabilities) {
      pendingCapabilitiesRef.current.delete(role.id)
    }

    if (ok) {
      toast({
        description: t(checked ? 'toasts.capabilityGranted' : 'toasts.capabilityRevoked', {
          capability: capabilityLabel(cap),
          role: role.name,
        }),
        variant: 'success',
      })
    }
    setSavingCells((prev) => {
      const next = new Set(prev)
      next.delete(cellKey)
      return next
    })
  }

  function openCreateDialog() {
    setFormName('')
    setFormCapabilities(new Set())
    setFormError(null)
    setCreateOpen(true)
  }

  async function handleCreateSubmit() {
    const name = formName.trim()
    if (!name) {
      setFormError(t('roleFormDialog.nameRequired'))
      return
    }
    setFormBusy(true)
    setFormError(null)
    try {
      const { role } = await permissionsApi.createRole({
        name,
        capabilities: Array.from(formCapabilities),
      })
      setRoles((prev) => [...prev, { ...role, memberCount: 0 }])
      setCreateOpen(false)
      toast({
        title: t('toasts.roleCreatedTitle'),
        description: t('toasts.roleCreatedDescription', { name: role.name }),
        variant: 'success',
      })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ROLE_NAME_TAKEN') {
        setFormError(t('errors:ROLE_NAME_TAKEN', { name }))
      } else {
        setFormError(getUserErrorMessage(error, t('toasts.unknownError')))
      }
    } finally {
      setFormBusy(false)
    }
  }

  function openRenameDialog(role: RoleInfo) {
    setFormName(role.name)
    setFormError(null)
    setRenameTarget(role)
  }

  async function handleRenameSubmit() {
    if (!renameTarget) return
    const name = formName.trim()
    if (!name) {
      setFormError(t('roleFormDialog.nameRequired'))
      return
    }
    setFormBusy(true)
    setFormError(null)
    try {
      const { role: updated } = await permissionsApi.updateRole(renameTarget.id, { name })
      setRoles((prev) =>
        prev.map((r) => (r.id === renameTarget.id ? { ...r, name: updated.name, updatedAt: updated.updatedAt } : r)),
      )
      setRenameTarget(null)
      toast({
        title: t('toasts.roleRenamedTitle'),
        description: t('toasts.roleRenamedDescription', { name: updated.name }),
        variant: 'success',
      })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ROLE_NAME_TAKEN') {
        setFormError(t('errors:ROLE_NAME_TAKEN', { name }))
      } else {
        setFormError(getUserErrorMessage(error, t('toasts.unknownError')))
      }
    } finally {
      setFormBusy(false)
    }
  }

  function openDeleteDialog(role: RoleInfo) {
    setReassignTo('')
    setDeleteError(null)
    setDeleteTarget(role)
  }

  async function handleDeleteSubmit() {
    if (!deleteTarget) return
    if (deleteTarget.memberCount > 0 && !reassignTo) {
      setDeleteError(t('errors:ROLE_HAS_MEMBERS', { count: deleteTarget.memberCount }))
      return
    }
    // Computed here, not earlier -- the two guard clauses above can return
    // without deleting anything (dialog stays open, waiting on a
    // reassignment choice), and only an attempt that's actually about to
    // remove the column should claim a focus target.
    const index = roles.findIndex((r) => r.id === deleteTarget.id)
    const neighborId = roles[index + 1]?.id ?? roles[index - 1]?.id
    pendingFocusTargetRef.current = neighborId ?? 'fallback'

    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const result = await permissionsApi.deleteRole(deleteTarget.id, reassignTo || undefined)
      const targetRole = roles.find((r) => r.id === reassignTo)
      setRoles((prev) =>
        prev
          .filter((r) => r.id !== deleteTarget.id)
          .map((r) => (reassignTo && r.id === reassignTo ? { ...r, memberCount: r.memberCount + result.reassigned } : r)),
      )
      toast({
        title: t('toasts.roleDeletedTitle'),
        description: targetRole
          ? t('toasts.roleDeletedReassignedDescription', { name: deleteTarget.name, target: targetRole.name })
          : t('toasts.roleDeletedDescription', { name: deleteTarget.name }),
        variant: 'success',
      })
      setDeleteTarget(null)
      if (result.reassigned > 0) fetchUsers()
    } catch (error) {
      // The column survived and the dialog stays open -- nothing to
      // restore focus to yet.
      pendingFocusTargetRef.current = null
      if (error instanceof ApiError && error.code === 'ROLE_LOCKOUT_LAST_MANAGER') {
        const nextCapabilities = reassignTo ? roles.find((r) => r.id === reassignTo)?.capabilities || [] : []
        const actionKey = recoveryActionKey(deleteTarget.capabilities, nextCapabilities)
        const action = actionKey ? t(actionKey) : ''
        setDeleteError(t('errors:ROLE_LOCKOUT_LAST_MANAGER', { action }))
      } else if (error instanceof ApiError && error.code === 'ROLE_HAS_MEMBERS') {
        setDeleteError(t('errors:ROLE_HAS_MEMBERS', { count: deleteTarget.memberCount }))
      } else {
        setDeleteError(getUserErrorMessage(error, t('toasts.unknownError')))
      }
    } finally {
      setDeleteBusy(false)
    }
  }

  function getRoleForUser(user: ManagedUserAccount): RoleInfo | undefined {
    return roles.find((r) => (user.roleId ? r.id === user.roleId : r.name === user.role))
  }

  async function handleAssignRole(user: ManagedUserAccount, roleId: string) {
    const currentRole = getRoleForUser(user)
    if (currentRole?.id === roleId) return
    setSavingUserRows((prev) => new Set(prev).add(user.id))
    try {
      const { user: updated } = await usersApi.assignRole(user.id, roleId)
      setUsers((prev) =>
        prev ? prev.map((u) => (u.id === user.id ? { ...u, role: updated.role, roleId: updated.roleId } : u)) : prev,
      )
      const newRole = roles.find((r) => r.id === roleId)
      toast({
        title: t('toasts.userRoleAssignedTitle'),
        description: t('toasts.userRoleAssignedDescription', {
          username: user.username,
          role: newRole?.name || updated.role,
        }),
        variant: 'success',
      })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ROLE_LOCKOUT_LAST_MANAGER') {
        const targetRole = roles.find((r) => r.id === roleId)
        const actionKey = recoveryActionKey(currentRole?.capabilities || [], targetRole?.capabilities || [])
        const action = actionKey ? t(actionKey) : ''
        toast({
          title: t('toasts.actionFailedTitle'),
          description: t('errors:ROLE_LOCKOUT_LAST_MANAGER', { action }),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('toasts.actionFailedTitle'),
          description: getUserErrorMessage(error, t('toasts.unknownError')),
          variant: 'destructive',
        })
      }
    } finally {
      setSavingUserRows((prev) => {
        const next = new Set(prev)
        next.delete(user.id)
        return next
      })
    }
  }

  if (loading) {
    // Inside Settings the page header is already there ("Settings › Roles &
    // Permissions"): a compact matrix skeleton, not a second page skeleton.
    return embedded ? (
      <div role="status" aria-busy="true" aria-label={t('loading')} className="rounded-xl border border-border/60 bg-card">
        <div className="flex gap-4 border-b border-border/40 bg-muted/40 p-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border/30 p-3 last:border-0">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="ms-auto h-4 w-4" />
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-4" />
          </div>
        ))}
      </div>
    ) : (
      <PageSkeleton variant="list" title={t('pageHeader.title')} description={t('pageHeader.description')} />
    )
  }

  return (
    <div className={embedded ? 'space-y-6' : 'space-y-6 page-transition'}>
      {!embedded && (
        <PageHeader title={t('pageHeader.title')} description={t('pageHeader.description')} />
      )}

      {/* Account and role changes wait for panel logins (server/middleware/
          requireLoginsOn.js): made while they are off, they would outlive it. The
          public demo runs with logins off and mocks every write: no note there. */}
      {!authEnabled && !isDemoMode() && !permissionDenied && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{t('errors:ACCOUNT_CHANGES_NEED_LOGINS')}</AlertDescription>
        </Alert>
      )}

      {permissionDenied ? (
        <EmptyState
          type="accessDenied"
          icon={<ShieldAlert className="h-14 w-14 text-muted-foreground/40" />}
          title={t('permissionDenied.title')}
          description={t('permissionDenied.description')}
        />
      ) : loadError ? (
        <EmptyState
          type="noData"
          title={t('loadError.title')}
          description={loadError}
          action={{ label: t('loadError.retry'), onClick: fetchMatrix }}
        />
      ) : (
        <>
          <SectionCard
            flush
            icon={ShieldCheck}
            title={t('matrix.title')}
            description={embedded ? t('pageHeader.description') : undefined}
            actions={
              <Button ref={addRoleButtonRef} size="sm" onClick={openCreateDialog}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('toolbar.newRole')}
              </Button>
            }
          >
              {roles.length > 1 && (
                <p className="border-b border-border/60 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground sm:hidden">
                  {t('matrix.scrollHint')}
                </p>
              )}
              <div className="max-h-[70vh] overflow-auto">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border/60">
                      <th className="label-micro sticky start-0 top-0 z-30 border-b border-border/60 bg-muted px-3 py-2 text-start align-top">
                        {t('matrix.capabilityColumnHeader')}
                      </th>
                      {roles.map((role) => (
                        <th key={role.id} className="sticky top-0 z-20 min-w-[170px] border-b border-border/60 bg-muted px-3 py-2 text-start align-top">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-foreground">{role.name}</span>
                            {role.isSeeded && (
                              <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase tracking-wide">
                                {t('matrix.seededBadge')}
                              </Badge>
                            )}
                          </div>
                          <div className="mt-1 flex items-center justify-between gap-2">
                            <span className="text-xs font-normal text-muted-foreground">
                              {t('matrix.memberCount', { count: role.memberCount })}
                            </span>
                            <div className="flex items-center gap-1">
                              {/* pz-pam-r23: a seeded (built-in) role's
                                  rename ALWAYS fails server-side
                                  (ROLE_SEEDED_RENAME_REFUSED -- see
                                  permissions.js's updateRole()), but this
                                  button used to stay fully enabled with no
                                  hint why, letting the operator open the
                                  dialog, type a name, and only find out on
                                  submit. Explain it up front instead -- but
                                  aria-disabled + DisabledReason, NOT the
                                  disabled attribute: this is deliberately
                                  the one button on a seeded role's column
                                  that must stay focusable (see the
                                  roleHeaderButtonRefs comment above --
                                  delete is genuinely disabled for a seeded
                                  role, so Rename is the only reliable
                                  focus-restore target after a delete
                                  elsewhere in the matrix). */}
                              <DisabledReason reason={role.isSeeded ? t('matrix.renameSeededTooltip') : null}>
                                <Button
                                  ref={(el) => {
                                    if (el) roleHeaderButtonRefs.current.set(role.id, el)
                                    else roleHeaderButtonRefs.current.delete(role.id)
                                  }}
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6"
                                  title={role.isSeeded ? undefined : t('matrix.renameTooltip')}
                                  aria-label={t('matrix.renameTooltip')}
                                  aria-disabled={role.isSeeded || undefined}
                                  onClick={() => {
                                    if (role.isSeeded) return
                                    openRenameDialog(role)
                                  }}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                              </DisabledReason>
                              {role.isSeeded ? (
                                <span title={t('matrix.deleteSeededTooltip')}>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground/40"
                                    disabled
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </span>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 text-destructive hover:text-destructive"
                                  title={t('matrix.deleteTooltip')}
                                  aria-label={t('matrix.deleteTooltip')}
                                  onClick={() => openDeleteDialog(role)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => {
                      const collapsed = collapsedGroups.has(group.group)
                      return (
                      <Fragment key={group.group}>
                        <tr className="border-t border-border/50 bg-muted/30">
                          <td colSpan={roles.length + 1} className="sticky start-0 bg-muted/30 p-0">
                            <button
                              type="button"
                              onClick={() => toggleGroup(group.group)}
                              aria-expanded={!collapsed}
                              className="flex w-full items-center gap-1.5 px-3 py-2 text-start text-xs font-semibold uppercase tracking-wide text-foreground/70 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
                            >
                              <ChevronDown
                                className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${collapsed ? '-rotate-90' : ''}`}
                                aria-hidden="true"
                              />
                              {groupLabel(group.group)}
                              {collapsed && (
                                <span className="font-normal normal-case tracking-normal text-muted-foreground/80">
                                  ({t('matrix.capabilityCount', { count: group.capabilities.length })})
                                </span>
                              )}
                            </button>
                          </td>
                        </tr>
                        {!collapsed && group.capabilities.map((cap) => (
                          <tr key={cap.key} className="border-b border-border/30 last:border-0 hover:bg-muted/10">
                            <td className="sticky start-0 z-10 bg-card px-3 py-2 align-middle">
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium text-foreground">{capabilityLabel(cap)}</span>
                                {/* impeccable-2026-08-31: this used to be a permanently-visible
                                    paragraph under the label -- 3-6 lines per row, the reason the
                                    matrix ran to 3555px on first load. The name already carries the
                                    headline risk signal ("Wipe the world"); the paragraph is
                                    decision-time elaboration, which is exactly what HelpTip is for.
                                    Same information, on demand instead of permanent -- "dense by
                                    default, help on demand," not information removed. */}
                                <HelpTip label={capabilityLabel(cap)}>{capabilityDescription(cap)}</HelpTip>
                                {HOST_ACCESS_CAPABILITY_KEYS.has(cap.key) && (
                                  <span title={t('matrix.hostAccessHint')}>
                                    <ShieldAlert className="h-3 w-3 shrink-0 text-warning" aria-label={t('matrix.hostAccessHint')} />
                                  </span>
                                )}
                                {RECOVERY_CAPABILITY_KEYS.has(cap.key) && (
                                  <span title={t('matrix.recoveryCapabilityHint')}>
                                    <Lock
                                      className="h-3 w-3 shrink-0 text-warning"
                                      aria-label={t('matrix.recoveryCapabilityHint')}
                                    />
                                  </span>
                                )}
                              </div>
                            </td>
                            {roles.map((role) => {
                              const cellKey = `${role.id}:${cap.key}`
                              const checked = role.capabilities.includes(cap.key)
                              const busy = savingCells.has(cellKey)
                              return (
                                <td key={role.id} className="px-3 py-2 text-center align-middle">
                                  {busy ? (
                                    <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                                  ) : (
                                    <Checkbox
                                      checked={checked}
                                      onCheckedChange={(value) => handleToggleCapability(role, cap, value === true)}
                                      aria-label={`${role.name}: ${capabilityLabel(cap)}`}
                                    />
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                      </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
          </SectionCard>

          <SectionCard
            icon={UsersIcon}
            title={t('userAssignment.title')}
            description={t('userAssignment.description')}
          >
              {usersDenied ? (
                <EmptyState
                  compact
                  type="accessDenied"
                  icon={<ShieldAlert className="h-10 w-10 text-muted-foreground/40" />}
                  title={t('userAssignment.permissionDenied.title')}
                  description={t('userAssignment.permissionDenied.description')}
                />
              ) : usersLoadError ? (
                <EmptyState
                  compact
                  type="noData"
                  title={t('loadError.title')}
                  description={usersLoadError}
                  action={{ label: t('loadError.retry'), onClick: fetchUsers }}
                />
              ) : !users ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : users.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('userAssignment.noUsers')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border/60 text-start">
                        <th className="label-micro px-3 py-2 text-start">{t('userAssignment.usernameColumn')}</th>
                        <th className="label-micro px-3 py-2 text-start">{t('userAssignment.roleColumn')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => {
                        const currentRole = getRoleForUser(user)
                        const busy = savingUserRows.has(user.id)
                        return (
                          <tr key={user.id} className="border-b border-border/30 last:border-0">
                            <td className="px-3 py-2 font-medium">{user.username}</td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <Select
                                  value={currentRole?.id ?? ''}
                                  onValueChange={(value) => handleAssignRole(user, value)}
                                  disabled={busy}
                                >
                                  <SelectTrigger className="h-9 w-56">
                                    <SelectValue placeholder={t('userAssignment.rolePlaceholder')} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {roles.map((role) => (
                                      <SelectItem key={role.id} value={role.id}>
                                        {role.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                {busy && (
                                  <span className="text-xs text-muted-foreground">{t('userAssignment.savingRow')}</span>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </SectionCard>
        </>
      )}

      <Dialog open={createOpen} onOpenChange={(open) => !open && setCreateOpen(false)}>
        {/* 2026-09 dialog sweep: all 30 capabilities scrolled as a whole
            under this dialog's own 85vh cap, so Create role and Cancel (and
            the title) were off-screen at every size. Only the DialogBody
            scrolls now, under DialogContent's own bound; a failed create's
            error sits right above the buttons. */}
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('roleFormDialog.createTitle')}</DialogTitle>
            <DialogDescription>{t('roleFormDialog.createDescription')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-role-name">{t('roleFormDialog.nameLabel')}</Label>
              <Input
                id="new-role-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={t('roleFormDialog.namePlaceholder')}
              />
            </div>
            <div className="space-y-3">
              {groups.map((group) => (
                <div key={group.group}>
                  <p className="label-micro mb-1.5">
                    {groupLabel(group.group)}
                  </p>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {group.capabilities.map((cap) => (
                      <label key={cap.key} className="flex items-start gap-2 text-sm">
                        <Checkbox
                          className="mt-0.5"
                          checked={formCapabilities.has(cap.key)}
                          onCheckedChange={(value) =>
                            setFormCapabilities((prev) => {
                              const next = new Set(prev)
                              if (value === true) next.add(cap.key)
                              else next.delete(cap.key)
                              return next
                            })
                          }
                        />
                        <span>{capabilityLabel(cap)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </DialogBody>
          {formError && <p className="text-sm text-destructive [overflow-wrap:anywhere]">{formError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={formBusy}>
              {t('roleFormDialog.cancel')}
            </Button>
            <Button onClick={handleCreateSubmit} disabled={formBusy}>
              {formBusy ? t('roleFormDialog.creating') : t('roleFormDialog.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('roleFormDialog.renameTitle', { name: renameTarget?.name })}</DialogTitle>
            <DialogDescription>{t('roleFormDialog.renameDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="rename-role-name">{t('roleFormDialog.nameLabel')}</Label>
            <Input id="rename-role-name" value={formName} onChange={(e) => setFormName(e.target.value)} />
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)} disabled={formBusy}>
              {t('roleFormDialog.cancel')}
            </Button>
            <Button onClick={handleRenameSubmit} disabled={formBusy}>
              {formBusy ? t('roleFormDialog.saving') : t('roleFormDialog.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('deleteRoleDialog.title', { name: deleteTarget?.name })}</DialogTitle>
            <DialogDescription>
              {deleteTarget && deleteTarget.memberCount > 0
                ? t('deleteRoleDialog.descriptionWithMembers', { count: deleteTarget.memberCount })
                : t('deleteRoleDialog.descriptionNoMembers')}
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && deleteTarget.memberCount > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label>{t('deleteRoleDialog.reassignLabel')}</Label>
                <HelpTip label={t('deleteRoleDialog.reassignLabel')}>
                  {t('deleteRoleDialog.reassignTip')}
                </HelpTip>
              </div>
              <Select value={reassignTo} onValueChange={setReassignTo}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={t('deleteRoleDialog.reassignPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {roles
                    .filter((r) => r.id !== deleteTarget.id)
                    .map((r) => {
                      const blockedReason = reassignTargetBlockedReason(r)
                      return (
                        <DisabledReason key={r.id} reason={blockedReason} className="w-full">
                          <SelectItem value={r.id} disabled={!!blockedReason}>
                            {r.name}
                          </SelectItem>
                        </DisabledReason>
                      )
                    })}
                </SelectContent>
              </Select>
            </div>
          )}
          {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
              {t('deleteRoleDialog.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDeleteSubmit} disabled={deleteBusy}>
              {deleteBusy ? t('deleteRoleDialog.confirming') : t('deleteRoleDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
