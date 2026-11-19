-- =============================================================================
-- FUSION 2000: offline sync.
--
-- Each device saves every floor action (starting, pausing and ending tables,
-- tab items, checkouts, counter expenses, opening a counter) on the device
-- first and uploads it through sync_operation(); while the device is offline
-- the actions wait in its queue and upload when the connection is back.
--
-- Impact on existing data: none. One table is added (sync_operations), one
-- nullable column (sessions.last_event_at), one allowed value for the stock
-- log's source; column defaults that were now() become fusion_now(), which IS
-- now() everywhere except inside sync_operation. No rows are rewritten.
--
--   * Exactly once. Every action carries an id made on the device. The first
--     upload claims it in sync_operations; any repeat (a lost reply, a retry,
--     a second tab) gets the first answer back and changes nothing.
--   * At the right time. An action made offline at 3:05 PM and uploaded at
--     3:40 PM is recorded at 3:05: sync_operation runs the normal floor
--     function with fusion_now() set to the action's time, so billing, the
--     business day and every timestamp come out as if it had been online.
--     Accepted only up to 2 minutes ahead of the server and 72 hours back.
--   * Never over another device. A time-sensitive session action (pause,
--     resume, end, reopen, cancel, continue, extend) older than that
--     session's last change is refused ("stale_state") instead of rewriting
--     what the other device did; tab quantities are applied as a change
--     ("was 2, now 3") on top of whatever the tab holds.
--   * Nothing refused that really happened. A sale made offline is recorded
--     even if another device sold the last units meanwhile: stock stops at
--     zero and the shortfall is logged (stock log source "offline_oversold").
--     Everything else is checked exactly as online (prices, permissions, an
--     open counter, session state).
--   * Every function below is the current definition with now() replaced by
--     fusion_now() (and the stock change above); nothing else differs.
--     tests/db/offline-sync.test.ts checks that none of them reads now().
-- =============================================================================

-- 1. The action's time ---------------------------------------------------------------------------
-- Set (transaction-local) only by sync_operation; unset, it is now().
create function public.fusion_now()
returns timestamptz language sql stable set search_path = '' as $$
  select coalesce(pg_catalog.to_timestamp(nullif(pg_catalog.current_setting('fusion.event_epoch', true), '')::double precision),
                  pg_catalog.now())
$$;

create function public.fusion_is_replay()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(nullif(pg_catalog.current_setting('fusion.event_epoch', true), ''), '') <> ''
$$;

alter table public.sessions
  alter column started_at set default public.fusion_now(),
  alter column created_at set default public.fusion_now();
alter table public.session_items alter column created_at set default public.fusion_now();
alter table public.sales alter column created_at set default public.fusion_now();
alter table public.expenses alter column created_at set default public.fusion_now();
alter table public.counter_shifts alter column opened_at set default public.fusion_now();
alter table public.stock_adjustments alter column created_at set default public.fusion_now();
alter table public.customers
  alter column created_at set default public.fusion_now(),
  alter column updated_at set default public.fusion_now();
alter table public.shift_daily_totals alter column updated_at set default public.fusion_now();
alter table public.product_sales_daily alter column updated_at set default public.fusion_now();

-- 2. A session's last change (any device), so an older offline action cannot rewrite it -----------
alter table public.sessions add column last_event_at timestamptz;
comment on column public.sessions.last_event_at is
  'When the session last changed (pause, resume, end …); sync_operation refuses older offline actions on it.';

create function public.fusion_touch_session()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.last_event_at := greatest(coalesce(old.last_event_at, old.started_at), public.fusion_now());
  return new;
end;
$$;
create trigger sessions_touch before update on public.sessions
  for each row execute function public.fusion_touch_session();

-- 3. Offline sales beyond the stock count ---------------------------------------------------------
alter table public.stock_adjustments drop constraint stock_adjustments_source_check;
alter table public.stock_adjustments
  add constraint stock_adjustments_source_check check (source in ('opening', 'adjust', 'offline_oversold'));

create function public.fusion_log_offline_shortfall(p_product public.inventory_products, p_quantity integer, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stock_adjustments (product_id, delta, stock_after, source, user_id)
  values (p_product.id, -(p_quantity - greatest(p_product.stock_quantity, 0)), 0, 'offline_oversold', p_user);
end;
$$;

-- 4. Floor functions at the action's time ---------------------------------------------------------
-- acknowledge_allocation_alert(p_session_id uuid)
CREATE OR REPLACE FUNCTION public.acknowledge_allocation_alert(p_session_id uuid)
 RETURNS sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_session public.sessions;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.booked_seconds is null or v_session.status not in ('running', 'paused', 'billing') then
    raise exception 'This session has no booking to acknowledge.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  update public.sessions set allocation_alert_ack_at = coalesce(allocation_alert_ack_at, public.fusion_now())
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$function$;

-- add_expense(p_client_ref uuid, p_amount numeric, p_description text)
CREATE OR REPLACE FUNCTION public.add_expense(p_client_ref uuid, p_amount numeric, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.app_users := public.fusion_require_user();
  v_shift public.counter_shifts;
  v_expense public.expenses;
begin
  if p_client_ref is null then
    raise exception 'Missing expense reference.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select e.* into v_expense from public.expenses e where e.client_ref = p_client_ref;
  if found then
    if v_expense.user_id <> v_me.id then
      raise exception 'Expense not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
    return to_jsonb(v_expense);
  end if;

  v_shift := public.fusion_require_open_shift(v_me);
  if p_amount is null or p_amount <= 0 or p_amount > 10000000 or p_amount <> round(p_amount, 2) then
    raise exception 'Enter a valid amount.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if char_length(btrim(coalesce(p_description, ''))) not between 1 and 120 then
    raise exception 'Describe the expense (up to 120 characters).' using errcode = '22023', hint = 'invalid_input';
  end if;

  insert into public.expenses (client_ref, shift_id, user_id, business_date, amount, description)
  values (p_client_ref, v_shift.id, v_me.id, public.fusion_business_date(public.fusion_now()), p_amount, btrim(p_description))
  returning * into v_expense;
  perform public.fusion_post_ledger(v_shift.id, v_me.id, v_expense.business_date, 0, 0, 0, 0, v_expense.amount, 0, 0, 0);
  return to_jsonb(v_expense);
end;
$function$;

-- add_session_item(p_session_id uuid, p_product_id uuid, p_quantity integer)
CREATE OR REPLACE FUNCTION public.add_session_item(p_session_id uuid, p_product_id uuid, p_quantity integer DEFAULT 1)
 RETURNS session_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.app_users := public.fusion_require_user();
  v_session public.sessions;
  v_product public.inventory_products;
  v_item public.session_items;
begin
  if p_quantity is null or p_quantity < 1 or p_quantity > 999 then
    raise exception 'Quantity must be between 1 and 999.' using errcode = '22023', hint = 'invalid_input';
  end if;
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status not in ('running', 'paused', 'billing') then
    raise exception 'Items can only be added to an open session.' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  select p.* into v_product from public.inventory_products p where p.id = p_product_id for update;
  if not found or not v_product.is_active then
    raise exception 'That product is no longer available.' using errcode = 'P0002', hint = 'product_unavailable';
  end if;
  if v_product.track_stock and v_product.stock_quantity < p_quantity then
    if not public.fusion_is_replay() then
      raise exception 'Only % × % left in stock.', v_product.stock_quantity, v_product.name
        using errcode = 'P0001', hint = 'insufficient_stock';
    end if;
    -- 2000: sold while offline, so it really happened: stock stops at zero and the shortfall is logged.
    perform public.fusion_log_offline_shortfall(v_product, p_quantity, v_me.id);
  end if;

  if v_product.track_stock then
    update public.inventory_products set stock_quantity = greatest(stock_quantity - p_quantity, 0), updated_at = public.fusion_now()
    where id = p_product_id;
  end if;

  insert into public.session_items as si (session_id, product_id, product_name, unit_price, quantity, added_by)
  values (p_session_id, p_product_id, v_product.name, v_product.selling_price, p_quantity, v_me.id)
  on conflict (session_id, product_id)
    do update set quantity = si.quantity + excluded.quantity
  returning * into v_item;
  return v_item;
exception
  when check_violation then
    raise exception 'Quantity must be between 1 and 999.' using errcode = '22023', hint = 'invalid_input';
end;
$function$;

-- cancel_session(p_session_id uuid)
CREATE OR REPLACE FUNCTION public.cancel_session(p_session_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.app_users := public.fusion_require_perm('cancel_session', 'cancel sessions');
  v_session public.sessions;
  v_policy public.settings := public.fusion_billing_policy();
  v_paused_ms bigint;
  v_billable integer;
begin
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status not in ('running', 'paused', 'billing') then
    raise exception 'Only an open session can be cancelled.' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  update public.inventory_products p
  set stock_quantity = p.stock_quantity + i.quantity, updated_at = public.fusion_now()
  from (select si.product_id, si.quantity from public.session_items si
        where si.session_id = p_session_id order by si.product_id) i
  where p.id = i.product_id and p.track_stock;
  delete from public.session_items where session_id = p_session_id;

  if v_session.status = 'billing' then
    update public.sessions set status = 'cancelled', ended_by = v_me.id where id = p_session_id;
  else
    v_paused_ms := v_session.paused_ms
      + case when v_session.status = 'paused' then public.fusion_ms_between(v_session.paused_at, public.fusion_now()) else 0 end;
    -- 1000: a booking that was not continued holds at its booked time.
    v_billable := public.fusion_billable_seconds(v_session, public.fusion_now());
    update public.sessions
    set status = 'cancelled', paused_at = null, paused_ms = v_paused_ms, ended_at = public.fusion_now(), ended_by = v_me.id,
        billable_seconds = v_billable,
        base_amount = case pricing_mode
          -- 1300: the whole time at the under-1-hour rate below 60 billed minutes, else the hourly rate.
          when 'tiered_hourly' then public.fusion_tiered_charge(
            v_billable, hourly_rate, under_hour_rate, booked_seconds, booked_amount,
            v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
          -- 1500: as end_session.
          when 'hourly_special30' then public.fusion_slot_charge(
            v_billable, hourly_rate, special_30_rate, rate_per_minute, booked_seconds, booked_amount,
            v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
          else public.fusion_session_charge(
            v_billable, rate_per_minute, booked_seconds, booked_amount,
            v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes) end
    where id = p_session_id;
  end if;
  update public.bookings set status = 'cancelled', updated_at = public.fusion_now()
  where session_id = p_session_id and status = 'started';
end;
$function$;

-- complete_checkout(p_client_ref uuid, p_payment_method text, p_session_id uuid, p_items jsonb, p_discount numeric, p_customer_id uuid, p_customer_name text, p_customer_phone text, p_custom_rate_per_minute numeric, p_split_cash numeric)
CREATE OR REPLACE FUNCTION public.complete_checkout(p_client_ref uuid, p_payment_method text, p_session_id uuid DEFAULT NULL::uuid, p_items jsonb DEFAULT NULL::jsonb, p_discount numeric DEFAULT 0, p_customer_id uuid DEFAULT NULL::uuid, p_customer_name text DEFAULT NULL::text, p_customer_phone text DEFAULT NULL::text, p_custom_rate_per_minute numeric DEFAULT NULL::numeric, p_split_cash numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.app_users := public.fusion_require_user();
  v_shift public.counter_shifts;
  v_policy public.settings := public.fusion_billing_policy();
  v_existing uuid;
  v_session public.sessions;
  v_table public.club_tables;
  v_customer public.customers;
  v_customer_name text;
  v_product public.inventory_products;
  v_line record;
  v_discount numeric(12, 2) := coalesce(p_discount, 0);
  v_custom_rate numeric(12, 4);
  v_base numeric(12, 2) := 0;
  v_products numeric(12, 2) := 0;
  v_final numeric(12, 2);
  v_floor smallint;
  v_sale_id uuid;
  v_date date;
  v_lines jsonb := '[]'::jsonb;
begin
  if p_client_ref is null then
    raise exception 'Missing checkout reference.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select s.id into v_existing from public.sales s where s.client_ref = p_client_ref;
  if found then
    return public.fusion_receipt_json(v_existing);
  end if;

  v_shift := public.fusion_require_open_shift(v_me);

  if p_payment_method is null or p_payment_method not in ('cash', 'bank_transfer', 'split') then
    raise exception 'Choose Cash, Bank Transfer or Split.' using errcode = '22023', hint = 'invalid_input';
  end if;
  -- 1300: a split payment names its cash part; the rest is paid by bank transfer.
  if p_payment_method = 'split' then
    if p_split_cash is null or p_split_cash <= 0 or p_split_cash <> round(p_split_cash, 2) then
      raise exception 'Enter how much of a split payment was paid in cash.' using errcode = '22023', hint = 'invalid_split';
    end if;
  elsif p_split_cash is not null then
    raise exception 'A cash part is only for a split payment.' using errcode = '22023', hint = 'invalid_split';
  end if;
  if coalesce(p_discount, 0) < 0 or coalesce(p_discount, 0) <> round(coalesce(p_discount, 0), 2) then
    raise exception 'Discount must be a positive amount.' using errcode = '22023', hint = 'invalid_discount';
  end if;
  if v_discount > 0 and not ('apply_discount' = any (v_me.permissions)) then
    raise exception 'You do not have permission to apply discounts.' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_custom_rate_per_minute is not null then
    if p_session_id is null then
      raise exception 'A custom rate applies to table checkouts only.' using errcode = '22023', hint = 'invalid_input';
    end if;
    if not public.fusion_valid_rate(p_custom_rate_per_minute) then
      raise exception 'Enter a rate per minute above zero.' using errcode = '22023', hint = 'invalid_rate';
    end if;
  end if;

  if p_session_id is not null then
    if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
      raise exception 'Table checkouts use the items on the table tab.' using errcode = '22023', hint = 'invalid_input';
    end if;
    v_session := public.fusion_lock_session(p_session_id);
    if v_session.status = 'completed' then
      select s.id into v_existing from public.sales s where s.client_ref = p_client_ref;
      if found then
        return public.fusion_receipt_json(v_existing);
      end if;
      raise exception 'This session has already been paid.' using errcode = 'P0001', hint = 'already_paid';
    end if;
    if v_session.status <> 'billing' then
      raise exception 'End the session before checking out.' using errcode = 'P0001', hint = 'invalid_state';
    end if;
    select t.* into v_table from public.club_tables t where t.id = v_session.table_id;
    v_floor := v_table.floor_id;
    v_base := v_session.base_amount;
    -- A custom rate re-prices all of the session's time at that rate; the
    -- discount below still applies to the re-priced bill.
    if p_custom_rate_per_minute is not null and p_custom_rate_per_minute <> v_session.rate_per_minute then
      -- 1100: tables priced by the hour are not re-priced per minute (a discount still applies).
      -- 1300: nor are tables with an under-1-hour rate.
      if v_session.pricing_mode <> 'per_minute' then
        raise exception 'Custom rates per minute do not apply to tables priced by the hour. Use a discount instead.'
          using errcode = '22023', hint = 'invalid_rate';
      end if;
      if not ('apply_discount' = any (v_me.permissions)) then
        raise exception 'You do not have permission to set a custom rate.' using errcode = '42501', hint = 'forbidden';
      end if;
      v_custom_rate := p_custom_rate_per_minute;
      v_base := public.fusion_charge_at_rate(
        v_session.billable_seconds, v_custom_rate, v_session.booked_seconds,
        v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('product_id', i.product_id, 'name', i.product_name,
                                                 'unit_price', i.unit_price, 'quantity', i.quantity)
                              order by i.product_id), '[]'::jsonb)
      into v_lines
    from public.session_items i where i.session_id = p_session_id;
  else
    if not ('counter_sale' = any (v_me.permissions)) then
      raise exception 'You do not have permission to make counter sales.' using errcode = '42501', hint = 'forbidden';
    end if;
    if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
      raise exception 'Add at least one product.' using errcode = '22023', hint = 'invalid_input';
    end if;
    if jsonb_array_length(p_items) > 100 then
      raise exception 'Too many lines in one sale.' using errcode = '22023', hint = 'invalid_input';
    end if;
    v_floor := v_me.floor_id;
    for v_line in
      select x.product_id, sum(x.quantity)::integer as quantity, min(x.unit_price) as unit_price,
             max(x.unit_price) as max_price
      from jsonb_to_recordset(p_items) as x(product_id uuid, quantity integer, unit_price numeric)
      group by x.product_id order by x.product_id
    loop
      if v_line.product_id is null or v_line.quantity is null or v_line.quantity < 1 or v_line.quantity > 999
         or v_line.unit_price is null or v_line.unit_price <> v_line.max_price then
        raise exception 'The cart contains an invalid line.' using errcode = '22023', hint = 'invalid_input';
      end if;
      select p.* into v_product from public.inventory_products p where p.id = v_line.product_id for update;
      if not found then
        raise exception 'A product in the cart no longer exists.' using errcode = 'P0002', hint = 'product_unavailable';
      end if;
      if v_product.selling_price <> v_line.unit_price then
        raise exception 'The price of % changed to PKR %. Review the cart and try again.',
          v_product.name, v_product.selling_price using errcode = 'P0001', hint = 'price_changed';
      end if;
      if v_product.track_stock then
        if v_product.stock_quantity < v_line.quantity then
          if not public.fusion_is_replay() then
            raise exception 'Only % × % left in stock.', v_product.stock_quantity, v_product.name
              using errcode = 'P0001', hint = 'insufficient_stock';
          end if;
          -- 2000: sold while offline, so it really happened: stock stops at zero and the shortfall is logged.
          perform public.fusion_log_offline_shortfall(v_product, v_line.quantity, v_me.id);
        end if;
        update public.inventory_products set stock_quantity = greatest(stock_quantity - v_line.quantity, 0), updated_at = public.fusion_now()
        where id = v_product.id;
      end if;
      v_lines := v_lines || jsonb_build_object('product_id', v_product.id, 'name', v_product.name,
                                               'unit_price', v_product.selling_price, 'quantity', v_line.quantity);
    end loop;
  end if;

  select coalesce(sum((l ->> 'unit_price')::numeric * (l ->> 'quantity')::integer), 0)
    into v_products from jsonb_array_elements(v_lines) l;

  if v_discount > v_base + v_products then
    raise exception 'Discount (PKR %) cannot exceed the bill (PKR %).', v_discount, v_base + v_products
      using errcode = '22023', hint = 'invalid_discount';
  end if;

  v_customer := public.fusion_resolve_customer(
    coalesce(p_customer_id, case when p_customer_name is null and p_customer_phone is null
                                 then v_session.customer_id end),
    p_customer_name, p_customer_phone);
  v_customer_name := coalesce(v_customer.name, nullif(btrim(coalesce(p_customer_name, '')), ''),
                              case when p_customer_name is null and p_customer_phone is null
                                   then v_session.customer_name end);

  v_final := v_base + v_products - v_discount;
  if p_payment_method = 'split' and p_split_cash >= v_final then
    raise exception 'The cash part (PKR %) must be less than the total (PKR %); the rest is paid by bank transfer.',
      p_split_cash, v_final using errcode = '22023', hint = 'invalid_split';
  end if;
  v_date := public.fusion_business_date(public.fusion_now());

  insert into public.sales (client_ref, session_id, shift_id, table_name, floor_id, customer_id, customer_name,
                            customer_phone, cashier_id, cashier_name, payment_method, session_seconds,
                            rate_per_minute, standard_rate_per_minute, standard_base_amount,
                            base_amount, products_subtotal, discount, final_amount, business_date, split_cash_amount)
  values (p_client_ref, v_session.id, v_shift.id, v_table.name, v_floor, v_customer.id, v_customer_name,
          v_customer.phone, v_me.id, v_me.full_name, p_payment_method, v_session.billable_seconds,
          coalesce(v_custom_rate, v_session.rate_per_minute),
          case when v_custom_rate is not null then v_session.rate_per_minute end,
          case when v_custom_rate is not null then v_session.base_amount end,
          v_base, v_products, v_discount, v_final, v_date,
          case when p_payment_method = 'split' then p_split_cash end)
  returning id into v_sale_id;

  -- 0900: each line keeps the product's cost price at the moment of sale.
  insert into public.sale_items (sale_id, product_id, product_name, unit_price, quantity, line_total, unit_cost)
  select v_sale_id, (l ->> 'product_id')::uuid, l ->> 'name', (l ->> 'unit_price')::numeric,
         (l ->> 'quantity')::integer, (l ->> 'unit_price')::numeric * (l ->> 'quantity')::integer,
         (select p.cost_price from public.inventory_products p where p.id = (l ->> 'product_id')::uuid)
  from jsonb_array_elements(v_lines) l;
  -- 0900: the permanent product sales ledger.
  perform public.fusion_post_product_sales(v_sale_id, 1);

  update public.inventory_products p set units_sold = p.units_sold + q.quantity
  from (select (l ->> 'product_id')::uuid as product_id, sum((l ->> 'quantity')::integer) as quantity
        from jsonb_array_elements(v_lines) l group by 1 order by 1) q
  where p.id = q.product_id;

  -- Snack sales are a breakdown of the same money: they are posted as their
  -- own figure but are already inside the cash or bank amount.
  perform public.fusion_post_ledger(v_shift.id, v_me.id, v_date,
    case p_payment_method when 'cash' then v_final when 'split' then p_split_cash else 0 end,
    case p_payment_method when 'bank_transfer' then v_final when 'split' then v_final - p_split_cash else 0 end,
    v_products, v_discount, 0, 1, 0, 0);
  perform public.fusion_post_visit(v_customer.id, v_date, 1, v_final, coalesce(v_session.billable_seconds, 0)::bigint);

  if v_session.id is not null then
    -- The session keeps the charge actually billed (and the custom rate, if any).
    update public.sessions
    set status = 'completed', customer_id = coalesce(v_customer.id, customer_id),
        customer_name = coalesce(v_customer_name, customer_name),
        custom_rate_per_minute = v_custom_rate, base_amount = v_base
    where id = v_session.id;
    delete from public.session_items where session_id = v_session.id;
    update public.bookings set status = 'completed', updated_at = public.fusion_now()
    where session_id = v_session.id and status = 'started';
  end if;

  return public.fusion_receipt_json(v_sale_id);
end;
$function$;

-- continue_after_allocation(p_session_id uuid)
CREATE OR REPLACE FUNCTION public.continue_after_allocation(p_session_id uuid)
 RETURNS sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_session public.sessions;
  v_raw_ms bigint;
  v_booked_ms bigint;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.booked_seconds is null or v_session.status not in ('running', 'paused') then
    raise exception 'Only a booked session that is still in play can continue.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  -- 1100: tables priced by the hour are extended in 30-minute steps, never by the minute.
  if v_session.pricing_mode = 'hourly_special30' then
    raise exception 'This table is priced by the hour: extend it by 30 minutes or more instead.'
      using errcode = 'P0001', hint = 'use_extend';
  end if;
  if v_session.allocation_extended_at is not null then
    return v_session;
  end if;
  v_raw_ms := public.fusion_ms_between(v_session.started_at, coalesce(v_session.paused_at, public.fusion_now())) - v_session.paused_ms;
  v_booked_ms := v_session.booked_seconds::bigint * 1000;
  if v_raw_ms < v_booked_ms then
    raise exception 'This booking still has time left.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  update public.sessions
  set paused_ms = paused_ms + (v_raw_ms - v_booked_ms),
      allocation_extended_at = public.fusion_now(),
      allocation_alert_ack_at = coalesce(allocation_alert_ack_at, public.fusion_now())
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$function$;

-- end_session(p_session_id uuid)
CREATE OR REPLACE FUNCTION public.end_session(p_session_id uuid)
 RETURNS sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.app_users := public.fusion_require_user();
  v_session public.sessions;
  v_policy public.settings := public.fusion_billing_policy();
  v_paused_ms bigint;
  v_billable integer;
begin
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status not in ('running', 'paused') then
    raise exception 'This session has already ended.' using errcode = 'P0001', hint = 'invalid_state';
  end if;

  v_paused_ms := v_session.paused_ms
    + case when v_session.status = 'paused' then public.fusion_ms_between(v_session.paused_at, public.fusion_now()) else 0 end;
  -- 1000: a booking that was not continued holds at its booked time.
  v_billable := public.fusion_billable_seconds(v_session, public.fusion_now());

  update public.sessions
  set status = 'billing',
      paused_at = null,
      paused_ms = v_paused_ms,
      ended_at = public.fusion_now(),
      ended_by = v_me.id,
      billable_seconds = v_billable,
      base_amount = case pricing_mode
        -- 1300: the whole time at the under-1-hour rate below 60 billed minutes, else the hourly rate.
        when 'tiered_hourly' then public.fusion_tiered_charge(
          v_billable, hourly_rate, under_hour_rate, booked_seconds, booked_amount,
          v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
        -- 1500: ended early, an hourly + 30-minute table pays the minutes played.
        when 'hourly_special30' then public.fusion_slot_charge(
          v_billable, hourly_rate, special_30_rate, rate_per_minute, booked_seconds, booked_amount,
          v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes)
        else public.fusion_session_charge(
          v_billable, rate_per_minute, booked_seconds, booked_amount,
          v_policy.billing_increment_minutes, v_policy.billing_rounding, v_policy.minimum_charge_minutes) end
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$function$;

-- extend_session(p_session_id uuid, p_minutes integer, p_from_booked_seconds integer)
CREATE OR REPLACE FUNCTION public.extend_session(p_session_id uuid, p_minutes integer, p_from_booked_seconds integer)
 RETURNS sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_session public.sessions;
  v_raw_ms bigint;
  v_total integer;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.pricing_mode <> 'hourly_special30' then
    raise exception 'Only tables priced by the hour are extended in 30-minute steps.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if v_session.status not in ('running', 'paused') then
    raise exception 'Only a session that is still in play can be extended.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  if p_minutes is null or p_minutes < 30 or p_minutes % 30 <> 0 then
    raise exception 'Extend in steps of 30 minutes.' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_from_booked_seconds is distinct from v_session.booked_seconds then
    raise exception 'This session was just changed on another terminal. Check it and try again.'
      using errcode = 'P0001', hint = 'stale';
  end if;
  v_total := v_session.booked_seconds / 60 + p_minutes;
  if v_total > 1440 then
    raise exception 'A session can be booked for at most 24 hours.' using errcode = '22023', hint = 'invalid_input';
  end if;

  v_raw_ms := public.fusion_ms_between(v_session.started_at, coalesce(v_session.paused_at, public.fusion_now())) - v_session.paused_ms;
  update public.sessions
  set paused_ms = paused_ms + greatest(0, v_raw_ms - booked_seconds::bigint * 1000),
      booked_seconds = v_total * 60,
      booked_amount = public.fusion_slot_price(v_total, hourly_rate, special_30_rate),
      allocation_alert_ack_at = null
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$function$;

-- fusion_post_ledger(p_shift_id uuid, p_user_id uuid, p_date date, p_cash numeric, p_bank numeric, p_snack numeric, p_discount numeric, p_expenses numeric, p_invoices integer, p_voided_count integer, p_voided_amount numeric)
CREATE OR REPLACE FUNCTION public.fusion_post_ledger(p_shift_id uuid, p_user_id uuid, p_date date, p_cash numeric, p_bank numeric, p_snack numeric, p_discount numeric, p_expenses numeric, p_invoices integer, p_voided_count integer, p_voided_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.counter_shifts
  set cash_sales = cash_sales + p_cash,
      bank_sales = bank_sales + p_bank,
      snack_sales = snack_sales + p_snack,
      discounts = discounts + p_discount,
      expenses = expenses + p_expenses,
      invoice_count = invoice_count + p_invoices,
      voided_count = voided_count + p_voided_count,
      voided_amount = voided_amount + p_voided_amount
  where id = p_shift_id and status = 'open';
  if not found then
    raise exception 'This counter shift is closed; its totals are final.' using errcode = 'P0001', hint = 'shift_closed';
  end if;

  update public.shift_daily_totals
  set cash_sales = cash_sales + p_cash,
      bank_sales = bank_sales + p_bank,
      snack_sales = snack_sales + p_snack,
      discounts = discounts + p_discount,
      expenses = expenses + p_expenses,
      invoice_count = invoice_count + p_invoices,
      voided_count = voided_count + p_voided_count,
      voided_amount = voided_amount + p_voided_amount,
      updated_at = public.fusion_now()
  where shift_id = p_shift_id and business_date = p_date;
  if not found then
    insert into public.shift_daily_totals (shift_id, business_date, user_id, cash_sales, bank_sales, snack_sales,
                                           discounts, expenses, invoice_count, voided_count, voided_amount)
    values (p_shift_id, p_date, p_user_id, p_cash, p_bank, p_snack, p_discount, p_expenses,
            p_invoices, p_voided_count, p_voided_amount);
  end if;
end;
$function$;

-- fusion_post_product_sales(p_sale_id uuid, p_sign integer)
CREATE OR REPLACE FUNCTION public.fusion_post_product_sales(p_sale_id uuid, p_sign integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_sale public.sales;
  v_product_discount numeric;
  v_line record;
begin
  select s.* into v_sale from public.sales s where s.id = p_sale_id;
  if not found or v_sale.products_subtotal <= 0 then
    return;
  end if;
  v_product_discount := case when v_sale.base_amount + v_sale.products_subtotal > 0
                             then v_sale.discount * v_sale.products_subtotal / (v_sale.base_amount + v_sale.products_subtotal)
                             else 0 end;
  for v_line in
    select coalesce(i.product_id::text, 'name:' || i.product_name) as product_key,
           (array_agg(i.product_id))[1] as product_id,
           min(i.product_name) as product_name,
           sum(i.quantity)::integer as quantity,
           sum(i.line_total) as revenue,
           round(v_product_discount * sum(i.line_total) / v_sale.products_subtotal, 4) as discount,
           coalesce(sum(i.quantity) filter (where i.unit_cost is not null), 0)::integer as costed_quantity,
           coalesce(sum(i.line_total) filter (where i.unit_cost is not null), 0) as costed_revenue,
           round(v_product_discount * coalesce(sum(i.line_total) filter (where i.unit_cost is not null), 0)
                 / v_sale.products_subtotal, 4) as costed_discount,
           coalesce(sum(i.unit_cost * i.quantity) filter (where i.unit_cost is not null), 0) as cost
    from public.sale_items i
    where i.sale_id = p_sale_id
    group by 1
    order by 1
  loop
    if p_sign > 0 then
      insert into public.product_sales_daily as d
        (business_date, product_key, product_id, product_name, quantity, revenue, discount,
         costed_quantity, costed_revenue, costed_discount, cost)
      values (v_sale.business_date, v_line.product_key, v_line.product_id, v_line.product_name, v_line.quantity,
              v_line.revenue, v_line.discount, v_line.costed_quantity, v_line.costed_revenue, v_line.costed_discount,
              v_line.cost)
      on conflict (business_date, product_key) do update
      set product_id = coalesce(excluded.product_id, d.product_id),
          product_name = excluded.product_name,
          quantity = d.quantity + excluded.quantity,
          revenue = d.revenue + excluded.revenue,
          discount = d.discount + excluded.discount,
          costed_quantity = d.costed_quantity + excluded.costed_quantity,
          costed_revenue = d.costed_revenue + excluded.costed_revenue,
          costed_discount = d.costed_discount + excluded.costed_discount,
          cost = d.cost + excluded.cost,
          updated_at = public.fusion_now();
    else
      update public.product_sales_daily d
      set quantity = d.quantity - v_line.quantity,
          revenue = d.revenue - v_line.revenue,
          discount = d.discount - v_line.discount,
          costed_quantity = d.costed_quantity - v_line.costed_quantity,
          costed_revenue = d.costed_revenue - v_line.costed_revenue,
          costed_discount = d.costed_discount - v_line.costed_discount,
          cost = d.cost - v_line.cost,
          updated_at = public.fusion_now()
      where d.business_date = v_sale.business_date and d.product_key = v_line.product_key;
      delete from public.product_sales_daily d
      where d.business_date = v_sale.business_date and d.product_key = v_line.product_key and d.quantity = 0;
    end if;
  end loop;
end;
$function$;

-- fusion_post_visit(p_customer_id uuid, p_date date, p_invoices integer, p_spent numeric, p_seconds bigint)
CREATE OR REPLACE FUNCTION public.fusion_post_visit(p_customer_id uuid, p_date date, p_invoices integer, p_spent numeric, p_seconds bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_customer_id is null then
    return;
  end if;
  if p_invoices > 0 then
    insert into public.customer_visits as v (customer_id, business_date, invoices, spent, play_seconds, last_at)
    values (p_customer_id, p_date, p_invoices, p_spent, p_seconds, public.fusion_now())
    on conflict (customer_id, business_date) do update
      set invoices = v.invoices + excluded.invoices,
          spent = v.spent + excluded.spent,
          play_seconds = v.play_seconds + excluded.play_seconds,
          last_at = greatest(v.last_at, excluded.last_at);
  else
    delete from public.customer_visits v
    where v.customer_id = p_customer_id and v.business_date = p_date and v.invoices + p_invoices <= 0;
    if not found then
      update public.customer_visits
      set invoices = invoices + p_invoices, spent = spent + p_spent, play_seconds = play_seconds + p_seconds
      where customer_id = p_customer_id and business_date = p_date;
    end if;
  end if;
end;
$function$;

-- open_counter()
CREATE OR REPLACE FUNCTION public.open_counter()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.app_users := public.fusion_require_user();
  v_id uuid;
begin
  if v_me.role = 'admin' then
    raise exception 'Administrators manage the business and do not run a counter.'
      using errcode = '42501', hint = 'admin_no_sales';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(7316, pg_catalog.hashtext(v_me.id::text));
  select c.id into v_id from public.counter_shifts c where c.user_id = v_me.id and c.status = 'open';
  if v_id is null then
    insert into public.counter_shifts (user_id, staff_name, business_date)
    values (v_me.id, v_me.full_name, public.fusion_business_date(public.fusion_now()))
    returning id into v_id;
  end if;
  return public.fusion_shift_json(v_id);
end;
$function$;

-- pause_session(p_session_id uuid)
CREATE OR REPLACE FUNCTION public.pause_session(p_session_id uuid)
 RETURNS sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_session public.sessions;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status <> 'running' then
    raise exception 'Only a running session can be paused.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  update public.sessions set status = 'paused', paused_at = public.fusion_now()
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$function$;

-- reopen_session(p_session_id uuid)
CREATE OR REPLACE FUNCTION public.reopen_session(p_session_id uuid)
 RETURNS sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_session public.sessions;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status <> 'billing' then
    raise exception 'Only a session awaiting checkout can be reopened.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  update public.sessions
  set status = 'running',
      paused_ms = paused_ms + public.fusion_ms_between(ended_at, public.fusion_now()),
      ended_at = null, ended_by = null, billable_seconds = null, base_amount = null
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$function$;

-- resume_session(p_session_id uuid)
CREATE OR REPLACE FUNCTION public.resume_session(p_session_id uuid)
 RETURNS sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_session public.sessions;
begin
  perform public.fusion_require_user();
  v_session := public.fusion_lock_session(p_session_id);
  if v_session.status <> 'paused' then
    raise exception 'Only a paused session can be resumed.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  update public.sessions
  set status = 'running',
      paused_ms = paused_ms + public.fusion_ms_between(paused_at, public.fusion_now()),
      paused_at = null
  where id = p_session_id returning * into v_session;
  return v_session;
end;
$function$;

-- save_customer(p_id uuid, p_name text, p_phone text)
CREATE OR REPLACE FUNCTION public.save_customer(p_id uuid, p_name text, p_phone text)
 RETURNS customers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_customer public.customers;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := public.fusion_normalize_phone(p_phone);
begin
  perform public.fusion_require_perm('manage_customers', 'edit customers');
  if char_length(v_name) not between 1 and 80 then
    raise exception 'Customer name is required (up to 80 characters).' using errcode = '22023', hint = 'invalid_input';
  end if;
  if p_id is null then
    insert into public.customers (name, phone) values (v_name, v_phone) returning * into v_customer;
  else
    update public.customers set name = v_name, phone = v_phone, updated_at = public.fusion_now()
    where id = p_id returning * into v_customer;
    if not found then
      raise exception 'Customer not found.' using errcode = 'P0002', hint = 'not_found';
    end if;
  end if;
  return v_customer;
exception
  when unique_violation then
    raise exception 'Another customer already uses phone number %.', v_phone
      using errcode = '23505', hint = 'duplicate_phone';
end;
$function$;

-- set_session_item_quantity(p_item_id uuid, p_quantity integer)
CREATE OR REPLACE FUNCTION public.set_session_item_quantity(p_item_id uuid, p_quantity integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_item public.session_items;
  v_session public.sessions;
  v_product public.inventory_products;
  v_delta integer;
begin
  perform public.fusion_require_user();
  if p_quantity is null or p_quantity < 0 or p_quantity > 999 then
    raise exception 'Quantity must be between 0 and 999.' using errcode = '22023', hint = 'invalid_input';
  end if;
  select i.* into v_item from public.session_items i where i.id = p_item_id;
  if not found then
    raise exception 'That item is no longer on the tab.' using errcode = 'P0002', hint = 'not_found';
  end if;
  v_session := public.fusion_lock_session(v_item.session_id);
  if v_session.status = 'completed' then
    raise exception 'This session has already been paid.' using errcode = 'P0001', hint = 'invalid_state';
  end if;
  select i.* into v_item from public.session_items i where i.id = p_item_id for update;
  if not found then
    raise exception 'That item is no longer on the tab.' using errcode = 'P0002', hint = 'not_found';
  end if;

  v_delta := p_quantity - v_item.quantity;
  select p.* into v_product from public.inventory_products p where p.id = v_item.product_id for update;
  if v_delta > 0 and v_product.track_stock and v_product.stock_quantity < v_delta then
    if not public.fusion_is_replay() then
      raise exception 'Only % × % left in stock.', v_product.stock_quantity, v_product.name
        using errcode = 'P0001', hint = 'insufficient_stock';
    end if;
    -- 2000: sold while offline, so it really happened: stock stops at zero and the shortfall is logged.
    perform public.fusion_log_offline_shortfall(v_product, v_delta, auth.uid());
  end if;
  if v_product.track_stock and v_delta <> 0 then
    update public.inventory_products set stock_quantity = greatest(stock_quantity - v_delta, 0), updated_at = public.fusion_now()
    where id = v_product.id;
  end if;

  if p_quantity = 0 then
    delete from public.session_items where id = p_item_id;
  else
    update public.session_items set quantity = p_quantity where id = p_item_id;
  end if;
end;
$function$;

-- start_session(p_table_id uuid, p_booking text, p_minutes integer, p_amount numeric, p_customer_id uuid, p_customer_name text, p_customer_phone text)
CREATE OR REPLACE FUNCTION public.start_session(p_table_id uuid, p_booking text DEFAULT 'open'::text, p_minutes integer DEFAULT NULL::integer, p_amount numeric DEFAULT NULL::numeric, p_customer_id uuid DEFAULT NULL::uuid, p_customer_name text DEFAULT NULL::text, p_customer_phone text DEFAULT NULL::text)
 RETURNS sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.app_users := public.fusion_require_user();
  v_customer public.customers;
  v_table public.club_tables;
  v_category public.table_categories;
  v_rate numeric(12, 4);
  v_booked_seconds integer;
  v_booked_amount numeric(12, 2);
  v_session public.sessions;
begin
  select t.* into v_table from public.club_tables t where t.id = p_table_id for update;
  if not found or not v_table.is_active then
    raise exception 'Table not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  perform public.fusion_assert_floor(v_table.floor_id);

  if exists (select 1 from public.sessions s
             where s.table_id = p_table_id and s.status in ('running', 'paused', 'billing')) then
    raise exception 'Table "%" is already in use. End its current session first.', v_table.name
      using errcode = 'P0001', hint = 'table_busy';
  end if;

  -- 1100: the category's pricing mode decides how the session is priced.
  select c.* into v_category from public.table_categories c where c.id = v_table.category_id;
  -- 1300: a table's own per-minute rate applies to per-minute categories only.
  v_rate := case when v_category.pricing_mode <> 'per_minute' then v_category.rate_per_minute
                 else coalesce(v_table.rate_override, v_category.rate_per_minute) end;
  if v_category.pricing_mode = 'hourly_special30' and coalesce(p_booking, 'open') <> 'minutes' then
    raise exception '% is priced by the hour: choose a duration (30 minutes, 1 hour, 1.5 hours …).', v_category.name
      using errcode = '22023', hint = 'duration_required';
  end if;

  case coalesce(p_booking, 'open')
    when 'open' then
      null;
    when 'minutes' then
      if p_minutes is null or p_minutes < 1 or p_minutes > 1440 then
        raise exception 'Booked time must be between 1 and 1440 minutes.' using errcode = '22023', hint = 'invalid_input';
      end if;
      v_booked_seconds := p_minutes * 60;
      if v_category.pricing_mode = 'hourly_special30' then
        -- 1100: 30 minutes = the special price; 1 hour or more = the hourly rate × hours.
        if p_minutes % 30 <> 0 then
          raise exception 'Choose the time in steps of 30 minutes.' using errcode = '22023', hint = 'invalid_input';
        end if;
        v_booked_amount := public.fusion_slot_price(p_minutes, v_category.hourly_rate, v_category.special_30_rate);
      elsif v_category.pricing_mode = 'tiered_hourly' then
        -- 1300: under an hour at the under-1-hour rate, an hour or more at the hourly rate.
        v_booked_amount := public.fusion_tier_price(p_minutes, v_category.hourly_rate, v_category.under_hour_rate);
      else
        v_booked_amount := public.fusion_amount_for_minutes(p_minutes, v_rate);
      end if;
    when 'amount' then
      if p_amount is null or p_amount <= 0 or p_amount > 1000000 or p_amount <> round(p_amount, 2) then
        raise exception 'Enter a valid amount.' using errcode = '22023', hint = 'invalid_input';
      end if;
      v_booked_seconds := case when v_category.pricing_mode = 'tiered_hourly'
                               then public.fusion_tier_seconds(p_amount, v_category.hourly_rate, v_category.under_hour_rate)
                               else floor(p_amount * 60 / v_rate)::integer end;
      if v_booked_seconds < 60 then
        raise exception 'PKR % does not cover one minute of play at PKR %/min.', p_amount, trim_scale(v_rate)
          using errcode = '22023', hint = 'invalid_input';
      end if;
      v_booked_amount := p_amount;
    else
      raise exception 'Unknown booking type.' using errcode = '22023', hint = 'invalid_input';
  end case;

  v_customer := public.fusion_resolve_customer(p_customer_id, p_customer_name, p_customer_phone);

  -- 1100: the session keeps the category's prices from this moment on.
  insert into public.sessions (table_id, customer_id, customer_name, status, rate_per_minute, booked_seconds,
                               booked_amount, started_at, started_by, started_shift_id,
                               pricing_mode, hourly_rate, special_30_rate, under_hour_rate)
  values (p_table_id, v_customer.id,
          coalesce(v_customer.name, nullif(btrim(coalesce(p_customer_name, '')), '')),
          'running', v_rate, v_booked_seconds, v_booked_amount, public.fusion_now(), v_me.id,
          (select c.id from public.counter_shifts c where c.user_id = v_me.id and c.status = 'open'),
          v_category.pricing_mode,
          case when v_category.pricing_mode <> 'per_minute' then v_category.hourly_rate end,
          case when v_category.pricing_mode = 'hourly_special30' then v_category.special_30_rate end,
          case when v_category.pricing_mode = 'tiered_hourly' then v_category.under_hour_rate end)
  returning * into v_session;
  return v_session;
exception
  when unique_violation then
    raise exception 'This table is already in use.' using errcode = 'P0001', hint = 'table_busy';
end;
$function$;

-- void_expense(p_expense_id uuid)
CREATE OR REPLACE FUNCTION public.void_expense(p_expense_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_me public.app_users := public.fusion_require_user();
  v_expense public.expenses;
  v_shift public.counter_shifts;
begin
  select e.* into v_expense from public.expenses e where e.id = p_expense_id for update;
  if not found or (v_me.role <> 'admin' and v_expense.user_id <> v_me.id) then
    raise exception 'Expense not found.' using errcode = 'P0002', hint = 'not_found';
  end if;
  if v_expense.voided_at is not null then
    return to_jsonb(v_expense);
  end if;
  select c.* into v_shift from public.counter_shifts c where c.id = v_expense.shift_id for update;
  if v_shift.status <> 'open' then
    raise exception 'This expense belongs to a closed counter shift; its totals are final.'
      using errcode = 'P0001', hint = 'shift_closed';
  end if;
  update public.expenses set voided_at = public.fusion_now(), voided_by = v_me.id where id = p_expense_id returning * into v_expense;
  perform public.fusion_post_ledger(v_shift.id, v_expense.user_id, v_expense.business_date, 0, 0, 0, 0,
                                    -v_expense.amount, 0, 0, 0);
  return to_jsonb(v_expense);
end;
$function$;

-- 5. The upload log ------------------------------------------------------------------------------
create table public.sync_operations (
  id           uuid primary key,
  user_id      uuid not null references public.app_users (id) on delete cascade,
  device_id    text not null check (device_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  kind         text not null,
  occurred_at  timestamptz not null,
  received_at  timestamptz not null default now(),
  result       jsonb
);
create index sync_operations_received on public.sync_operations (received_at);
create index sync_operations_user on public.sync_operations (user_id, received_at desc);
comment on table public.sync_operations is
  'Actions uploaded by devices (id made on the device): makes each one apply once. Kept 14 days.';

alter table public.sync_operations enable row level security;
-- Administrators see which actions arrived late (made offline); nobody writes here except sync_operation.
create policy "fusion sync operations: admins read" on public.sync_operations
  for select to authenticated using ((select public.fusion_is_admin()));
revoke all on table public.sync_operations from public, anon, authenticated;
grant select on table public.sync_operations to authenticated;

-- 6. Uploading one action -------------------------------------------------------------------------
create function public.sync_operation(p_id uuid, p_kind text, p_occurred_at timestamptz, p_args jsonb, p_device text)
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
      'counter.open', 'expense.add', 'expense.void') then
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
                'session.extend') then
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

-- 7. The product catalogue for selling offline ------------------------------------------------------
-- Every product on sale, so a device can search and sell offline (search_products returns at most 100).
create function public.get_product_catalog()
returns table (id uuid, name text, category text, selling_price numeric, track_stock boolean, stock_quantity integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.fusion_require_user();
  return query
    select p.id, p.name, p.category, p.selling_price, p.track_stock, p.stock_quantity
    from public.inventory_products p where p.is_active order by p.name limit 5000;
end;
$$;

-- 8. Grants ------------------------------------------------------------------------------------------
revoke all on function public.fusion_now(), public.fusion_is_replay(), public.fusion_touch_session(),
  public.fusion_log_offline_shortfall(public.inventory_products, integer, uuid),
  public.sync_operation(uuid, text, timestamptz, jsonb, text), public.get_product_catalog() from public, anon, authenticated;
-- Any signed-in account (each calls fusion_require_user(); every action checks its own permissions).
grant execute on function public.sync_operation(uuid, text, timestamptz, jsonb, text), public.get_product_catalog() to authenticated;
