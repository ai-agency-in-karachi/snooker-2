# Offline mode

FUSION keeps the floor running with no internet: tables start, pause and end,
snacks go on tabs, checkouts take cash, bank or split payments, and counter
expenses are recorded. Everything is saved on the device first and uploads by
itself when the connection is back, exactly once, at the time it happened.

## What works offline

| Works offline (saved on the device, uploaded later) | Needs the internet |
|---|---|
| Start, pause, resume, end, reopen, cancel, extend a table; "time's up" (silence / keep playing); Off / On games, giving snacks to a player, marking shares paid | Signing in an account for the first time on a device |
| Snacks on a tab (add, change, remove) | Closing a counter (the cash count is checked against every sale) |
| Checkout: table or counter sale, cash / bank / split, discounts, custom rates, receipts (numbered once uploaded) | Reports, History, Expenses (business), Inventory edits, Staff, Settings, Pre-bookings, reset / export |
| Opening a counter; counter expenses (add, void) | Deleting a sale, closing a business day |
| Switching between accounts already signed in on the device | |
| The app itself opens with no connection (installed as a PWA or in the browser) | |

Pages that need the internet show *"You're offline. This loads when the
connection is back."*; buttons for online-only actions say so instead of
waiting.

## How it works

```
 screen ──► floor action ──► device queue (IndexedDB) ──► uploader ──► sync_operation() ──► the usual database function
   ▲             │                     │                        │               (once per id, at the action's time)
   └── shown at once (offline) ◄───────┘                        └── retried with back-off while offline
```

1. **Saved first.** A floor action (`src/renderer/src/offline/ops.ts`) is
   written to the device's IndexedDB (`fusion-offline` → `ops`) before
   anything else. It carries an id made on the device, the account that did
   it, and the time it happened (server-aligned, `lib/clock.ts`: the offset to
   the server is kept on the device, and within a page time runs from a
   monotonic clock, so changing the PC's clock does not move it).
2. **Shown at once.** Screens show the last data from the server with the
   device's actions applied on top (`offline/overlay.ts`), computed with the
   same billing code as the server (`shared/billing.ts`). Online, an action
   still appears once the server has answered (using the server's own row),
   so nobody sees a state the server has not accepted.
3. **Uploaded once, in order.** The uploader (`offline/engine.ts`) sends
   actions oldest first through `sync_operation()` (migration 2000). One tab
   uploads at a time (Web Locks); the others are told through a
   BroadcastChannel. Ids made on the device (a session started offline) are
   replaced by the server's ids for the actions that follow.
4. **Each with its own account.** An action uploads with the session of the
   account that did it — the active one, or another account kept on the
   device (its stored session is refreshed under a per-account lock and
   written back, so two refreshes never use the same token).
5. **The data to work with.** Each account's floor data (tables, products and
   stock, its counter, settings, product images list) is kept on the device
   (`offline/persist.ts`) and shown at start-up, then refreshed from the
   server whenever online. Product images and profile pictures are kept by
   the service worker once seen.
6. **The app itself.** The web build generates `sw.js` (`vite.web.config.ts`,
   `src/renderer/sw.template.js`): every file of that version is kept on the
   device. Pages load network-first (updates arrive) and fall back to the kept
   version offline. A new version waits for **Sync → Update now** (offered
   once nothing is waiting to upload) or the next start — never mid-checkout.

## The guarantees

- **No duplicates.** `sync_operation` claims the action id in
  `sync_operations` (primary key) in the same transaction as the action
  itself. A repeat — a lost reply, a retry, a second tab — waits for the first
  and gets the first answer back; nothing is applied twice. Checkouts also
  keep their existing `client_ref` idempotency.
- **No overwrites.** Actions are commands checked against what is there now,
  never blind writes. A time-sensitive session action older than that
  session's last change by any device is refused (`stale_state`); tab
  quantities are applied as a change ("was 2, now 3") on top of whatever the
  tab holds; prices, permissions, an open counter and the session's state are
  checked exactly as online.
- **No data loss.** An action leaves the queue only when the server has
  accepted it, or when a person sets it aside. A refused action stays as
  **needs attention** with the reason (Sync panel → Try again / Set aside);
  what depends on it waits with it. Set-aside actions are kept 30 days and
  can be exported. Signing out never deletes queued actions: they upload when
  that account signs in on the device again.
- **The right time.** An action is recorded at the time it happened (the
  floor functions read `fusion_now()`, the action's time inside an upload),
  so billing, business days and every timestamp are as if it had been online.
  The server accepts actions up to 2 minutes ahead of its clock and 72 hours
  back.
- **Sales that happened are recorded.** A sale made offline is recorded even
  if another device sold the last units meanwhile: stock stops at zero and the
  shortfall is logged in the stock log (`offline_oversold`). Online sales are
  still refused beyond stock.

## The owner's decisions (confirmed 2026-11-10)

Kept as proposed; each is one line to change.

| Decision | Choice | Where |
|---|---|---|
| Oldest action the server accepts | 72 hours | `sync_operation` (migration 2000) |
| Offline sale beyond stock | recorded, stock stops at 0, shortfall logged | `fusion_log_offline_shortfall` |
| Closing a counter offline | not allowed (needs internet and everything uploaded) | `MyCounterPage` close dialog |
| Receipt number offline | "Pending (made offline)"; the server numbers it on upload (reprint from History) | `shared/receipt.ts` |
| A table started on two devices during an outage | the first upload wins; the other is "needs attention" | `start_session` (unchanged) |

## The status indicator

The pill in the top bar (phones: an icon) shows **All synced**, **Syncing
N…**, **Offline · N saved on this device**, **N waiting for sign-in** or
**N need attention**. It opens the Sync panel: needs attention (with Try
again / Set aside), waiting to upload (and what each waits for), uploaded
recently, set aside (export), a *Sync now* button and, for administrators,
the actions that arrived late in the last 7 days (made offline) so their
times can be reviewed.

## Testing it locally

1. `npm run build` then `npm run preview` (the service worker only runs in a
   production build), open http://localhost:4173 and sign in.
2. Open the floor once online (Tables, Snacks) so its data is on the device.
3. DevTools → Network → **Offline** (or unplug the network): the pill turns
   *Offline*. Start a table, add a snack, end it, check out; sell a snack on
   the Snacks floor. Reload — the app opens, the actions are still there.
4. Go back online: the pill shows *Syncing*, then *All synced*; History shows
   the sales at the times they were made, each once.
5. Conflict: offline, start a table; on another device (online) start the same
   table; reconnect — the pill shows *1 needs attention*.

Automated: `tests/db/offline-sync.test.ts` (server: once, at the right time,
no overwrites, stock), `tests/unit/sync-engine.test.ts` (queue: order, lost
replies, refusals, sign-out, restart), `tests/unit/offline-overlay.test.ts`
(screens: billing as the server), and the end-to-end test *"offline: the
floor keeps working…"* (real browser, offline, reload, reconnect, conflict).
