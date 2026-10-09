# robin

A fast room-booking frontend for [Robin](https://robinpowered.com), replacing the slow
dashboard.robinpowered.com UI. Live at [robin.aok.site](https://robin.aok.site).

Sign in with your Robin account and you get a day grid of every bookable room in your
building — rooms × 15-minute slots — that loads in about a second. It works with any Robin
organization: your org and building are discovered from the API after login (with a picker
if you belong to several).

## Features

- **One-click booking** — click a free slot, set title/duration, book. Attendees get the
  Google Calendar invite as usual.
- **Drag to manage** — drag your bookings to another time or room, and drag the right edge
  to extend or shorten them, with live previews and 15-minute snapping.
- **Full editing** — title, description, attendees, time, duration, visibility, and
  recurrence, on single events or series.
- **Real recurrence** — daily/weekly/monthly/yearly, "every N", weekday pickers,
  day-of-month or nth-weekday patterns, ending never / after N / on a date. Rules the
  editor can't represent are preserved untouched.
- **Attendee autocomplete** — type a name or email and pick from the org directory.
- **Office map** — per-floor floorplans with clickable room shapes, colored by
  availability at a chosen time.
- **Room info** — capacity, amenity filters and emoji badges, photos, and room notes
  (e.g. "videoconferencing is broken") surfaced in the grid and booking popover.
- **Private bookings**, date navigation, minimum-capacity filter, light/dark theme.

## How it works

Static single-page app (vanilla JS, no build step, no dependencies) served by a Cloudflare
Worker. The browser talks to Robin's REST API directly — credentials never touch the
server. The Worker has exactly one server route, `/api/users`, which proxies Robin's
GraphQL people directory (browser-inaccessible due to its CORS allowlist) using the
caller's own token; no credentials are stored server-side.

```
public/
  index.html   markup shell
  app.js       all application logic
  style.css    styles (light/dark via prefers-color-scheme)
  _headers     CSP + security headers
worker.js      the /api/users directory proxy
wrangler.jsonc Cloudflare Worker config
```

Your Robin password is sent only to `api.robinpowered.com` (HTTP Basic, once, over TLS) to
mint an access token, which lives in your browser's localStorage along with cached room
data. A strict Content-Security-Policy (no inline script/style, allowlisted hosts only)
backstops the whole thing.

## Development

```bash
wrangler dev --port 8787   # local dev
wrangler deploy            # deploy
```

`CLAUDE.md` documents the reverse-engineered Robin API surface (auth, booking via
`POST /events` with the room's resource-calendar mailbox, recurrence semantics, the atlas
floorplan service, and assorted gotchas) — read it before touching API code, most of it
was hard-won and none of it is in Robin's public docs.

## MCP server (Claude Desktop, claude.ai, any MCP client)

The Worker is also a remote MCP server at `https://robin.aok.site/mcp`, so Claude can list
rooms and book, edit and cancel bookings for you. Add it as a custom connector (Claude
Desktop / claude.ai → Settings → Connectors → Add custom connector → that URL). Anyone with a
Robin account can use it; nothing is tied to one org or person.

Connecting opens `/authorize` on robin.aok.site. **Your Robin password never reaches this
server**: the page logs in to `api.robinpowered.com` from your browser (same as the app
itself) and hands the Worker only the resulting Robin access token, which it verifies
against Robin and stores encrypted in Workers KV, bound to the OAuth grant issued to your
Claude. Every tool call runs with your own token, so bookings are yours and nobody can see
or touch anyone else's. Robin tokens last about two weeks and cannot be refreshed; when
yours expires the connector asks you to reconnect.

Tools: `list_rooms`, `find_free_rooms`, `room_schedule`, `my_bookings`, `book_room`,
`edit_booking`, `cancel_booking`, each with an optional `building` when your org has several
(the first is the default). Times are building-local `YYYY-MM-DDTHH:MM`.

OAuth 2.1 with PKCE, dynamic client registration and Client ID Metadata Documents, via
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
(the Worker's only dependency). Discovery: `/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/mcp`.
