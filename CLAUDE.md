# CLAUDE.md

Fast generic room-booking frontend for Robin (robinpowered.com), replacing the slow
dashboard.robinpowered.com UI. Works with any Robin org/building — the user's organization and
location are discovered from the API after login. Static single-page app served by a Cloudflare
Worker (assets only, no server code) at robin.aok.site — the browser talks to Robin's API
directly (CORS is `*`).

## Commands

```bash
wrangler dev --port 8787   # local dev
wrangler deploy            # deploy to the personal "aok" Cloudflare account
```

No build step, no dependencies. `public/`: `index.html` (markup shell), `app.js` (all logic),
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
  non-null `calendar`. A few scheduling spaces have no calendar and cannot be booked this way.
  Spaces also carry `description` (room notes, e.g. broken-equipment warnings) and `image` (photo
  on static.robinpowered.com — that host must stay in the CSP img-src). Gotcha: `type: "other"`
  spaces with no calendar are tenant office areas drawn on the floorplan,
  not rooms — Robin's own UI hides them; the app filters them out. But some bookable non-meeting rooms (wellness rooms etc.) are also
  `type: "other"` WITH calendars, so only filter the calendar-less ones.
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
  `recurrence` PATCHes only on the series master id — an instance id 400s; `recurrence: null`
  removes the rule, and adding a rule to a plain event turns it into a series. `description`
  works on POST/PATCH and comes back in both GET and the events list.
- **Cancel**: `DELETE /events/{id}` (works for own events). For recurring series, instance ids
  look like `{masterId}_{YYYYMMDDTHHMMSSZ}`; DELETE on an instance id cancels just that
  occurrence, DELETE on the master id cancels the whole series.
- **Recurring**: pass `recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"]` (standard RRULE) in the
  `POST /events` body; instances materialize on the room calendar within a couple seconds.
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
  people directory) but has introspection disabled; the REST endpoints above are the
  usable surface for booking.

## App architecture

- Auth token + account_id stored in `localStorage["robin.auth"]`; the chosen org/building in
  `localStorage["robin.site"]` (`{org_id, org_name, loc_id, loc_name, tz}` — auto-picked when the
  account has exactly one, otherwise a picker card is shown; the header title button switches).
  Spaces/map/floor caches are keyed per location: `robin.spaces.v2:<locId>`, `robin.map:<locId>`,
  `robin.level:<locId>`; spaces refresh in the background. On 401 the app logs out.
- Grid: rooms × 15-min slots (8:00–19:00). Click a free slot → book popover; click one of your own
  bookings (green) → cancel. "Mine" = `creator_id` matches the logged-in `account_id`.
- The wrangler `compatibility_date` is pinned to 2026-05-01 because the installed wrangler
  4.92.0's local runtime rejects newer dates; bump alongside a wrangler upgrade if desired.
