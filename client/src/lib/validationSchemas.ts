import { z } from 'zod'

// ============================================================================
// Common validation schemas
// ============================================================================

/**
 * Common string validations
 */
export const requiredString = z.string().min(1, 'This field is required')
export const optionalString = z.string().optional()

/**
 * Username validation
 */
export const usernameSchema = z
  .string()
  .min(1, 'Username is required')
  .max(50, 'Username must be 50 characters or less')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Username can only contain letters, numbers, underscores, and hyphens')

/**
 * Password validation
 */
export const passwordSchema = z
  .string()
  .min(4, 'Password must be at least 4 characters')
  .max(100, 'Password must be 100 characters or less')

/**
 * Server name validation
 */
export const serverNameSchema = z
  .string()
  .min(1, 'Server name is required')
  .max(50, 'Server name must be 50 characters or less')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Server name can only contain letters, numbers, underscores, and hyphens')

/**
 * Port validation
 */
export const portSchema = z
  .number()
  .int('Port must be a whole number')
  .min(1, 'Port must be at least 1')
  .max(65535, 'Port must be 65535 or less')

/**
 * RCON password validation
 */
export const rconPasswordSchema = z
  .string()
  .min(6, 'RCON password must be at least 6 characters')
  .max(100, 'RCON password must be 100 characters or less')

/**
 * Memory (in GB) validation
 */
export const memoryGBSchema = z
  .number()
  .int('Memory must be a whole number')
  .min(1, 'Memory must be at least 1 GB')
  .max(128, 'Memory must be 128 GB or less')

/**
 * File path validation
 */
export const filePathSchema = z
  .string()
  .min(1, 'Path is required')
  .refine(
    (path) => !path.includes('..'),
    'Path cannot contain ".."'
  )

/**
 * Cron expression validation
 */
export const cronSchema = z
  .string()
  .min(1, 'Cron expression is required')
  .regex(
    /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/,
    'Invalid cron expression format (expected: "* * * * *")'
  )

/**
 * Workshop ID validation
 */
export const workshopIdSchema = z
  .string()
  .min(1, 'Workshop ID is required')
  .regex(/^\d+$/, 'Workshop ID must be a number')

/**
 * Discord ID (snowflake) validation
 */
export const discordIdSchema = z
  .string()
  .regex(/^\d{17,19}$/, 'Invalid Discord ID format (should be 17-19 digit number)')

/**
 * Optional Discord ID
 */
export const optionalDiscordIdSchema = z
  .string()
  .refine(
    (val) => !val || /^\d{17,19}$/.test(val),
    'Invalid Discord ID format (should be 17-19 digit number)'
  )
  .optional()
  .or(z.literal(''))

/**
 * IP address validation
 */
export const ipAddressSchema = z
  .string()
  .regex(
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
    'Invalid IP address format'
  )

/**
 * Coordinates validation
 */
export const coordinateSchema = z
  .string()
  .regex(/^-?\d+$/, 'Coordinate must be a number')

// ============================================================================
// Form schemas for specific features
// ============================================================================

/**
 * Add User form (Players page)
 */
export const addUserFormSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
})
export type AddUserFormData = z.infer<typeof addUserFormSchema>

/**
 * Kick player form
 */
export const kickPlayerFormSchema = z.object({
  reason: z.string().max(200, 'Reason must be 200 characters or less').optional(),
})
export type KickPlayerFormData = z.infer<typeof kickPlayerFormSchema>

/**
 * Ban player form
 */
export const banPlayerFormSchema = z.object({
  reason: z.string().max(200, 'Reason must be 200 characters or less').optional(),
  banIp: z.boolean().default(false),
})
export type BanPlayerFormData = z.infer<typeof banPlayerFormSchema>

/**
 * Teleport form
 */
export const teleportFormSchema = z.object({
  x: coordinateSchema,
  y: coordinateSchema,
  z: z.string().regex(/^-?\d+$/, 'Z must be a number').default('0'),
})
export type TeleportFormData = z.infer<typeof teleportFormSchema>

/**
 * Add mod form
 */
export const addModFormSchema = z.object({
  workshopId: workshopIdSchema,
  modLoadId: z.string().optional(),
})
export type AddModFormData = z.infer<typeof addModFormSchema>

/**
 * Scheduler task form
 */
export const schedulerTaskFormSchema = z.object({
  name: requiredString.max(100, 'Name must be 100 characters or less'),
  cronExpression: cronSchema,
  command: requiredString.max(500, 'Command must be 500 characters or less'),
})
export type SchedulerTaskFormData = z.infer<typeof schedulerTaskFormSchema>

/**
 * Server setup form
 */
export const serverSetupFormSchema = z.object({
  steamcmdPath: filePathSchema,
  installPath: filePathSchema,
  serverName: serverNameSchema,
  rconPassword: rconPasswordSchema,
  rconPort: portSchema,
  serverPort: portSchema,
  minMemory: memoryGBSchema,
  maxMemory: memoryGBSchema,
  adminPassword: z.string().optional(),
  useNoSteam: z.boolean().default(false),
  useDebug: z.boolean().default(false),
}).refine(
  (data) => data.maxMemory >= data.minMemory,
  {
    message: 'Max memory must be greater than or equal to min memory',
    path: ['maxMemory'],
  }
)
export type ServerSetupFormData = z.infer<typeof serverSetupFormSchema>

/**
 * Discord configuration form
 */
export const discordConfigFormSchema = z.object({
  token: z.string().min(1, 'Bot token is required'),
  guildId: discordIdSchema,
  adminRoleId: optionalDiscordIdSchema,
  channelId: optionalDiscordIdSchema,
})
export type DiscordConfigFormData = z.infer<typeof discordConfigFormSchema>

/**
 * Server instance form (for adding/editing servers)
 */
export const serverInstanceFormSchema = z.object({
  name: requiredString.max(100, 'Name must be 100 characters or less'),
  serverName: serverNameSchema,
  installPath: filePathSchema,
  zomboidDataPath: z.string().optional(),
  rconHost: z.string().default('127.0.0.1'),
  rconPort: portSchema,
  rconPassword: z.string().min(1, 'RCON password is required'),
  serverPort: portSchema,
  minMemory: z.number().min(512, 'Min memory must be at least 512 MB'),
  maxMemory: z.number().min(1024, 'Max memory must be at least 1024 MB'),
  useNoSteam: z.boolean().default(false),
  useDebug: z.boolean().default(false),
}).refine(
  (data) => data.maxMemory >= data.minMemory,
  {
    message: 'Max memory must be greater than or equal to min memory',
    path: ['maxMemory'],
  }
)
export type ServerInstanceFormData = z.infer<typeof serverInstanceFormSchema>

/**
 * Announcement form
 */
export const announcementFormSchema = z.object({
  message: z
    .string()
    .min(1, 'Message is required')
    .max(500, 'Message must be 500 characters or less'),
})
export type AnnouncementFormData = z.infer<typeof announcementFormSchema>

/**
 * RCON command form
 */
export const rconCommandFormSchema = z.object({
  command: requiredString.max(1000, 'Command must be 1000 characters or less'),
})
export type RconCommandFormData = z.infer<typeof rconCommandFormSchema>

// ============================================================================
// Helper for creating error messages from zod errors
// ============================================================================

export function getZodErrorMessage(error: z.ZodError): string {
  return error.issues.map(e => e.message).join(', ')
}

/**
 * Get the first error message from a zod error
 */
export function getFirstZodError(error: z.ZodError): string {
  return error.issues[0]?.message || 'Validation failed'
}
