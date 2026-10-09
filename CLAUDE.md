# CLAUDE.md

Fast generic room-booking frontend for Robin (robinpowered.com), replacing the slow
dashboard.robinpowered.com UI. Works with any Robin org/building — the user's organization and
location are discovered from the API after login. Static single-page app served by a Cloudflare
Worker at robin.aok.site — the browser talks to Robin's REST API directly (CORS is `*`). The
Worker has one server route, `GET /api/users` (`worker.js`): a proxy for the GraphQL people
directory, which is CORS-allowlisted to Robin's own dashboards and so unreachable from the
browser. It forwards the caller's own `Authorization`/`Tenant-Id` headers upstream (persisted
query `getPagedUsers`, hash in worker.js, captured from the dashboard's own requests) — no
credentials live in the Worker.

## Public repo: no account specifics

This repo is going to be public. Never put anything about the author's own Robin account,
org, buildings, floors, rooms or desks in tracked files (README, CLAUDE.md, code comments,
tool descriptions, tests): no real desk codes, room names, building names, floor numbers,
org ids, account ids or email addresses. Use obviously generic examples (desk `3A1`, "Room
A") and describe room types by Robin's `type` values, not by what the author's building has.
Deployment config (`robin.aok.site`, the KV namespace id in `wrangler.jsonc`) is fine.

## Commands

```bash
wrangler dev --port 8787   # local dev
wrangler deploy            # deploy to the personal "aok" Cloudflare account
```

No build step, no dependencies (so Dependabot in `.github/dependabot.yml` only watches github-actions, a no-op until workflows exist). `public/`: `index.html` (markup shell), `app.js` (all logic),
`style.css`, `_headers` (CSP + security headers — script/style must stay in external files; the
CSP has no `unsafe-inline`, so inline `style=` attributes in JS-generated HTML are blocked too;
use classes or the `hidden` attribute).

## Robin API notes (hard-won, verify before "fixing")

Base: `https://api.robinpowered.com/v1.0`. Discovered by watching the dashboard's requests plus
probing; Robin's public docs don't cover most of this.

- **Auth**: `POST /auth/users` with HTTP Basic (email/password) and JSON body
  `{"remember_me":true}` (the `organization` field is optional) → `data.access_token`
  (+ `account_id`, `expire_at`). `remember_me:false` gives a ~2h token; `true` gives ~14 days.
  Scopes are always just `basic_read, basic_write`. Send as `Authorization: Access-Token <token>`.
- **Org/location discovery**: `GET /me/organizations` → the user's orgs (filter `disabled_at`);
  `GET /organizations/{id}/locations?per_page=100` → locations with `time_zone`. Most requests
  also want a `Tenant-Id: <org id>` header (`/me/organizations` works without it).
- **Spaces**: `GET /locations/{locId}/spaces?per_page=200&include=calendar` — one request returns
  all spaces with their calendars. Bookable rooms have `behaviors` containing `"scheduling"` and a
  non-null `calendar`. A few scheduling spaces have no calendar and
  cannot be booked via `POST /events`; since 2026-10-08 the app drops every calendar-less space
  so they never appear in the grid or map.
  Spaces also carry `description` (room notes, e.g. broken-equipment warnings) and `image` (photo
  on static.robinpowered.com — that host must stay in the CSP img-src). Gotcha: `type: "other"`
  spaces with no calendar are tenant office areas drawn on the floorplan,
  not rooms — Robin's own UI hides them. Some bookable non-meeting rooms (wellness rooms etc.) are also `type: "other"` but WITH
  calendars, so the filter must key on the calendar, never on `type`.
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
  **You must also pass `invitees: [{email: <your email>}]`** — without it the event exists only on
  the room's calendar: it never appears in the user's Robin schedule (`/me/events`), and no
  calendar invite/email is sent. With the invitee it shows in `/me/events` (which is what the
  dashboard's schedule/user view reflects) and Google emails the invite. `is_organizer: true` in
  the invitee is ignored (the resource calendar stays organizer).
- **Edit**: `PATCH /events/{id}` with any subset of `{title, description, invitees, visibility,
  start, end, recurrence}` (send `start` and `end` together when changing times). No PUT (405).
  `space_id`/`calendar_mailbox_address` in a PATCH are silently ignored (200, unchanged) — moving
  an event to another room requires POST new + DELETE old.
  `recurrence` PATCHes only on the series master id — an instance id 400s; `recurrence: null`
  removes the rule, and adding a rule to a plain event turns it into a series. `description`
  works on POST/PATCH and comes back in both GET and the events list.
- **Cancel**: `DELETE /events/{id}` (works for own events). For recurring series, instance ids
  look like `{masterId}_{YYYYMMDDTHHMMSSZ}`; DELETE on an instance id cancels just that
  occurrence, DELETE on the master id cancels the whole series.
- **Recurring**: pass `recurrence: ["RRULE:..."]` (standard RRULE) in the `POST /events` body;
  instances materialize on the room calendar within a couple seconds. Verified accepted:
  FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, BYDAY (multi-day and ordinal like `1FR`/`-1MO`),
  BYMONTHDAY, COUNT, UNTIL, and never-ending rules (no COUNT/UNTIL). Google reorders params on
  storage (e.g. COUNT before INTERVAL) — parse by key, not position.
- **Private**: `visibility: "private"` in the `POST /events` body (default `"default"`).
- **Extra attendees**: more entries in `invitees`. Only org-member emails are retained by Robin
  (an external gmail was silently dropped from the invitee list); `is_organizer: true` is ignored.
- **Amenities**: `GET /spaces/{id}/amenities` per space (one request each; the app caches them in
  the spaces localStorage blob). Gotcha: `include=amenities` on the spaces *list* returns `[]`
  for every space even though the per-space endpoint has data — don't "simplify" to it.
- **`GET /free-busy/spaces` is broken** (500 for every parameter format tried) — don't use it;
  that's why the app fans out per-space event fetches instead.
- **CORS**: `access-control-allow-origin: *` on api.robinpowered.com, so no proxy is needed.
- **Levels (floors)**: `GET /locations/{locId}/levels`. Spaces carry `level_id`.
- **Floorplans / map geometry** live on a separate service, `atlas.services.robinpowered.com`
  (CORS `*` too; same `Access-Token` auth + `Tenant-Id` header):
  - `GET /floorplans/levels?ids=<levelIds>` → per level a public `svg` URL
    (storage.googleapis.com, no auth) and `bounds` (always the full `[-180..180]×[-90..90]`).
  - `GET /layers/spaces?ids=<spaceIds>` → GeoJSON Polygon features, `properties.ownerId` = space
    id, coords in that same world space with **y up** (map to pixels via
    `xpx=(x+180)/360*W`, `ypx=(90-y)/180*H` where W×H is the floorplan SVG's intrinsic size).
  - `GET /layers/levels?ids=...` returns `[]` and `GET /organizations/{org}/layers/all` returns
    markers (restrooms etc.) — the per-space query above is the useful one.
- **Dark Reader gotcha**: the user's browser runs Dark Reader, whose fallback stylesheet sets
  `background-color` on *every* element with `!important`. The floorplan is therefore rendered as
  one self-contained inline `<svg>` (white `<rect>` + `<image>` + polygons) — SVG shapes use
  `fill`, which background overrides can't touch. A plain `<img>`/`<canvas>` with a transparent
  overlay SVG gets its background repainted dark and the floorplan becomes invisible.
- GraphQL (`federation-gateway.robinpowered.com/graphql`) exists (persisted queries, used by the
  people directory) but has introspection disabled and its CORS allowlist covers
  only Robin's own origins, so the browser can't call it — hence the Worker proxy. REST's
  `/organizations/{id}/users` is 403 for non-admin members; the GraphQL persisted query is the
  only member-accessible directory. Event descriptions synced from Google Calendar are HTML —
  render via DOMParser textContent, never innerHTML.

## App architecture

- Auth token + account_id stored in `localStorage["robin.auth"]`; the chosen org/building in
  `localStorage["robin.site"]` (`{org_id, org_name, loc_id, loc_name, tz}` — auto-picked when the
  account has exactly one, otherwise a picker card is shown; the building button in the header's
  hamburger menu switches).
  Spaces/map/floor caches are keyed per location: `robin.spaces.v2:<locId>`, `robin.map:<locId>`,
  `robin.level:<locId>`; spaces refresh in the background. On 401 the app logs out.
- Grid: rooms × 15-min slots (8:00–19:00). Click a free slot → book popover; click one of your own
  bookings (green) → cancel. "Mine" = `creator_id` matches the logged-in `account_id`.
- The header's "Free at" select (`#freeat`, state `filterMin`: `null` / `"now"` / minute-of-day) is
  the one time filter for both views: it hides rooms busy in that 30-min window in the grid (and
  tints the two columns) and picks the time the map colours by. With no filter the map colours by
  the current time (today) or 9:00. There is no separate map-only time picker.
- The wrangler `compatibility_date` is pinned to 2026-05-01 because the installed wrangler
  4.92.0's local runtime rejects newer dates; bump alongside a wrangler upgrade if desired.

## MCP server (`/mcp`) and OAuth

Added 2026-10-08 so Claude Desktop / claude.ai (custom connector, URL `https://robin.aok.site/mcp`)
and any other MCP client can book rooms. Multi-user by design: each person connects with their
own Robin account.

- `worker.js` wraps everything in `OAuthProvider` from `@cloudflare/workers-oauth-provider`
  (the repo's only dependency; `bun install`, wrangler bundles it). Provider-owned routes:
  `/oauth/token`, `/oauth/register` (DCR), `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource/mcp`. KV binding `OAUTH_KV` (namespace
  `526c7be479d541b6be6eea90220c6819` on the personal account) holds clients, grants and tokens;
  `props` are encrypted with key material wrapped by the token, so KV never holds a usable
  Robin token in the clear. `compatibility_flags: ["global_fetch_strictly_public"]` is required
  for CIMD client lookups.
- **`/authorize` is the consent page, rendered by the Worker** (`consentPage()` in worker.js,
  script `public/authorize.js`, styles at the end of `style.css`). The browser logs in to
  Robin directly (`POST /auth/users`, `remember_me: true`), picks the org if there are several
  (no building picker: every location of the org is stored and tools take an optional
  `building`, defaulting to the first), then POSTs JSON `{handle, decision, token, account_id,
  email, expire_at, org_id, org_name, locations: [{id, name, tz}]}` to `/authorize`. The Worker verifies the token with
  `GET /me/organizations` (and that `org_id` is one of them) before `approveConsent` +
  `completeAuthorization`, so a caller can only bind their own Robin session. **The password
  never reaches the Worker** — keep it that way; it is the whole trust argument for other users.
  The page sets its own CSP (`_headers` only covers static assets).
- Robin tokens last ~14 days and cannot be refreshed, so `tokenExchangeCallback` caps
  `accessTokenTTL` to the time left and throws `invalid_grant` (which revokes the grant) once
  `expire_at` has passed; `refreshTokenTTL` is 15 days. `/mcp` answers 401 `invalid_token` when
  the stored token is expired or Robin returns 401, which makes the client re-run the flow.
- `mcp.js` is a hand-rolled **stateless** Streamable HTTP server (POST JSON-RPC → JSON; GET 405,
  notifications 202, no batching, no sessions). Tools: `list_rooms`, `find_free_rooms`,
  `room_schedule`, `my_bookings`, `book_room` (conflict-checks first, always invites the user),
  `edit_booking`, `cancel_booking`, all with an optional `building`. "Mine" = `creator_id` match, same as the app (there is no
  verified `/me/events` usage; `my_bookings` fans out over all rooms). Spaces are cached in
  module memory for 10 min per org/location. Time parsing: `YYYY-MM-DDTHH:MM` is building-local
  (the chosen location's `tz`, via Intl offset math), anything with an offset/Z is taken as-is; output is always
  Robin's millisecond-free `±HH:MM` format. Robin API rules above apply unchanged.
- Local testing: `wrangler dev --port 8799 --local-protocol https` (8787 is often taken by
  another repo's dev server; **https is required** or the metadata is published as `http://`
  and the resource lookup 404s). Register a client with `POST /oauth/register`, GET
  `/authorize?...` with PKCE and a cookie jar, POST the approve JSON with the same jar, exchange
  the code at `/oauth/token`, then call `/mcp` with `Authorization: Bearer`. A real Robin token
  for the approve step can be minted from the `dashboard.robinpowered.com` rbw entry with
  `remember_me: false` (2 h). Verified end to end on 2026-10-08.
- **Office / nearest room** (2026-10-08): `set_office "3A1"` resolves a desk code against Robin
  **seats** — private offices are not spaces; they are seat groups (`3A1_1..3`) inside the
  per-floor desk spaces (`behaviors: ["seats"]`, `GET /spaces/{id}/seats?per_page=200`), which
  the app never shows. Geometry comes from atlas `GET /layers/seats?ids=…` (same world space as
  `/layers/spaces`; polygon centroids, chunked 100 ids per request). The office record
  `{building_id, level_id, floor, seat, x, y}` lives in `OAUTH_KV` under `prefs:robin-<account_id>`
  (plain JSON, keyed by Robin account so it survives reconnects; `env.OAUTH_KV` is passed into
  `handleMcp`). `find_free_rooms`/`list_rooms` then sort by centroid distance with a penalty of
  one floorplan-width per floor apart (`distance_rank`, `same_floor`), and `book_room` without a
  `room` books the nearest free non-`break_room` with capacity ≥ 2 (or `min_capacity`). Robin
  exposes no seat assignment for a user (`/me/seats`, `/users/{id}/assigned-seats`,
  `/reservations/seats?user_ids=` are 404/empty), so the office is always user-supplied. The
  floorplan SVG has no text, so labels can't be read from it.
