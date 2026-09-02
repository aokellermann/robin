# CLAUDE.md

Fast room-booking frontend for Robin (robinpowered.com), replacing the slow
dashboard.robinpowered.com UI. Static single-page app served by a Cloudflare Worker (assets only,
no server code) — the browser talks to Robin's API directly (CORS is `*`).

## Commands

```bash
wrangler dev --port 8787   # local dev
wrangler deploy            # deploy to the personal "aok" Cloudflare account
```

No build step, no dependencies. Everything is in `public/index.html`.

## Robin API notes (hard-won, verify before "fixing")

Base: `https://api.robinpowered.com/v1.0`. Discovered by watching the dashboard's requests plus
probing; Robin's public docs don't cover most of this.

- **Auth**: `POST /auth/users` with HTTP Basic (email/password) and JSON body
  `{"remember_me":true,"organization":<org id>}` → `data.access_token` (+ `account_id`,
  `expire_at`). `remember_me:false` gives a ~2h token; `true` gives ~14 days. Scopes are always
  just `basic_read, basic_write`. Send as `Authorization: Access-Token <token>`.
- **Spaces**: `GET /locations/{locId}/spaces?per_page=200&include=calendar` — one request returns
  all spaces with their calendars. Bookable rooms have `behaviors` containing `"scheduling"` and a
  non-null `calendar`. A few scheduling spaces have no calendar and cannot be booked this way.
- **Events for a day**: `GET /spaces/{id}/events?after=...&before=...&per_page=100`, one request
  per space, fanned out in parallel from the browser.
- **Timestamp format gotcha**: Robin 400s on `Date.toISOString()` output — it rejects the `.000`
  milliseconds. Use `YYYY-MM-DDTHH:MM:SS±HH:MM` (no millis). Responses use `-0700` (no colon)
  offsets, which `new Date()` parses fine.
- **Booking — the important part**: `POST /spaces/{id}/events` returns
  `403 "Booking this space is restricted to admins"` for normal members regardless of time of day.
  The path that works (what the dashboard effectively does) is `POST /events` with body:
  `{title, space_id, calendar_type, calendar_mailbox_address, start:{date_time,time_zone},
  end:{date_time,time_zone}}` where `calendar_type` = the space calendar's `remote_type`
  (`"google"`) and `calendar_mailbox_address` = its `space_resource_email`
  (`...@resource.calendar.google.com`). Returns 201 with the caller as `creator_id`. Rooms are
  Google resource calendars synced by Robin's scheduler account.
- **Cancel**: `DELETE /events/{id}` (works for own events).
- **`GET /free-busy/spaces` is broken** (500 for every parameter format tried) — don't use it;
  that's why the app fans out per-space event fetches instead.
- **CORS**: `access-control-allow-origin: *` on api.robinpowered.com, so no proxy is needed.
- GraphQL (`federation-gateway.robinpowered.com/graphql`) exists (persisted queries, used by the
  people directory) but has introspection disabled; the REST endpoints above are the
  usable surface for booking.

## App architecture

- Auth token + account_id stored in `localStorage["robin.auth"]`; spaces list cached in
  `localStorage["robin.spaces"]` and refreshed in the background. On 401 the app logs out.
- Grid: rooms × 15-min slots (8:00–19:00). Click a free slot → book popover; click one of your own
  bookings (green) → cancel. "Mine" = `creator_id` matches the logged-in `account_id`.
- The wrangler `compatibility_date` is pinned to 2026-05-01 because the installed wrangler
  4.92.0's local runtime rejects newer dates; bump alongside a wrangler upgrade if desired.
