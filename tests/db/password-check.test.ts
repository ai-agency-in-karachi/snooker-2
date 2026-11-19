/**
 * The administrator password re-check (migration 2100): a wrong password
 * costs two seconds and checks for one account run one at a time, so
 * parallel requests cannot multiply the guesses.
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { TestDb, rejects, type TestUser } from './harness'

let db: TestDb
let admin: TestUser

beforeEach(async () => {
  db = await TestDb.create()
  admin = await db.createUser('admin')
})
afterEach(async () => db.close())

it('makes each wrong guess cost two seconds, one account check at a time', async () => {
  const started = Date.now()
  expect((await rejects(db.rpc(admin.id, 'admin_export_business_data', { p_password: 'guess-1' }))).hint).toBe('wrong_password')
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
  const [fn] = await db.sql<{ d: string }>(`select pg_get_functiondef('public.fusion_require_admin_password(text)'::regprocedure) d`)
  // Parallel requests for the same account queue on this lock (held until each request ends).
  expect(fn!.d).toMatch(/pg_advisory_xact_lock\(7317, pg_catalog\.hashtext\(v_me\.id::text\)\)/)
})
