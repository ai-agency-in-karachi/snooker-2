-- =============================================================================
-- FUSION 2200: game-by-game ledger on a table ("Off / On").
--
-- Friends play on one table for hours, "loser pays": after each frame the
-- counter presses Off / On and names who lost. That game's time and price are
-- logged on the table, unpaid, and the next game starts at once — the table
-- session keeps running. At checkout each player's games (and any snacks given
-- to them) are marked paid one by one, cash or bank; snacks nobody took are the
-- group's. When everything is paid the table closes as ONE invoice (cash, bank
-- or split), so History gets no stream of micro-receipts.
--
-- Impact on existing data: none. Two tables are added (session_games,
-- session_shares) and one nullable column (session_items.payer). Tables with
-- no games check out exactly as before.
--
--   * Open play on per-minute tables only (bookings and hourly prices are not
--     linear, so games could not add up to the table's price).
--   * A game's price is the table's charge at its end minus its charge at its
--     start (same billing, completed minutes): the games always add up exactly
--     to what the table bills, with no rounding gap.
--   * Offline: Off / On, giving snacks to a player, marking shares paid and the
--     final checkout are all floor actions uploaded through sync_operation(),
--     at the time they happened (fusion_now()).
-- =============================================================================

-- 1. The ledger ------------------------------------------------------------------------------------
create table public.session_games (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.sessions (id) on delete cascade,
  seq         integer not null check (seq > 0),
  player_name text not null check (char_length(player_name) between 1 and 40),
  started_at  timestamptz not null,
  ended_at    timestamptz not null,
  seconds     integer not null check (seconds >= 0),
  amount      numeric(12, 2) not null check (amount >= 0),
  -- The table's billable time and charge at the end of this game (the next game starts from them).
  billable_to integer not null check (billable_to >= 0),
  charge_to   numeric(12, 2) not null check (charge_to >= 0),
  created_by  uuid references public.app_users (id) on delete set null,
  created_at  timestamptz not null default public.fusion_now(),
  unique (session_id, seq)
);
comment on table public.session_games is 'Games on one table session ("Off / On"): who lost each and what it cost; paid at checkout.';

-- Who pays for a tab item: a player of the table, or NULL for the group.
alter table public.session_items add column payer text check (payer is null or char_length(payer) between 1 and 40);

create table public.session_shares (
  session_id     uuid not null references public.sessions (id) on delete cascade,
  -- A player of the table, or '' for the group's snacks.
  payer          text not null check (char_length(payer) <= 40),
  payment_method text not null check (payment_method in ('cash', 'bank_transfer')),
  amount         numeric(12, 2) not null check (amount >= 0),
  paid_at        timestamptz not null default public.fusion_now(),
  paid_by        uuid references public.app_users (id) on delete set null,
  primary key (session_id, payer)
);
comment on table public.session_shares is 'Each player''s (and the group''s) share of a table, marked paid at checkout.';

-- Read and written only through the functions below (and shown through get_tables_overview / receipts).
alter table public.session_games enable row level security;
alter table public.session_shares enable row level security;
revoke all on table public.session_games, public.session_shares from public, anon, authenticated;

-- 2. Pricing ---------------------------------------------------------------------------------------
-- The charge for open play on a per-minute table after p_seconds (as end_session bills it).
create function public.fusion_open_play_charge(p_session public.sessions, p_seconds integer)
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare
  v_policy public.settings := public.fusion_billing_policy();
begin
  return public.fusion_session_charge(p_seconds, p_session.rate_per_minute, null, null,
    v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes);
end;
$$;

-- A player's name as first written on this table (so "ali" and "Ali" are one player).
create function public.fusion_table_player(p_session_id uuid, p_name text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select g.player_name from public.session_games g
     where g.session_id = p_session_id and lower(g.player_name) = lower(btrim(p_name)) order by g.seq limit 1),
    (select i.payer from public.session_items i
     where i.session_id = p_session_id and lower(i.payer) = lower(btrim(p_name)) limit 1),
    btrim(p_name));
$$;

-- 3. Off / On ---------------------------------------------------------------------------------------
-- Closes the game in play (from the last Off / On, or the start) for p_player_name and starts the next.
-- After the table has ended (checkout), it logs the last game.
create function public.split_session_game(p_session_id uuid, p_player_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_session public.sessions;
  v_name text := btrim(coalesce(p_player_name, ''));
  v_last public.session_games;
  v_to integer;
  v_charge numeric(12, 2);
  v_end timestamptz;
  v_game public.session_games;
begin
  if char_length(v_name) not between 1 and 40 then
    raise exception 'Enter who this game goes to (up to 40 characters).' using errcode = '22023', hint = 'invalid_input';
  end if;
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status not in ('running', 'paused', 'billing') then
    raise exception 'This table is not in play.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if v_session.booked_seconds is not null or v_session.pricing_mode <> 'per_minute' then
    raise exception 'Off / On is for open play on tables priced per minute.' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  select g.* into v_last from public.session_games g where g.session_id = p_session_id order by g.seq desc limit 1;
  if v_session.status = 'billing' then
    v_to := v_session.billable_seconds;
    v_charge := v_session.base_amount;
    v_end := v_session.ended_at;
  else
    v_end := public.fusion_now();
    v_to := public.fusion_billable_seconds(v_session, v_end);
    v_charge := public.fusion_open_play_charge(v_session, v_to);
  end if;
  if v_to <= coalesce(v_last.billable_to, 0) then
    raise exception 'No time has been played since the last game.' using errcode = 'P0001', hint = 'nothing_to_log';
  end if;

  insert into public.session_games (session_id, seq, player_name, started_at, ended_at, seconds, amount,
                                    billable_to, charge_to, created_by)
  values (p_session_id, coalesce(v_last.seq, 0) + 1, public.fusion_table_player(p_session_id, v_name),
          coalesce(v_last.ended_at, v_session.started_at), v_end, v_to - coalesce(v_last.billable_to, 0),
          greatest(v_charge - coalesce(v_last.charge_to, 0), 0), v_to, v_charge, v_me.id)
  returning * into v_game;
  return to_jsonb(v_game);
end;
$$;

-- 4. Snacks: the group's, or one player's -----------------------------------------------------------
create function public.assign_session_item(p_item_id uuid, p_payer text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item public.session_items;
  v_session public.sessions;
  v_payer text := nullif(btrim(coalesce(p_payer, '')), '');
begin
  perform public.fusion_require_user();
  select i.* into v_item from public.session_items i where i.id = p_item_id;
  if not found then
    raise exception 'That item is no longer on the tab.' using errcode = 'P0002', hint = 'not_found';
  end if;
  v_session := public.fusion_lock_session(v_item.session_id);
  if v_session.status not in ('running', 'paused', 'billing') then
    raise exception 'This table is not in play.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if v_payer is not null and char_length(v_payer) > 40 then
    raise exception 'Names are up to 40 characters.' using errcode = '22023', hint = 'invalid_input';
  end if;
  update public.session_items
  set payer = case when v_payer is null then null else public.fusion_table_player(v_item.session_id, v_payer) end
  where id = p_item_id returning * into v_item;
  return to_jsonb(v_item);
end;
$$;

-- 5. Marking shares paid ------------------------------------------------------------------------------
-- What a payer owes on a table: their games and snacks ('' = the group's snacks).
create function public.fusion_share_due(p_session_id uuid, p_payer text)
returns numeric language sql stable security definer set search_path = '' as $$
  select case when coalesce(p_payer, '') = ''
    then coalesce((select sum(i.unit_price * i.quantity) from public.session_items i
                   where i.session_id = p_session_id and i.payer is null), 0)
    else coalesce((select sum(g.amount) from public.session_games g
                   where g.session_id = p_session_id and lower(g.player_name) = lower(btrim(p_payer))), 0)
       + coalesce((select sum(i.unit_price * i.quantity) from public.session_items i
                   where i.session_id = p_session_id and lower(i.payer) = lower(btrim(p_payer))), 0)
  end::numeric(12, 2);
$$;

create function public.settle_session_share(p_session_id uuid, p_payer text, p_payment_method text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_session public.sessions;
  v_payer text := btrim(coalesce(p_payer, ''));
  v_due numeric(12, 2);
  v_share public.session_shares;
begin
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status <> 'billing' then
    raise exception 'End the table before taking payments.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if p_payment_method not in ('cash', 'bank_transfer') then
    raise exception 'Choose Cash or Bank Transfer.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if v_payer <> '' then v_payer := public.fusion_table_player(p_session_id, v_payer); end if;
  v_due := public.fusion_share_due(p_session_id, v_payer);
  if v_due <= 0 then
    raise exception 'Nothing to pay for %.', coalesce(nullif(v_payer, ''), 'the group') using errcode = 'P0001', hint = 'nothing_due';
  end if;
  insert into public.session_shares as sh (session_id, payer, payment_method, amount, paid_by)
  values (p_session_id, v_payer, p_payment_method, v_due, v_me.id)
  on conflict (session_id, payer) do update
    set payment_method = excluded.payment_method, amount = excluded.amount, paid_at = public.fusion_now(), paid_by = excluded.paid_by
  returning * into v_share;
  return to_jsonb(v_share);
end;
$$;

create function public.undo_session_share(p_session_id uuid, p_payer text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.sessions;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status <> 'billing' then
    raise exception 'This table is not at checkout.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  delete from public.session_shares s
  where s.session_id = p_session_id and lower(s.payer) = lower(btrim(coalesce(p_payer, '')));
  return jsonb_build_object('session_id', p_session_id, 'payer', btrim(coalesce(p_payer, '')));
end;
$$;

-- 6. Closing the table: one invoice from the shares --------------------------------------------------
create function public.complete_split_checkout(p_client_ref uuid, p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_session public.sessions;
  v_last public.session_games;
  v_row record;
  v_cash numeric(12, 2);
  v_bank numeric(12, 2);
  v_total numeric(12, 2);
  v_players text;
begin
  perform public.fusion_require_user();
  -- Already closed by this checkout (a repeat): the same receipt.
  if exists (select 1 from public.sales s where s.client_ref = p_client_ref) then
    return public.complete_checkout(p_client_ref => p_client_ref, p_payment_method => 'cash', p_session_id => p_session_id);
  end if;
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status <> 'billing' then
    raise exception 'End the table before checking out.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  select g.* into v_last from public.session_games g where g.session_id = p_session_id order by g.seq desc limit 1;
  if not found then
    raise exception 'This table has no games to settle.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if v_last.billable_to <> v_session.billable_seconds or v_last.charge_to <> v_session.base_amount then
    raise exception 'Give the last game to a player first.' using errcode = 'P0001', hint = 'unassigned_game';
  end if;

  -- Every payer with something to pay has paid exactly that.
  for v_row in
    select p.payer, public.fusion_share_due(p_session_id, p.payer) as due, sh.amount as paid
    from (select g.player_name as payer from public.session_games g where g.session_id = p_session_id
          union select i.payer from public.session_items i where i.session_id = p_session_id and i.payer is not null
          union select '') p
    left join public.session_shares sh on sh.session_id = p_session_id and lower(sh.payer) = lower(p.payer)
  loop
    if v_row.due > 0 and v_row.paid is null then
      raise exception '% has not paid yet.', coalesce(nullif(v_row.payer, ''), 'The group''s snacks') using errcode = 'P0001', hint = 'unsettled';
    end if;
    if v_row.paid is not null and v_row.paid <> v_row.due then
      raise exception 'What % owes changed after it was marked paid. Mark it again.', coalesce(nullif(v_row.payer, ''), 'the group')
        using errcode = 'P0001', hint = 'shares_changed';
    end if;
  end loop;

  select coalesce(sum(sh.amount) filter (where sh.payment_method = 'cash'), 0),
         coalesce(sum(sh.amount) filter (where sh.payment_method = 'bank_transfer'), 0)
    into v_cash, v_bank
  from public.session_shares sh where sh.session_id = p_session_id;
  v_total := v_session.base_amount + coalesce((select sum(i.unit_price * i.quantity) from public.session_items i where i.session_id = p_session_id), 0);
  if v_cash + v_bank <> v_total then
    raise exception 'The shares (PKR %) do not add up to the bill (PKR %).', v_cash + v_bank, v_total
      using errcode = 'P0001', hint = 'shares_changed';
  end if;
  select string_agg(distinct g.player_name, ', ') into v_players from public.session_games g where g.session_id = p_session_id;

  return public.complete_checkout(
    p_client_ref => p_client_ref,
    p_payment_method => case when v_bank = 0 then 'cash' when v_cash = 0 then 'bank_transfer' else 'split' end,
    p_session_id => p_session_id,
    p_customer_id => v_session.customer_id,
    p_customer_name => case when v_session.customer_id is null then left(v_players, 80) end,
    p_split_cash => case when v_bank > 0 and v_cash > 0 then v_cash end);
end;
$$;


-- 7. The floor shows the games and shares; the receipt shows who paid what --------------------------
create or replace function public.get_tables_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.fusion_require_user();
  return (
    select jsonb_build_object(
      'server_time', now(),
      'tables', coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'sort_order', t.sort_order,
        'category_id', c.id, 'category_name', c.name,
        'floor_id', f.id, 'floor_name', f.name,
        -- 1100: the category's pricing mode (a table's own per-minute rate applies to per-minute pricing only).
        'rate_per_minute', case when c.pricing_mode <> 'per_minute' then c.rate_per_minute
                                else coalesce(t.rate_override, c.rate_per_minute) end,
        'pricing_mode', c.pricing_mode, 'hourly_rate', c.hourly_rate, 'special_30_rate', c.special_30_rate,
        'under_hour_rate', c.under_hour_rate,
        'session', (
          select jsonb_build_object(
            'id', s.id, 'status', s.status, 'rate_per_minute', s.rate_per_minute,
            'booked_seconds', s.booked_seconds, 'booked_amount', s.booked_amount,
            'started_at', s.started_at, 'paused_at', s.paused_at, 'paused_ms', s.paused_ms,
            'ended_at', s.ended_at, 'billable_seconds', s.billable_seconds, 'base_amount', s.base_amount,
            -- 1000: the "time's up" state of a booking.
            'allocation_alert_ack_at', s.allocation_alert_ack_at, 'allocation_extended_at', s.allocation_extended_at,
            -- 1100: the prices the session started with.
            'pricing_mode', s.pricing_mode, 'hourly_rate', s.hourly_rate, 'special_30_rate', s.special_30_rate,
            'under_hour_rate', s.under_hour_rate,
            'customer', case
                          when cu.id is not null then jsonb_build_object('id', cu.id, 'name', cu.name, 'phone', cu.phone)
                          when s.customer_name is not null then jsonb_build_object('id', null, 'name', s.customer_name, 'phone', null)
                        end,
            'booking_id', (select b.id from public.bookings b where b.session_id = s.id),
            'items', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', i.id, 'product_id', i.product_id, 'name', i.product_name,
                         'unit_price', i.unit_price, 'quantity', i.quantity,
                         -- 2200: who pays for it (NULL = the group).
                         'payer', i.payer) order by i.created_at)
                       from public.session_items i where i.session_id = s.id), '[]'::jsonb),
            -- 2200: the games logged with Off / On, and the shares marked paid at checkout.
            'games', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', g.id, 'seq', g.seq, 'player_name', g.player_name, 'started_at', g.started_at,
                         'ended_at', g.ended_at, 'seconds', g.seconds, 'amount', g.amount,
                         'billable_to', g.billable_to, 'charge_to', g.charge_to) order by g.seq)
                       from public.session_games g where g.session_id = s.id), '[]'::jsonb),
            'shares', coalesce((select jsonb_agg(jsonb_build_object(
                         'payer', sh.payer, 'payment_method', sh.payment_method, 'amount', sh.amount) order by sh.payer)
                       from public.session_shares sh where sh.session_id = s.id), '[]'::jsonb))
          from public.sessions s
          left join public.customers cu on cu.id = s.customer_id
          where s.table_id = t.id and s.status in ('running', 'paused', 'billing'))
      ) order by f.sort_order, f.name, t.sort_order, t.name), '[]'::jsonb))
    from public.club_tables t
    join public.table_categories c on c.id = t.category_id
    join public.floors f on f.id = t.floor_id
    where t.is_active and public.fusion_can_access_floor(t.floor_id));
end;
$$;

create or replace function public.fusion_receipt_json(p_sale_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sale_id', s.id,
    'receipt_no', s.receipt_no,
    'created_at', s.created_at,
    'business_date', s.business_date,
    'club', jsonb_build_object('name', st.club_name, 'address', st.club_address,
                               'phone', st.club_phone, 'footer', st.receipt_footer),
    'table_name', s.table_name,
    'floor_name', f.name,
    'customer_name', s.customer_name,
    'customer_phone', s.customer_phone,
    'cashier_name', s.cashier_name,
    'payment_method', s.payment_method,
    'split_cash_amount', s.split_cash_amount,
    'session', case when s.session_seconds is null then null else jsonb_build_object(
      'started_at', se.started_at, 'ended_at', se.ended_at, 'billable_seconds', s.session_seconds,
      'rate_per_minute', s.rate_per_minute, 'standard_rate_per_minute', s.standard_rate_per_minute,
      'standard_base_amount', s.standard_base_amount, 'booked_seconds', se.booked_seconds,
      'booked_amount', se.booked_amount,
      -- 1100: hourly pricing is shown on the receipt.
      'pricing_mode', se.pricing_mode, 'hourly_rate', se.hourly_rate, 'special_30_rate', se.special_30_rate,
      'under_hour_rate', se.under_hour_rate) end,
    'base_amount', s.base_amount,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
                 'name', i.product_name, 'unit_price', i.unit_price,
                 'quantity', i.quantity, 'line_total', i.line_total) order by i.product_name)
               from public.sale_items i where i.sale_id = s.id), '[]'::jsonb),
    'products_subtotal', s.products_subtotal,
    'discount', s.discount,
    'final_amount', s.final_amount,
    -- 2200: a table settled game by game: what each player (and the group's snacks) paid.
    'players', case when se.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', sh.payer,
               'games', (select count(*) from public.session_games g where g.session_id = se.id and lower(g.player_name) = lower(sh.payer)),
               'amount', sh.amount, 'payment_method', sh.payment_method) order by sh.payer = '', sh.payer)
      from public.session_shares sh where sh.session_id = se.id), '[]'::jsonb) end)
  from public.sales s
  cross join public.settings st
  left join public.floors f on f.id = s.floor_id
  left join public.sessions se on se.id = s.session_id
  where s.id = p_sale_id and st.id = 1;
$$;

-- 8. Uploads (offline) know the new actions -----------------------------------------------------------
create or replace function public.sync_operation(p_id uuid, p_kind text, p_occurred_at timestamptz, p_args jsonb, p_device text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_user();
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_op public.sync_operations;
  v_at timestamptz := p_occurred_at;
  v_session public.sessions;
  v_latest timestamptz;
  v_item public.session_items;
  v_result jsonb;
begin
  if p_id is null or p_occurred_at is null or jsonb_typeof(v_args) <> 'object' or pg_catalog.pg_column_size(v_args) > 32768 then
    raise exception 'Incomplete action.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_device is null or p_device !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'Unknown device.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_kind is null or p_kind not in ('session.start', 'session.pause', 'session.resume', 'session.end', 'session.reopen',
      'session.acknowledge', 'session.continue', 'session.extend', 'session.cancel', 'tab.add', 'tab.set', 'checkout',
      'counter.open', 'expense.add', 'expense.void',
      -- 2200: games on a table.
      'session.split', 'tab.assign', 'share.settle', 'share.undo', 'checkout.split') then
    raise exception 'Unknown action.' using errcode = '22023', hint = 'invalid_input';
  end if;

  -- Claim the id. A repeat of an action already applied (a lost reply, a retry, another tab)
  -- waits here for the first to finish, then gets the first answer: nothing is applied twice.
  begin
    insert into public.sync_operations (id, user_id, device_id, kind, occurred_at)
    values (p_id, v_me.id, p_device, p_kind, p_occurred_at);
  exception when unique_violation then
    select o.* into v_op from public.sync_operations o where o.id = p_id;
    if v_op.user_id <> v_me.id or v_op.kind <> p_kind then
      raise exception 'This action id is already in use.' using errcode = 'P0001', hint = 'conflict';
    end if;
    return jsonb_build_object('replayed', true, 'result', v_op.result);
  end;

  if p_occurred_at > now() + interval '2 minutes' then
    raise exception 'This device''s clock is ahead of the server. Check its date and time.' using errcode = '22023', hint = 'invalid_time';
  end if;
  if p_occurred_at < now() - interval '72 hours' then
    raise exception 'This action is more than 72 hours old, too old to upload automatically.' using errcode = '22023', hint = 'too_old';
  end if;

  -- Time-sensitive session actions: never before the session's last change by any device.
  if p_kind in ('session.pause', 'session.resume', 'session.end', 'session.reopen', 'session.cancel', 'session.continue',
                'session.extend', 'session.split') then
    select s.* into v_session from public.sessions s where s.id = (v_args->>'session_id')::uuid;
    if found then
      v_latest := greatest(v_session.started_at, v_session.last_event_at, v_session.paused_at, v_session.ended_at,
                           v_session.allocation_alert_ack_at, v_session.allocation_extended_at);
      if v_at < v_latest - interval '5 seconds' then
        raise exception 'Another device changed this table after this action was made offline.'
          using errcode = 'P0001', hint = 'stale_state';
      end if;
      v_at := greatest(v_at, v_latest); -- a few seconds of clock difference between devices
    end if;
  end if;

  perform pg_catalog.set_config('fusion.event_epoch', extract(epoch from v_at)::text, true);

  case p_kind
    when 'session.start' then
      v_result := to_jsonb(public.start_session(
        p_table_id => (v_args->>'table_id')::uuid,
        p_booking => coalesce(v_args->>'booking', 'open'),
        p_minutes => (v_args->>'minutes')::integer,
        p_amount => (v_args->>'amount')::numeric,
        p_customer_id => (v_args->>'customer_id')::uuid,
        p_customer_name => v_args->>'customer_name',
        p_customer_phone => v_args->>'customer_phone'));
    when 'session.pause' then v_result := to_jsonb(public.pause_session((v_args->>'session_id')::uuid));
    when 'session.resume' then v_result := to_jsonb(public.resume_session((v_args->>'session_id')::uuid));
    when 'session.end' then v_result := to_jsonb(public.end_session((v_args->>'session_id')::uuid));
    when 'session.reopen' then v_result := to_jsonb(public.reopen_session((v_args->>'session_id')::uuid));
    when 'session.acknowledge' then v_result := to_jsonb(public.acknowledge_allocation_alert((v_args->>'session_id')::uuid));
    when 'session.continue' then v_result := to_jsonb(public.continue_after_allocation((v_args->>'session_id')::uuid));
    when 'session.extend' then
      v_result := to_jsonb(public.extend_session((v_args->>'session_id')::uuid, (v_args->>'minutes')::integer,
                                                 (v_args->>'from_booked_seconds')::integer));
    when 'session.cancel' then
      perform public.cancel_session((v_args->>'session_id')::uuid);
      v_result := jsonb_build_object('id', v_args->>'session_id');
    when 'tab.add' then
      v_result := to_jsonb(public.add_session_item((v_args->>'session_id')::uuid, (v_args->>'product_id')::uuid,
                                                   coalesce((v_args->>'quantity')::integer, 1)));
    when 'tab.set' then
      -- A change, not an overwrite: another device may have changed the same line meanwhile.
      select i.* into v_item from public.session_items i where i.id = (v_args->>'item_id')::uuid;
      if not found then
        raise exception 'That item is no longer on the tab.' using errcode = 'P0002', hint = 'not_found';
      end if;
      perform public.set_session_item_quantity(v_item.id,
        greatest(0, least(999, v_item.quantity + (v_args->>'quantity')::integer - (v_args->>'from_quantity')::integer)));
      v_result := jsonb_build_object('id', v_item.id);
    when 'checkout' then
      v_result := public.complete_checkout(
        p_client_ref => p_id,
        p_payment_method => v_args->>'payment_method',
        p_session_id => (v_args->>'session_id')::uuid,
        p_items => v_args->'items',
        p_discount => coalesce((v_args->>'discount')::numeric, 0),
        p_customer_id => (v_args->>'customer_id')::uuid,
        p_customer_name => v_args->>'customer_name',
        p_customer_phone => v_args->>'customer_phone',
        p_custom_rate_per_minute => (v_args->>'custom_rate_per_minute')::numeric,
        p_split_cash => (v_args->>'split_cash')::numeric);
    when 'counter.open' then v_result := public.open_counter();
    when 'expense.add' then v_result := public.add_expense(p_id, (v_args->>'amount')::numeric, v_args->>'description');
    when 'expense.void' then v_result := public.void_expense((v_args->>'expense_id')::uuid);
    when 'session.split' then
      v_result := public.split_session_game((v_args->>'session_id')::uuid, v_args->>'player_name');
    when 'tab.assign' then
      v_result := public.assign_session_item((v_args->>'item_id')::uuid, v_args->>'payer');
    when 'share.settle' then
      v_result := public.settle_session_share((v_args->>'session_id')::uuid, v_args->>'payer', v_args->>'payment_method');
    when 'share.undo' then
      v_result := public.undo_session_share((v_args->>'session_id')::uuid, v_args->>'payer');
    when 'checkout.split' then
      v_result := public.complete_split_checkout(p_id, (v_args->>'session_id')::uuid);
  end case;

  update public.sync_operations set result = v_result where id = p_id;
  -- Older than any action still accepted (72 hours): a repeat would be refused as too old anyway.
  delete from public.sync_operations where received_at < now() - interval '14 days';
  return jsonb_build_object('replayed', false, 'result', v_result);
exception
  when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format then
    raise exception 'This action holds invalid data.' using errcode = '22023', hint = 'invalid_input';
end;
$$;

-- 9. Reset business data and its backup include the games and shares -----------------------------------
create or replace function public.admin_reset_business_data(p_password text, p_confirmation text, p_reset_stock boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_users;
  v_removed jsonb;
begin
  if p_confirmation is distinct from 'RESET BUSINESS DATA' then
    perform public.fusion_require_admin();
    raise exception 'Type RESET BUSINESS DATA to confirm.' using errcode = '22023', hint = 'invalid_input';
  end if;
  v_me := public.fusion_require_admin_password(p_password);
  -- One reset at a time; the retention job waits rather than running alongside.
  if not pg_catalog.pg_try_advisory_xact_lock(7316, 0) then
    raise exception 'A reset is already running. Wait a moment and check again.' using errcode = 'P0001', hint = 'busy';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(7315, 0);

  v_removed := public.admin_business_data_summary() -> 'counts';

  truncate table
    public.bookings,
    -- 2200: the games and shares of tables.
    public.session_games,
    public.session_shares,
    public.session_items,
    public.sale_items,
    public.sales,
    public.sessions,
    public.expenses,
    public.shift_daily_totals,
    public.counter_shifts,
    public.daily_summaries,
    public.product_sales_daily,
    public.customer_visits,
    public.customers,
    public.retention_runs
    restart identity;

  -- 1300: the API's safeupdate guard refuses an UPDATE without WHERE (that
  -- rolled the whole reset back); only products that change are written.
  update public.inventory_products
  set units_sold = 0,
      stock_quantity = case when coalesce(p_reset_stock, false) then 0 else stock_quantity end,
      updated_at = now()
  where units_sold <> 0 or (coalesce(p_reset_stock, false) and stock_quantity <> 0);
  update public.settings set business_reset_at = now(), business_reset_by = v_me.id where id = 1;

  return jsonb_build_object('reset_at', now(), 'reset_by', v_me.full_name, 'removed', v_removed,
                            'stock_reset', coalesce(p_reset_stock, false));
end;
$$;

create or replace function public.admin_export_business_data(p_password text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.app_users := public.fusion_require_admin_password(p_password);
begin
  return jsonb_build_object(
    'format', 'fusion-business-data-backup',
    'version', 1,
    'exported_at', now(),
    'exported_by', v_me.full_name,
    'club_name', (select st.club_name from public.settings st where st.id = 1),
    'business_timezone', (select st.business_timezone from public.settings st where st.id = 1),
    'summary', public.admin_business_data_summary() -> 'counts',
    'tables', jsonb_build_object(
      'sessions', coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at) from public.sessions x), '[]'::jsonb),
      'session_items', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.session_items x), '[]'::jsonb),
      -- 2200: the games and shares of tables.
      'session_games', coalesce((select jsonb_agg(to_jsonb(x) order by x.session_id, x.seq) from public.session_games x), '[]'::jsonb),
      'session_shares', coalesce((select jsonb_agg(to_jsonb(x) order by x.session_id, x.payer) from public.session_shares x), '[]'::jsonb),
      'bookings', coalesce((select jsonb_agg(to_jsonb(x) order by x.booking_at) from public.bookings x), '[]'::jsonb),
      'sales', coalesce((select jsonb_agg(to_jsonb(x) order by x.receipt_no) from public.sales x), '[]'::jsonb),
      'sale_items', coalesce((select jsonb_agg(to_jsonb(x) order by x.sale_id) from public.sale_items x), '[]'::jsonb),
      'counter_shifts', coalesce((select jsonb_agg(to_jsonb(x) order by x.opened_at) from public.counter_shifts x), '[]'::jsonb),
      'shift_daily_totals', coalesce((select jsonb_agg(to_jsonb(x) order by x.business_date) from public.shift_daily_totals x), '[]'::jsonb),
      'expenses', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.expenses x), '[]'::jsonb),
      'daily_summaries', coalesce((select jsonb_agg(to_jsonb(x) order by x.business_date) from public.daily_summaries x), '[]'::jsonb),
      'product_sales_daily', coalesce((select jsonb_agg(to_jsonb(x) order by x.business_date) from public.product_sales_daily x), '[]'::jsonb),
      'customers', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at) from public.customers x), '[]'::jsonb),
      'customer_visits', coalesce((select jsonb_agg(to_jsonb(x) order by x.business_date) from public.customer_visits x), '[]'::jsonb),
      'retention_runs', coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at) from public.retention_runs x), '[]'::jsonb),
      'products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'stock_quantity', p.stock_quantity,
                                                                'units_sold', p.units_sold) order by p.name)
                            from public.inventory_products p), '[]'::jsonb)));
end;
$$;

-- 10. Grants ------------------------------------------------------------------------------------------
revoke all on function public.fusion_open_play_charge(public.sessions, integer), public.fusion_table_player(uuid, text),
  public.fusion_share_due(uuid, text), public.split_session_game(uuid, text), public.assign_session_item(uuid, text),
  public.settle_session_share(uuid, text, text), public.undo_session_share(uuid, text),
  public.complete_split_checkout(uuid, uuid) from public, anon, authenticated;
-- Any signed-in account (each calls fusion_require_user() and checks the table's floor).
grant execute on function public.split_session_game(uuid, text), public.assign_session_item(uuid, text),
  public.settle_session_share(uuid, text, text), public.undo_session_share(uuid, text),
  public.complete_split_checkout(uuid, uuid) to authenticated;
