/**
 * The whole API surface, swept automatically (migration 2300). security.test.ts
 * and security-hardening.test.ts check chosen cases; this suite enumerates
 * every table, sequence, policy and callable function from the catalog, on a
 * database built with Supabase's own default privileges (see harness), so a
 * future migration that forgets a revoke or a caller check fails here:
 *
 *  - every table has Row Level Security, and every policy targets
 *    `authenticated` only;
 *  - `anon` can read, write or execute nothing in `public`;
 *  - `authenticated` has SELECT (through RLS) and no other privilege on any
 *    table or sequence — every write goes through a database function;
 *  - every function pins its search_path;
 *  - every callable function refuses a signed-in login without an active
 *    FUSION profile (self-registered or deactivated), and every
 *    administration function refuses staff;
 *  - staff are isolated from other staff, other floors and admin-only data;
 *  - nobody can promote themselves or remove the last administrator.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestDb, rejects, seedClub, type TestUser } from './harness'

let db: TestDb
let club: Awaited<ReturnType<typeof seedClub>>
let admin: TestUser
let ali: TestUser // staff, ground floor
let sara: TestUser // staff, ground floor
let firstFloor: TestUser // staff, first floor
let retired: TestUser // deactivated admin
let stranger: string // a Supabase Auth login with no FUSION profile

beforeAll(async () => {
  db = await TestDb.create()
  club = await seedClub(db)
  admin = await db.createUser('admin')
  ali = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['counter_sale', 'view_own_sales'] })
  sara = await db.createUser('staff', { floorId: club.floors.ground, permissions: ['counter_sale', 'view_own_sales'] })
  firstFloor = await db.createUser('staff', { floorId: club.floors.first })
  retired = await db.createUser('admin', { active: false })
  stranger = randomUUID()
  await db.sql(`insert into auth.users (id, email) values ($1, 'signup@example.com')`, [stranger])

  // Sara trades on her own counter: an expense the others must never see.
  await db.openCounter(sara.id)
  await db.rpc(sara.id, 'add_expense', { p_client_ref: randomUUID(), p_amount: 25, p_description: 'Ice' })
})
afterAll(async () => db.close())

const publicTables = async () =>
  (await db.sql<{ t: string }>(
    `select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`
  )).map((r) => r.t)

/** Every function `authenticated` may execute, with a call passing NULL for each argument. */
const callableFunctions = async () =>
  db.sql<{ name: string; call: string }>(
    `select p.proname as name,
            format('select public.%I(%s)', p.proname,
                   coalesce((select string_agg(format('null::%s', t::regtype), ', ' order by o)
                             from unnest(p.proargtypes::oid[]) with ordinality a(t, o)), '')) as call
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
     order by 1`
  )

/** Helpers RLS policies call, and harmless clock/date utilities: they answer for the caller only. */
const OPEN_HELPERS = new Set([
  'fusion_is_active_user',
  'fusion_is_admin',
  'fusion_has_perm',
  'fusion_can_access_floor',
  'fusion_can_access_table',
  'fusion_business_date',
  'get_server_time',
  'get_current_business_date'
])

/** Administration functions (docs/DATABASE.md): staff must be refused with `forbidden`. */
const ADMIN_ONLY = [
  'get_table_sales', 'get_financial_report', 'get_sales_by_hour', 'get_expenses', 'get_product_sales',
  'get_history', 'get_sales_report', 'list_open_business_dates', 'close_business_day', 'start_booking',
  'list_bookings', 'get_customer_rankings', 'get_retention_status', 'get_stock_adjustments',
  'admin_add_expense', 'admin_void_expense', 'admin_update_settings', 'admin_save_floor', 'admin_delete_floor',
  'admin_save_category', 'admin_delete_category', 'admin_save_table', 'admin_set_table_active',
  'admin_delete_table', 'admin_save_product', 'admin_set_product_active', 'admin_delete_product',
  'admin_set_product_image', 'admin_create_user_profile', 'admin_update_user', 'admin_set_user_active',
  'admin_check_user_deletable', 'admin_save_booking', 'admin_set_booking_status', 'admin_delete_booking',
  'admin_run_retention', 'admin_business_data_summary', 'admin_export_business_data',
  'admin_reset_business_data'
]

const asUser = <T = Record<string, unknown>>(id: string | null, sql: string, params: unknown[] = []) =>
  db.as(id, () => db.pg.query<T>(sql, params).then((r) => r.rows))

describe('database structure', () => {
  it('enables Row Level Security on every table', async () => {
    expect(
      await db.sql(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`)
    ).toEqual([])
  })

  it('applies every policy to signed-in accounts only (never anon or public)', async () => {
    const policies = await db.sql<{ roles: string[] }>(
      `select roles from pg_policies where schemaname = 'public'
       or (schemaname = 'storage' and policyname like 'fusion %')`
    )
    expect(policies.length).toBeGreaterThan(20)
    for (const p of policies) expect(p.roles).toEqual(['authenticated'])
  })

  it('pins search_path on every function', async () => {
    expect(
      await db.sql(`select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`)
    ).toEqual([])
  })

  it('has no views that could bypass Row Level Security', async () => {
    expect(await db.sql(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'public' and relkind in ('v', 'm')`)).toEqual([])
  })
})

describe('privileges of the API roles', () => {
  it('gives anon nothing: no table, sequence or function', async () => {
    expect(
      await db.sql(`select table_name, privilege_type from information_schema.role_table_grants
                    where table_schema = 'public' and grantee in ('anon', 'PUBLIC')`)
    ).toEqual([])
    expect(
      await db.sql(`select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`)
    ).toEqual([])
    for (const t of await publicTables()) {
      const err = await rejects(asUser(null, `select 1 from public.${t} limit 1`))
      expect(err.message, t).toMatch(/permission denied/)
    }
  })

  it('gives signed-in accounts SELECT only: no table can be written directly, not even by an admin', async () => {
    expect(
      await db.sql(`select table_name, privilege_type from information_schema.role_table_grants
                    where table_schema = 'public' and grantee = 'authenticated' and privilege_type <> 'SELECT'`)
    ).toEqual([])
    for (const t of await publicTables()) {
      const col = await firstColumn(t)
      for (const stmt of [
        `delete from public.${t} where false`,
        `update public.${t} set ${col} = ${col} where false`,
        `insert into public.${t} (${col}) select ${col} from public.${t} where false`
      ]) {
        const err = await rejects(asUser(admin.id, stmt))
        expect(err.message, `${t}: ${stmt}`).toMatch(/permission denied/)
      }
    }
  })

  it('gives the API roles no sequence privileges (every insert runs inside a database function)', async () => {
    const sequences = await db.sql<{ s: string }>(
      `select c.relname s from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'S'`
    )
    expect(sequences.length).toBeGreaterThan(0)
    for (const { s } of sequences) {
      for (const role of ['anon', 'authenticated']) {
        expect(
          (await db.one<{ ok: boolean }>(`select has_sequence_privilege($1, $2, 'USAGE,SELECT,UPDATE') ok`, [role, `public.${s}`])).ok,
          `${role} on ${s}`
        ).toBe(false)
      }
    }
    expect((await rejects(asUser(admin.id, `select nextval('public.stock_adjustments_id_seq')`))).message).toMatch(/permission denied/)
  })
})

async function firstColumn(table: string): Promise<string> {
  const [col] = await db.sql<{ c: string }>(
    `select quote_ident(column_name) c from information_schema.columns
     where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER'
       and coalesce(identity_generation, '') <> 'ALWAYS'
     order by ordinal_position limit 1`,
    [table]
  )
  return col!.c
}

describe('functions', () => {
  it('refuses a signed-in login that has no FUSION profile (e.g. a self sign-up) in every function', async () => {
    const fns = await callableFunctions()
    expect(fns.length).toBeGreaterThan(70)
    for (const fn of fns) {
      if (OPEN_HELPERS.has(fn.name)) continue
      const err = await rejects(asUser(stranger, fn.call))
      expect(err.hint, fn.call).toBe('not_authenticated')
    }
  })

  it('refuses a deactivated account — even an administrator — in every function, immediately', async () => {
    for (const fn of await callableFunctions()) {
      if (OPEN_HELPERS.has(fn.name)) continue
      const err = await rejects(asUser(retired.id, fn.call))
      expect(err.hint, fn.call).toBe('not_authenticated')
    }
  })

  it('answers the policy helpers with "no" for a login without an active profile', async () => {
    for (const who of [stranger, retired.id]) {
      const [row] = await asUser<Record<string, boolean>>(
        who,
        `select public.fusion_is_active_user() a, public.fusion_is_admin() b, public.fusion_has_perm('counter_sale') c,
                public.fusion_can_access_floor($1::smallint) d, public.fusion_can_access_table($2::uuid) e`,
        [club.floors.ground, club.tables.snooker1]
      )
      expect(row).toEqual({ a: false, b: false, c: false, d: false, e: false })
    }
  })

  it('refuses staff in every administration function', async () => {
    const callable = new Map((await callableFunctions()).map((f) => [f.name, f.call]))
    for (const name of ADMIN_ONLY) {
      const call = callable.get(name)
      expect(call, `${name} should be callable by signed-in accounts`).toBeDefined()
      const err = await rejects(asUser(ali.id, call!))
      expect(err.hint, call).toBe('forbidden')
    }
  })

  it('keeps internal helpers and the scheduler entry point out of the API', async () => {
    for (const name of ['fusion_run_retention', 'fusion_retention_job', 'fusion_require_user', 'fusion_require_admin',
                        'fusion_session_charge', 'fusion_amount_for_minutes', 'fusion_billed_minutes']) {
      const [row] = await db.sql<{ n: number }>(
        `select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = $1 and has_function_privilege('authenticated', p.oid, 'execute')`,
        [name]
      )
      expect(row!.n, name).toBe(0)
    }
  })
})

describe('row level isolation', () => {
  const count = async (who: string, sql: string, params: unknown[] = []) =>
    Number((await asUser<{ n: string }>(who, `select count(*) n from ${sql}`, params))[0]!.n)

  it('shows staff only their own profile; a deactivated account sees none, not even its own', async () => {
    expect(await asUser(ali.id, `select id from public.app_users`)).toEqual([{ id: ali.id }])
    expect(await asUser(retired.id, `select id from public.app_users`)).toEqual([])
    expect(await asUser(stranger, `select id from public.app_users`)).toEqual([])
    expect(await count(admin.id, `public.app_users`)).toBe(5)
  })

  it('never shows staff another staff member’s counter, ledger or expenses', async () => {
    for (const t of ['counter_shifts', 'shift_daily_totals', 'expenses']) {
      expect(await count(sara.id, `public.${t}`), `sara ${t}`).toBeGreaterThan(0)
      expect(await count(ali.id, `public.${t}`), `ali ${t}`).toBe(0)
      expect(await count(admin.id, `public.${t}`), `admin ${t}`).toBeGreaterThan(0)
    }
    // Another staff member's shift does not even exist as far as Ali can tell.
    const detail = await rejects(db.rpc(ali.id, 'get_shift_detail', {
      p_shift_id: (await db.one<{ id: string }>(`select id from public.counter_shifts where user_id = $1`, [sara.id])).id
    }))
    expect(['forbidden', 'not_found']).toContain(detail.hint)
  })

  it('hides admin-only data from staff: cost prices, summaries, bookings, customer statistics, logs', async () => {
    for (const t of ['inventory_products', 'daily_summaries', 'bookings', 'customer_visits', 'retention_runs',
                     'sync_operations', 'customers']) {
      expect(await count(ali.id, `public.${t}`), t).toBe(0)
    }
    expect(await count(admin.id, `public.inventory_products`)).toBe(3)
  })

  it('limits staff to their own floor', async () => {
    expect(await asUser(ali.id, `select name from public.club_tables`)).toEqual([{ name: 'Snooker 1' }])
    expect(await asUser(firstFloor.id, `select name from public.club_tables`)).toEqual([{ name: 'Pool 1' }])
    expect((await rejects(db.rpc(ali.id, 'start_session', { p_table_id: club.tables.pool1 }))).hint).toBe('wrong_floor')
  })

  it('shows signed-out visitors and self sign-ups nothing at all', async () => {
    for (const t of await publicTables()) {
      const [grant] = await db.sql<{ ok: boolean }>(`select has_table_privilege('authenticated', $1, 'SELECT') ok`, [`public.${t}`])
      if (!grant!.ok) {
        // Tables read only through functions: no direct access at all.
        expect((await rejects(asUser(stranger, `select 1 from public.${t}`))).message, t).toMatch(/permission denied/)
        continue
      }
      expect(await count(stranger, `public.${t}`), t).toBe(0)
    }
  })
})

describe('account administration', () => {
  it('stops staff from promoting themselves or changing anyone', async () => {
    const err = await rejects(db.rpc(ali.id, 'admin_update_user', {
      p_user_id: ali.id, p_full_name: 'Ali', p_role: 'admin', p_floor_id: null, p_permissions: []
    }))
    expect(err.hint).toBe('forbidden')
    expect((await db.one<{ role: string }>(`select role from public.app_users where id = $1`, [ali.id])).role).toBe('staff')
  })

  it('never removes the last active administrator', async () => {
    const demote = await rejects(db.rpc(admin.id, 'admin_update_user', {
      p_user_id: admin.id, p_full_name: 'Owner', p_role: 'staff', p_floor_id: null, p_permissions: []
    }))
    expect(demote.hint).toBe('last_admin')
    expect((await rejects(db.rpc(admin.id, 'admin_set_user_active', { p_user_id: admin.id, p_active: false }))).hint).toBe('invalid_state')
    expect((await rejects(db.rpc(admin.id, 'admin_check_user_deletable', { p_user_id: admin.id }))).message).toBeTruthy()
  })

  it('refuses unknown permissions and roles', async () => {
    const bad = await rejects(db.rpc(admin.id, 'admin_update_user', {
      p_user_id: ali.id, p_full_name: 'Ali', p_role: 'staff', p_floor_id: null, p_permissions: ['superuser']
    }))
    expect(bad.hint).toBe('invalid_input')
    const role = await rejects(db.rpc(admin.id, 'admin_update_user', {
      p_user_id: ali.id, p_full_name: 'Ali', p_role: 'owner', p_floor_id: null, p_permissions: []
    }))
    expect(role.hint).toBe('invalid_input')
  })
})

describe('storage', () => {
  it('lets only administrators write product images; staff cannot write or list them', async () => {
    const product = club.products.cola
    await expect(asUser(ali.id, `insert into storage.objects (bucket_id, name) values ('product-images', $1)`, [`${product}/a.webp`]))
      .rejects.toThrow(/row-level security/)
    await asUser(admin.id, `insert into storage.objects (bucket_id, name) values ('product-images', $1)`, [`${product}/a.webp`])
    expect(await asUser(ali.id, `select name from storage.objects where bucket_id = 'product-images'`)).toEqual([])
    expect(await asUser(null, `select name from storage.objects`).catch(() => [])).toEqual([])
  })

  it('keeps every account’s avatar folder its own', async () => {
    await expect(asUser(ali.id, `insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${sara.id}/x.jpg`]))
      .rejects.toThrow(/row-level security/)
    await expect(asUser(stranger, `insert into storage.objects (bucket_id, name) values ('avatars', $1)`, [`${stranger}/x.jpg`]))
      .rejects.toThrow(/row-level security/)
  })
})
