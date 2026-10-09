// Stateless MCP server (Streamable HTTP, JSON responses) over Robin's REST API.
// Every call runs with the connected user's own Robin token (props from the OAuth grant),
// so bookings are theirs and nobody can see or touch anyone else's.
// Robin API knowledge mirrors public/app.js and CLAUDE.md — change both together.

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ATLAS = "https://atlas.services.robinpowered.com";
const SPACES_TTL = 10 * 60 * 1000;
const spacesCache = new Map(); // `${org}:${loc}` -> {at, spaces, levels, deskSpaces}
const geoCache = new Map();    // `${org}:${loc}` -> {at, rooms: Map(spaceId -> {x,y}), seats: [{name, space_id, x, y}]}

// ---------- per-user preferences (plain KV, keyed by Robin account; survive reconnects) ----------
// {office: {building_id, building, floor, seat, x, y}}
const prefsKey = (props) => `prefs:robin-${props.account_id}`;
async function loadPrefs(kv, props) {
    if (!kv) return {};
    try { return (await kv.get(prefsKey(props), "json")) || {}; } catch { return {}; }
}
async function savePrefs(kv, props, prefs) {
    if (!kv) throw new Error("Preferences storage is not configured");
    await kv.put(prefsKey(props), JSON.stringify(prefs));
}

// Grants store every building of the org: [{id, name, tz}]. Older grants stored one.
function locationsOf(props) {
    if (Array.isArray(props.locations) && props.locations.length) return props.locations;
    return [{ id: props.loc_id, name: props.loc_name, tz: props.tz || "UTC" }];
}
function pickLocation(props, q) {
    const locs = locationsOf(props);
    q = String(q || "").trim();
    if (!q) return locs[0];
    const lc = q.toLowerCase();
    const hit = locs.find((l) => String(l.id) === q || l.name.toLowerCase() === lc)
        || (locs.filter((l) => l.name.toLowerCase().includes(lc)).length === 1 && locs.find((l) => l.name.toLowerCase().includes(lc)));
    if (!hit) throw new Error(`No building matches "${q}". Buildings: ${locs.map((l) => l.name).join(", ")}`);
    return hit;
}

class RobinError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function unauthorized() {
    return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer error="invalid_token", error_description="Robin session expired; reconnect"`,
        },
    });
}

export async function handleMcp(req, props, { robin: API, kv }) {
    if (!props?.token || !(Date.parse(props.expire_at) > Date.now())) return unauthorized();
    if (req.method === "GET") return new Response("SSE streams are not supported; POST JSON-RPC", { status: 405, headers: { allow: "POST, DELETE" } });
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

    let msg;
    try { msg = await req.json(); } catch { return rpcError(null, -32700, "Parse error", 400); }
    if (Array.isArray(msg)) return rpcError(null, -32600, "Batching is not supported", 400);
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id ?? null, -32600, "Invalid request", 400);
    if (msg.id === undefined) return new Response(null, { status: 202 }); // notification

    const robin = makeClient(API, props);
    try {
        switch (msg.method) {
            case "initialize": {
                const asked = msg.params?.protocolVersion;
                const prefs = await loadPrefs(kv, props);
                const office = prefs.office
                    ? ` The user's office is ${prefs.office.seat} (${prefs.office.floor}, ${prefs.office.building}); free rooms are ranked by distance from it and book_room without a room picks the nearest free one.`
                    : ` No office is set; offer set_office (a desk code such as "3A1") so rooms can be ranked by distance.`;
                return rpcResult(msg.id, {
                    protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
                    capabilities: { tools: {} },
                    serverInfo: { name: "robin-rooms", version: "1.0.0" },
                    instructions: `Room booking for ${props.org_name} as ${props.email}. Buildings: ` +
                        locationsOf(props).map((l, i) => `${l.name} (${l.tz})${i === 0 ? " [default]" : ""}`).join(", ") +
                        `. Tools take an optional "building"; without it the default is used. Times are local to the building unless an offset is given. ` +
                        `Confirm room, date and time with the user before booking.` + office,
                });
            }
            case "ping": return rpcResult(msg.id, {});
            case "tools/list": return rpcResult(msg.id, { tools: TOOLS });
            case "tools/call": {
                const tool = TOOL_IMPL[msg.params?.name];
                if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
                try {
                    const out = await tool(msg.params?.arguments || {}, robin, props, { kv, prefs: await loadPrefs(kv, props) });
                    return rpcResult(msg.id, { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }], ...(typeof out === "string" ? {} : { structuredContent: out }) });
                } catch (e) {
                    if (e instanceof RobinError && e.status === 401) return unauthorized();
                    return rpcResult(msg.id, { isError: true, content: [{ type: "text", text: e.message || String(e) }] });
                }
            }
            default: return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
        }
    } catch (e) {
        if (e instanceof RobinError && e.status === 401) return unauthorized();
        return rpcError(msg.id, -32603, e.message || "Internal error", 500);
    }
}

const rpcResult = (id, result) => Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message, status = 200) => Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });

// ---------- Robin client ----------
function makeClient(API, props) {
    return async function robin(path, opts = {}) {
        const base = path.startsWith("atlas:") ? ATLAS : API;
        path = path.replace(/^atlas:/, "");
        const res = await fetch(base + path, {
            ...opts,
            headers: {
                "Authorization": "Access-Token " + props.token,
                "Tenant-Id": String(props.org_id),
                ...(opts.body ? { "Content-Type": "application/json" } : {}),
            },
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new RobinError(res.status, json.meta?.message || `Robin returned ${res.status}`);
        return json;
    };
}

// ---------- time helpers (building time zone, Robin's no-millisecond format) ----------
function tzParts(date, tz) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date);
    const g = (t) => +parts.find((p) => p.type === t).value;
    return { y: g("year"), mo: g("month"), d: g("day"), h: g("hour"), mi: g("minute"), s: g("second") };
}
function offsetMinutes(date, tz) {
    const p = tzParts(date, tz);
    return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - date.getTime()) / 60000);
}
const pad = (n) => String(n).padStart(2, "0");
function fmtOffset(min) {
    const sign = min < 0 ? "-" : "+";
    min = Math.abs(min);
    return `${sign}${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}
// Accepts "YYYY-MM-DDTHH:MM[:SS]" (building local time), or any ISO string with an offset/Z.
function parseWhen(s, tz) {
    if (s instanceof Date) return s;
    s = String(s || "").trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (m) {
        const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
        let t = guess - offsetMinutes(new Date(guess), tz) * 60000;
        const off2 = offsetMinutes(new Date(t), tz);
        t = guess - off2 * 60000;
        return new Date(t);
    }
    const d = new Date(s);
    if (isNaN(d)) throw new Error(`Cannot parse time "${s}". Use YYYY-MM-DDTHH:MM (building local time).`);
    return d;
}
function toRobin(date, tz) {
    const p = tzParts(date, tz);
    return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${fmtOffset(offsetMinutes(date, tz))}`;
}
function toLocal(date, tz) {
    const p = tzParts(date, tz);
    return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}
function dayRange(dateStr, tz) {
    const m = /^(\d{4}-\d{2}-\d{2})$/.exec(String(dateStr || "").trim());
    if (!m) throw new Error(`date must be YYYY-MM-DD, got "${dateStr}"`);
    return { after: parseWhen(m[1] + "T00:00", tz), before: parseWhen(m[1] + "T23:59", tz) };
}

// ---------- spaces ----------
async function loadSpaces(robin, props, loc) {
    const key = `${props.org_id}:${loc.id}`;
    const hit = spacesCache.get(key);
    if (hit && Date.now() - hit.at < SPACES_TTL) return hit;
    const [sp, lv] = await Promise.all([
        robin(`/locations/${loc.id}/spaces?per_page=200&include=calendar`),
        robin(`/locations/${loc.id}/levels`).catch(() => ({ data: [] })),
    ]);
    const levels = new Map((lv.data || []).map((l) => [+l.id, l.name]));
    const deskSpaces = (sp.data || [])
        .filter((s) => (s.behaviors || []).includes("seats"))
        .map((s) => ({ id: +s.id, level_id: s.level_id == null ? null : +s.level_id }));
    const spaces = (sp.data || [])
        .filter((s) => (s.behaviors || []).includes("scheduling") && s.calendar)
        .map((s) => ({
            id: +s.id,
            name: s.name,
            capacity: +s.capacity || 0,
            type: s.type,
            level_id: s.level_id == null ? null : +s.level_id,
            floor: s.level_id == null ? null : levels.get(+s.level_id) ?? String(s.level_id),
            notes: (s.description || "").trim() || undefined,
            cal: s.calendar ? { type: s.calendar.remote_type, mailbox: s.calendar.space_resource_email } : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const entry = { at: Date.now(), spaces, levels, deskSpaces };
    spacesCache.set(key, entry);
    return entry;
}

// ---------- geometry (atlas): room and seat centroids in the floorplan's world space ----------
function centroid(geometry) {
    const ring = geometry?.type === "Polygon" ? geometry.coordinates?.[0] : geometry?.type === "Point" ? [geometry.coordinates] : null;
    if (!ring?.length) return null;
    let x = 0, y = 0;
    for (const [px, py] of ring) { x += px; y += py; }
    return { x: x / ring.length, y: y / ring.length };
}
async function atlasLayer(robin, layer, ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 100) {
        const json = await robin(`atlas:/layers/${layer}?ids=${ids.slice(i, i + 100).join(",")}`);
        const feats = Array.isArray(json) ? json : json.data || json.features || [];
        for (const f of feats) {
            const c = centroid(f.geometry);
            if (c && f.properties?.ownerId != null) out.set(+f.properties.ownerId, c);
        }
    }
    return out;
}
async function loadGeometry(robin, props, loc) {
    const key = `${props.org_id}:${loc.id}`;
    const hit = geoCache.get(key);
    if (hit && Date.now() - hit.at < SPACES_TTL) return hit;
    const { spaces, deskSpaces } = await loadSpaces(robin, props, loc);
    const rooms = await atlasLayer(robin, "spaces", spaces.map((s) => s.id));
    const seatLists = await Promise.all(deskSpaces.map(async (d) => {
        const json = await robin(`/spaces/${d.id}/seats?per_page=200`).catch(() => ({ data: [] }));
        return (json.data || []).map((x) => ({ id: +x.id, name: x.name, space_id: d.id, level_id: d.level_id }));
    }));
    const seatRows = seatLists.flat();
    const seatGeo = await atlasLayer(robin, "seats", seatRows.map((x) => x.id)).catch(() => new Map());
    const seats = seatRows.map((x) => ({ ...x, ...(seatGeo.get(x.id) || {}) })).filter((x) => x.x != null);
    // "A floor apart" costs about the width of the floorplan, so a room next door beats one upstairs.
    const xs = [...rooms.values()].map((c) => c.x), ys = [...rooms.values()].map((c) => c.y);
    const span = xs.length ? Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : 360;
    const entry = { at: Date.now(), rooms, seats, floorPenalty: span || 360 };
    geoCache.set(key, entry);
    return entry;
}

// Resolve a desk code ("3A1", "3A1_2") to an office record. A bare group code is the
// centroid of all its seats.
async function resolveOffice(robin, props, loc, code) {
    const { levels } = await loadSpaces(robin, props, loc);
    const { seats } = await loadGeometry(robin, props, loc);
    const norm = (v) => String(v || "").toUpperCase().replace(/[\s-]/g, "");
    const want = norm(code);
    if (!want) throw new Error("office is required, e.g. \"3A1\"");
    let hits = seats.filter((x) => norm(x.name) === want);
    if (!hits.length) hits = seats.filter((x) => norm(x.name).startsWith(want + "_"));
    if (!hits.length) {
        const near = [...new Set(seats.map((x) => x.name.replace(/_\d+$/, "")))].filter((n) => norm(n).startsWith(want.slice(0, 3))).slice(0, 15);
        throw new Error(`No desk matches "${code}" in ${loc.name}.` + (near.length ? ` Similar: ${near.join(", ")}` : ""));
    }
    const c = centroid({ type: "Polygon", coordinates: [hits.map((h) => [h.x, h.y])] });
    const level_id = hits[0].level_id;
    return {
        building_id: loc.id,
        building: loc.name,
        level_id,
        floor: level_id == null ? null : levels.get(level_id) ?? String(level_id),
        seat: hits.length === 1 ? hits[0].name : hits[0].name.replace(/_\d+$/, ""),
        seats: hits.length,
        x: c.x,
        y: c.y,
    };
}

// Distance score from the user's office to a room: same floor = centroid distance, each
// floor apart adds a floor's width. null when unknown (other building, no geometry).
function distanceTo(room, office, geo) {
    if (!office) return null; // officeContext() already checked the building
    const c = geo.rooms.get(room.id);
    if (!c || office.x == null) return null;
    const floors = room.level_id == null || office.level_id == null ? 1 : Math.abs(levelIndexDelta(room.level_id, office.level_id, geo));
    return Math.hypot(c.x - office.x, c.y - office.y) + floors * geo.floorPenalty;
}
function levelIndexDelta(a, b, geo) {
    if (a === b) return 0;
    const n = (id) => { const m = /(\d+)/.exec(geo.levelNames?.get(id) || ""); return m ? +m[1] : null; };
    const na = n(a), nb = n(b);
    return na != null && nb != null ? na - nb : 1;
}
function rankByDistance(rooms, office, geo) {
    if (!office || !geo) return rooms.map((r) => ({ ...r }));
    return rooms
        .map((r) => ({ ...r, _d: distanceTo(r, office, geo) }))
        .sort((a, b) => (a._d ?? Infinity) - (b._d ?? Infinity))
        .map(({ _d, ...r }, i) => ({ ...r, ...(_d == null ? {} : { distance_rank: i + 1, same_floor: r.level_id === office.level_id }) }));
}

function findRoom(spaces, q) {
    q = String(q || "").trim();
    if (!q) throw new Error("room is required (name or id)");
    if (/^\d+$/.test(q)) {
        const s = spaces.find((x) => x.id === +q);
        if (s) return s;
    }
    const lc = q.toLowerCase();
    const exact = spaces.filter((s) => s.name.toLowerCase() === lc);
    if (exact.length === 1) return exact[0];
    const partial = spaces.filter((s) => s.name.toLowerCase().includes(lc));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) throw new Error(`Ambiguous room "${q}": ${partial.map((s) => s.name).join(", ")}`);
    throw new Error(`No room matches "${q}". Use list_rooms to see the names.`);
}

async function eventsFor(robin, space, after, before, tz) {
    const qs = `per_page=100&after=${encodeURIComponent(toRobin(after, tz))}&before=${encodeURIComponent(toRobin(before, tz))}`;
    const json = await robin(`/spaces/${space.id}/events?${qs}`);
    return (json.data || []).map((e) => ({
        id: e.id,
        title: e.title || "(no title)",
        start: new Date(e.started_at || e.start?.date_time),
        end: new Date(e.ended_at || e.end?.date_time),
        creator_id: e.creator_id == null ? null : +e.creator_id,
        space_id: space.id,
    }));
}

const overlaps = (ev, start, end) => ev.start < end && ev.end > start;

function publicRoom(s) {
    const { id, name, capacity, floor, notes, cal, distance_rank, same_floor } = s;
    return { id, name, capacity, floor: floor ?? undefined, notes, bookable: !!cal, distance_rank, same_floor };
}
// Attach the office + geometry context a tool needs to rank rooms, when the user has one.
async function officeContext(robin, props, loc, prefs) {
    const office = prefs?.office;
    if (!office || office.building_id !== loc.id) return { office: null, geo: null };
    try {
        const geo = await loadGeometry(robin, props, loc);
        geo.levelNames = (await loadSpaces(robin, props, loc)).levels;
        return { office, geo };
    } catch { return { office, geo: null }; }
}
function publicEvent(ev, tz, props, spaces) {
    const room = spaces?.find((s) => s.id === ev.space_id);
    return {
        id: ev.id,
        title: ev.title,
        room: room?.name,
        start: toLocal(ev.start, tz),
        end: toLocal(ev.end, tz),
        mine: ev.creator_id === props.account_id,
    };
}

function window_(args, tz) {
    const start = parseWhen(args.start, tz);
    const end = args.end ? parseWhen(args.end, tz) : new Date(start.getTime() + (+args.duration_minutes || 30) * 60000);
    if (!(end > start)) throw new Error("end must be after start");
    return { start, end };
}

async function freeRooms(robin, props, loc, start, end, min, prefs) {
    const tz = loc.tz;
    const { spaces } = await loadSpaces(robin, props, loc);
    const candidates = spaces.filter((s) => s.cal && s.capacity >= min);
    const [busy, { office, geo }] = await Promise.all([
        Promise.all(candidates.map(async (s) => (await eventsFor(robin, s, start, end, tz)).some((e) => overlaps(e, start, end)))),
        officeContext(robin, props, loc, prefs),
    ]);
    return { office, rooms: rankByDistance(candidates.filter((_, i) => !busy[i]), office, geo) };
}

// ---------- tools ----------
const TIME_DESC = "Building-local time as YYYY-MM-DDTHH:MM, or ISO 8601 with an offset.";

export const TOOLS = [
    {
        name: "list_rooms",
        description: "List the bookable rooms in the user's building with capacity, floor and any notes (e.g. broken equipment).",
        inputSchema: {
            type: "object",
            properties: {
                min_capacity: { type: "integer", description: "Only rooms seating at least this many." },
                building: { type: "string", description: "Building name, when the org has several. Default: the first one." },
            },
        },
    },
    {
        name: "set_office",
        description: "Remember where the user sits (a desk code such as \"3A1\" or \"3A1_2\") so free rooms are ranked by distance from it. An empty office clears it.",
        inputSchema: {
            type: "object",
            properties: {
                office: { type: "string", description: "Desk/office code as labelled on the floorplan. Empty string to clear." },
                building: { type: "string", description: "Building the office is in. Default: the first one." },
            },
            required: ["office"],
        },
    },
    {
        name: "find_free_rooms",
        description: "Rooms that are free for the whole of a time window. When the user's office is set, results are ordered nearest-first (distance_rank 1 = closest; same_floor tells whether it is on the office's floor).",
        inputSchema: {
            type: "object",
            properties: {
                start: { type: "string", description: TIME_DESC },
                end: { type: "string", description: TIME_DESC + " Defaults to start + duration_minutes." },
                duration_minutes: { type: "integer", description: "Used when end is omitted. Default 30." },
                min_capacity: { type: "integer" },
                building: { type: "string", description: "Building name, when the org has several. Default: the first one." },
            },
            required: ["start"],
        },
    },
    {
        name: "room_schedule",
        description: "Everything booked in one room on a date (titles, times, whether each booking is the user's).",
        inputSchema: {
            type: "object",
            properties: {
                room: { type: "string", description: "Room name (or id) from list_rooms." },
                date: { type: "string", description: "YYYY-MM-DD" },
                building: { type: "string", description: "Building name, when the org has several. Default: the first one." },
            },
            required: ["room", "date"],
        },
    },
    {
        name: "my_bookings",
        description: "The user's own room bookings on a date, across all rooms in the building.",
        inputSchema: {
            type: "object",
            properties: {
                date: { type: "string", description: "YYYY-MM-DD" },
                building: { type: "string", description: "Building name, when the org has several. Default: the first one." },
            },
            required: ["date"],
        },
    },
    {
        name: "book_room",
        description: "Book a room. Refuses if the room is already busy in that window. Omit room to book the free room nearest the user's office (requires set_office). The user gets the calendar invite; extra invitees must be org members.",
        inputSchema: {
            type: "object",
            properties: {
                room: { type: "string", description: "Room name (or id) from list_rooms. Omit for the nearest free room to the user's office." },
                start: { type: "string", description: TIME_DESC },
                end: { type: "string", description: TIME_DESC + " Defaults to start + duration_minutes." },
                duration_minutes: { type: "integer", description: "Used when end is omitted. Default 30." },
                min_capacity: { type: "integer", description: "When room is omitted: smallest acceptable room." },
                title: { type: "string", description: "Event title. Default: the user's name's meeting." },
                description: { type: "string" },
                invitees: { type: "array", items: { type: "string" }, description: "Extra attendee emails (org members only)." },
                private: { type: "boolean", description: "Hide the title from others." },
                recurrence: { type: "string", description: "Optional RRULE, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4" },
                building: { type: "string", description: "Building name, when the org has several. Default: the first one." },
            },
            required: ["start"],
        },
    },
    {
        name: "edit_booking",
        description: "Change the title, description or time of one of the user's bookings. To move it to another room, cancel and book again.",
        inputSchema: {
            type: "object",
            properties: {
                event_id: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
                start: { type: "string", description: TIME_DESC + " Give start and end together." },
                end: { type: "string", description: TIME_DESC },
                building: { type: "string", description: "Building the booking is in (for its time zone). Default: the first one." },
            },
            required: ["event_id"],
        },
    },
    {
        name: "cancel_booking",
        description: "Cancel a booking by event id. For a recurring series, an instance id ({master}_{timestamp}) cancels one occurrence; the master id cancels the whole series.",
        inputSchema: {
            type: "object",
            properties: { event_id: { type: "string" } },
            required: ["event_id"],
        },
    },
];

const TOOL_IMPL = {
    async set_office(args, robin, props, { kv, prefs }) {
        const code = String(args.office || "").trim();
        if (!code) {
            delete prefs.office;
            await savePrefs(kv, props, prefs);
            return { office: null, message: "Office cleared." };
        }
        const loc = pickLocation(props, args.building);
        const office = await resolveOffice(robin, props, loc, code);
        prefs.office = office;
        await savePrefs(kv, props, prefs);
        return { office: { seat: office.seat, seats_in_group: office.seats, floor: office.floor, building: office.building } };
    },

    async list_rooms(args, robin, props, { prefs }) {
        const loc = pickLocation(props, args.building);
        const { spaces } = await loadSpaces(robin, props, loc);
        const min = +args.min_capacity || 0;
        const { office, geo } = await officeContext(robin, props, loc, prefs);
        return {
            building: loc.name,
            time_zone: loc.tz,
            other_buildings: locationsOf(props).filter((l) => l.id !== loc.id).map((l) => l.name),
            office: office ? `${office.seat} (${office.floor})` : undefined,
            rooms: rankByDistance(spaces.filter((s) => s.capacity >= min), office, geo).map(publicRoom),
        };
    },

    async find_free_rooms(args, robin, props, { prefs }) {
        const loc = pickLocation(props, args.building);
        const tz = loc.tz;
        const { start, end } = window_(args, tz);
        const free = await freeRooms(robin, props, loc, start, end, +args.min_capacity || 0, prefs);
        return {
            building: loc.name,
            office: free.office ? `${free.office.seat} (${free.office.floor})` : undefined,
            window: { start: toLocal(start, tz), end: toLocal(end, tz), time_zone: tz },
            free_rooms: free.rooms.map(publicRoom),
        };
    },

    async room_schedule(args, robin, props) {
        const loc = pickLocation(props, args.building);
        const tz = loc.tz;
        const { spaces } = await loadSpaces(robin, props, loc);
        const room = findRoom(spaces, args.room);
        const { after, before } = dayRange(args.date, tz);
        const evs = await eventsFor(robin, room, after, before, tz);
        evs.sort((a, b) => a.start - b.start);
        return { room: publicRoom(room), date: args.date, bookings: evs.map((e) => publicEvent(e, tz, props, spaces)) };
    },

    async my_bookings(args, robin, props) {
        const loc = pickLocation(props, args.building);
        const tz = loc.tz;
        const { spaces } = await loadSpaces(robin, props, loc);
        const { after, before } = dayRange(args.date, tz);
        const all = await Promise.all(spaces.filter((s) => s.cal).map((s) => eventsFor(robin, s, after, before, tz)));
        const mine = all.flat().filter((e) => e.creator_id === props.account_id).sort((a, b) => a.start - b.start);
        return { building: loc.name, date: args.date, bookings: mine.map((e) => publicEvent(e, tz, props, spaces)) };
    },

    async book_room(args, robin, props, { prefs }) {
        const loc = pickLocation(props, args.building);
        const tz = loc.tz;
        const { start, end } = window_(args, tz);
        const { spaces } = await loadSpaces(robin, props, loc);
        let room;
        if (String(args.room || "").trim()) {
            room = findRoom(spaces, args.room);
        } else {
            if (!prefs.office) throw new Error("No room given and no office set. Name a room, or call set_office first so the nearest free room can be picked.");
            // Nearest free *meeting* room: no break rooms, and at least two seats unless told otherwise.
            const free = await freeRooms(robin, props, loc, start, end, +args.min_capacity || 2, prefs);
            const usable = free.rooms.filter((r) => r.type !== "break_room");
            room = usable.find((r) => r.distance_rank != null) || usable[0];
            if (!room) throw new Error("No room is free in that window.");
        }
        if (!room.cal) throw new Error(`${room.name} has no calendar and cannot be booked through Robin.`);
        const clash = (await eventsFor(robin, room, start, end, tz)).filter((e) => overlaps(e, start, end));
        if (clash.length) {
            throw new Error(`${room.name} is busy then: ` + clash.map((e) => `${e.title} ${toLocal(e.start, tz)}–${toLocal(e.end, tz)}`).join("; "));
        }
        const invitees = [props.email, ...(args.invitees || [])]
            .map((e) => String(e).trim().toLowerCase()).filter((e, i, a) => e && a.indexOf(e) === i)
            .map((email) => ({ email }));
        const body = {
            title: args.title || `${props.email.split("@")[0]}'s meeting`,
            space_id: room.id,
            calendar_type: room.cal.type,
            calendar_mailbox_address: room.cal.mailbox,
            start: { date_time: toRobin(start, tz), time_zone: tz },
            end: { date_time: toRobin(end, tz), time_zone: tz },
            invitees,
            ...(args.description ? { description: args.description } : {}),
            ...(args.private ? { visibility: "private" } : {}),
            ...(args.recurrence ? { recurrence: [String(args.recurrence)] } : {}),
        };
        const res = await robin("/events", { method: "POST", body: JSON.stringify(body) });
        const ev = res.data || {};
        return {
            booked: true,
            event_id: ev.id,
            building: loc.name,
            room: room.name,
            floor: room.floor ?? undefined,
            distance_rank: room.distance_rank,
            title: body.title,
            start: toLocal(start, tz),
            end: toLocal(end, tz),
            time_zone: tz,
            recurrence: args.recurrence || undefined,
        };
    },

    async edit_booking(args, robin, props) {
        const tz = pickLocation(props, args.building).tz;
        const id = String(args.event_id || "").trim();
        if (!id) throw new Error("event_id is required");
        const patch = {};
        if (args.title != null) patch.title = String(args.title);
        if (args.description != null) patch.description = String(args.description);
        if (args.start || args.end) {
            if (!(args.start && args.end)) throw new Error("Give start and end together");
            const start = parseWhen(args.start, tz), end = parseWhen(args.end, tz);
            if (!(end > start)) throw new Error("end must be after start");
            patch.start = { date_time: toRobin(start, tz), time_zone: tz };
            patch.end = { date_time: toRobin(end, tz), time_zone: tz };
        }
        if (!Object.keys(patch).length) throw new Error("Nothing to change");
        const res = await robin(`/events/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
        const ev = res.data || {};
        return { updated: true, event_id: ev.id || id, title: ev.title, start: ev.started_at ? toLocal(new Date(ev.started_at), tz) : undefined, end: ev.ended_at ? toLocal(new Date(ev.ended_at), tz) : undefined };
    },

    async cancel_booking(args, robin) {
        const id = String(args.event_id || "").trim();
        if (!id) throw new Error("event_id is required");
        await robin(`/events/${encodeURIComponent(id)}`, { method: "DELETE" });
        return { cancelled: true, event_id: id };
    },
};
