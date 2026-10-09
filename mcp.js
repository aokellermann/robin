// Stateless MCP server (Streamable HTTP, JSON responses) over Robin's REST API.
// Every call runs with the connected user's own Robin token (props from the OAuth grant),
// so bookings are theirs and nobody can see or touch anyone else's.
// Robin API knowledge mirrors public/app.js and CLAUDE.md — change both together.

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SPACES_TTL = 10 * 60 * 1000;
const spacesCache = new Map(); // `${org}:${loc}` -> {at, spaces, levels}

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

export async function handleMcp(req, props, { robin: API }) {
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
                return rpcResult(msg.id, {
                    protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
                    capabilities: { tools: {} },
                    serverInfo: { name: "robin-rooms", version: "1.0.0" },
                    instructions: `Room booking for ${props.org_name} as ${props.email}. Buildings: ` +
                        locationsOf(props).map((l, i) => `${l.name} (${l.tz})${i === 0 ? " [default]" : ""}`).join(", ") +
                        `. Tools take an optional "building"; without it the default is used. Times are local to the building unless an offset is given. ` +
                        `Confirm room, date and time with the user before booking.`,
                });
            }
            case "ping": return rpcResult(msg.id, {});
            case "tools/list": return rpcResult(msg.id, { tools: TOOLS });
            case "tools/call": {
                const tool = TOOL_IMPL[msg.params?.name];
                if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
                try {
                    const out = await tool(msg.params?.arguments || {}, robin, props);
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
        const res = await fetch(API + path, {
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
    const spaces = (sp.data || [])
        .filter((s) => (s.behaviors || []).includes("scheduling") && s.calendar)
        .map((s) => ({
            id: +s.id,
            name: s.name,
            capacity: +s.capacity || 0,
            type: s.type,
            floor: s.level_id == null ? null : levels.get(+s.level_id) ?? String(s.level_id),
            notes: (s.description || "").trim() || undefined,
            cal: s.calendar ? { type: s.calendar.remote_type, mailbox: s.calendar.space_resource_email } : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const entry = { at: Date.now(), spaces, levels };
    spacesCache.set(key, entry);
    return entry;
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
    return { id: s.id, name: s.name, capacity: s.capacity, floor: s.floor ?? undefined, notes: s.notes, bookable: !!s.cal };
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
        name: "find_free_rooms",
        description: "Rooms that are free for the whole of a time window.",
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
        description: "Book a room. Refuses if the room is already busy in that window. The user gets the calendar invite; extra invitees must be org members.",
        inputSchema: {
            type: "object",
            properties: {
                room: { type: "string", description: "Room name (or id) from list_rooms." },
                start: { type: "string", description: TIME_DESC },
                end: { type: "string", description: TIME_DESC + " Defaults to start + duration_minutes." },
                duration_minutes: { type: "integer", description: "Used when end is omitted. Default 30." },
                title: { type: "string", description: "Event title. Default: the user's name's meeting." },
                description: { type: "string" },
                invitees: { type: "array", items: { type: "string" }, description: "Extra attendee emails (org members only)." },
                private: { type: "boolean", description: "Hide the title from others." },
                recurrence: { type: "string", description: "Optional RRULE, e.g. RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4" },
                building: { type: "string", description: "Building name, when the org has several. Default: the first one." },
            },
            required: ["room", "start"],
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
    async list_rooms(args, robin, props) {
        const loc = pickLocation(props, args.building);
        const { spaces } = await loadSpaces(robin, props, loc);
        const min = +args.min_capacity || 0;
        return {
            building: loc.name,
            time_zone: loc.tz,
            other_buildings: locationsOf(props).filter((l) => l.id !== loc.id).map((l) => l.name),
            rooms: spaces.filter((s) => s.capacity >= min).map(publicRoom),
        };
    },

    async find_free_rooms(args, robin, props) {
        const loc = pickLocation(props, args.building);
        const tz = loc.tz;
        const { start, end } = window_(args, tz);
        const { spaces } = await loadSpaces(robin, props, loc);
        const min = +args.min_capacity || 0;
        const candidates = spaces.filter((s) => s.cal && s.capacity >= min);
        const busy = await Promise.all(candidates.map(async (s) => {
            const evs = await eventsFor(robin, s, start, end, tz);
            return evs.some((e) => overlaps(e, start, end));
        }));
        return {
            building: loc.name,
            window: { start: toLocal(start, tz), end: toLocal(end, tz), time_zone: tz },
            free_rooms: candidates.filter((_, i) => !busy[i]).map(publicRoom),
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

    async book_room(args, robin, props) {
        const loc = pickLocation(props, args.building);
        const tz = loc.tz;
        const { start, end } = window_(args, tz);
        const { spaces } = await loadSpaces(robin, props, loc);
        const room = findRoom(spaces, args.room);
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
