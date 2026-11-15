import { z } from 'zod'

export const subscriptionProviderSchema = z.enum(['claude', 'codex'])
export type SubscriptionProvider = z.infer<typeof subscriptionProviderSchema>

export const subscriptionAccessSchema = z.object({ claude: z.boolean(), codex: z.boolean() }).strict()
export type SubscriptionAccess = z.infer<typeof subscriptionAccessSchema>

export const subscriptionLabelSchema = z.string().trim().min(1).max(100)
export const subscriptionUpdateSchema = z
  .object({
    label: subscriptionLabelSchema,
    enabled: z.boolean()
  })
  .strict()

export const subscriptionAccountSchema = z
  .object({
    id: z.string().min(1),
    provider: subscriptionProviderSchema,
    label: subscriptionLabelSchema,
    enabled: z.boolean(),
    state: z.enum(['disconnected', 'ready', 'rate_limited', 'auth_failed']),
    retryAt: z.number().nullable(),
    providerResetAt: z.number().nullable(),
    lastUsedAt: z.number().nullable(),
    assignedWorkspaces: z.number().int().nonnegative()
  })
  .strict()
export type SubscriptionAccount = z.infer<typeof subscriptionAccountSchema>
