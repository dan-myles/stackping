import type { SlackClient } from "../destinations/slack/client.ts"
import type { ProfileLookup } from "../destinations/slack/destination.ts"
import type { Store } from "./store.ts"

import { BudgetExhausted } from "./budget.ts"

const PROFILE_TTL_MS = 24 * 60 * 60 * 1000

/** Slack display names and avatars, cached for a day. */
export function cachedProfileLookup(
  store: Store,
  client: SlackClient,
  now: () => number,
): ProfileLookup {
  return async (userId) => {
    const cached = store.getProfile(userId)
    if (cached && now() - cached.fetchedAt < PROFILE_TTL_MS) {
      return cached.name
        ? { name: cached.name, avatarUrl: cached.avatarUrl }
        : null
    }
    try {
      const profile = await client.userProfile(userId)
      store.saveProfile(
        userId,
        { name: profile?.name ?? null, avatarUrl: profile?.avatarUrl ?? null },
        now(),
      )
      return profile
    } catch (error) {
      if (error instanceof BudgetExhausted) throw error
      // Missing `users:read` or an unknown user: fall back to GitHub identity.
      store.saveProfile(userId, { name: null, avatarUrl: null }, now())
      return null
    }
  }
}
