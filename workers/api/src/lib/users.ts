import type { User } from '@waterlog/schema'

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  return db
    .prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first<User>()
}

/** Create-or-link on the email column: both magic link and Google OAuth
 * resolve to the same user for the same address. */
export async function getOrCreateUserByEmail(db: D1Database, rawEmail: string): Promise<User> {
  const email = rawEmail.trim().toLowerCase()
  const existing = await db
    .prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL')
    .bind(email)
    .first<User>()
  if (existing) return existing

  const now = Date.now()
  const user: User = {
    id: crypto.randomUUID(),
    email,
    display_name: null,
    home_lat: null,
    home_lng: null,
    units: 'imperial',
    tier: 'free',
    stripe_customer_id: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }
  await db
    .prepare(
      'INSERT INTO users (id, email, display_name, home_lat, home_lng, units, tier, stripe_customer_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      user.id,
      user.email,
      user.display_name,
      user.home_lat,
      user.home_lng,
      user.units,
      user.tier,
      user.stripe_customer_id,
      user.created_at,
      user.updated_at,
      user.deleted_at,
    )
    .run()
  return user
}
