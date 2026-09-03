"use strict";
const API = "https://api.robinpowered.com/v1.0";
const DAY_START = 8;   // 8:00
const DAY_END = 19;    // 19:00
const STEP_MIN = 15;
const SLOTS = (DAY_END - DAY_START) * 60 / STEP_MIN;

const $ = (id) => document.getElementById(id);
let auth = null;        // {token, email, account_id, expire_at}
let site = loadSite();  // {org_id, org_name, loc_id, loc_name, tz}
let spaces = [];        // bookable spaces
let day = startOfToday();
let events = new Map(); // space id -> [{startMin, endMin, title, id, mine}]
let fetchSeq = 0;

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }

function loadSite() {
    try {
        const s = JSON.parse(localStorage.getItem("robin.site"));
        if (s?.org_id && s?.loc_id) return s;
    } catch {}
    return null;
}

function loadAuth() {
    try {
        const a = JSON.parse(localStorage.getItem("robin.auth"));
        if (a && new Date(a.expire_at) > new Date()) return a;
    } catch {}
    return null;
}

async function robin(path, opts = {}) {
    const res = await fetch(API + path, {
        ...opts,
        headers: {
            "Authorization": "Access-Token " + auth.token,
            ...(site ? { "Tenant-Id": String(site.org_id) } : {}),
            ...(opts.body ? { "Content-Type": "application/json" } : {}),
            ...(opts.headers || {}),
        },
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(); throw new Error("Session expired — sign in again"); }
    if (!res.ok) throw new Error(json.meta?.message || res.status + " error");
    return json;
}

// ---------- login ----------
$("l-go").onclick = doLogin;
$("l-pass").onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
async function doLogin() {
    const email = $("l-email").value.trim(), pass = $("l-pass").value;
    $("l-err").textContent = "";
    if (!email || !pass) return;
    $("l-go").disabled = true;
    try {
        const res = await fetch(API + "/auth/users", {
            method: "POST",
            headers: {
                "Authorization": "Basic " + btoa(email + ":" + pass),
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ remember_me: true }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.meta?.message || "Login failed");
        auth = {
            token: json.data.access_token,
            account_id: json.data.account_id,
            expire_at: json.data.expire_at,
            email,
        };
        localStorage.setItem("robin.auth", JSON.stringify(auth));
        start();
    } catch (e) {
        $("l-err").textContent = e.message;
    } finally {
        $("l-go").disabled = false;
    }
}

function logout() {
    localStorage.removeItem("robin.auth");
    auth = null;
    $("site").hidden = true;
    $("app").style.display = "none";
    $("login").style.display = "flex";
}

// ---------- site (org + building) selection ----------
async function pickSite() {
    const orgs = (await robin("/me/organizations")).data.filter((o) => !o.disabled_at);
    if (!orgs.length) throw new Error("Your account belongs to no Robin organization");
    const org = orgs.length === 1 ? orgs[0] : await choose("Choose an organization", orgs);
    site = { org_id: +org.id, org_name: org.name };  // partial: lets robin() send Tenant-Id
    const locs = (await robin(`/organizations/${org.id}/locations?per_page=100`)).data;
    if (!locs.length) { site = null; throw new Error(`${org.name} has no locations`); }
    const loc = locs.length === 1 ? locs[0] : await choose("Choose a building", locs);
    site = {
        org_id: +org.id,
        org_name: org.name,
        loc_id: +loc.id,
        loc_name: loc.name,
        tz: loc.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    localStorage.setItem("robin.site", JSON.stringify(site));
}

function choose(title, options) {
    return new Promise((resolve) => {
        $("app").style.display = "none";
        const card = $("site");
        card.querySelector("h1").textContent = title;
        const list = $("site-list");
        list.innerHTML = "";
        for (const o of options) {
            const b = document.createElement("button");
            b.textContent = o.name;
            b.onclick = () => { card.hidden = true; resolve(o); };
            list.appendChild(b);
        }
        card.hidden = false;
    });
}

async function switchSite() {
    localStorage.removeItem("robin.site");
    site = null;
    spaces = [];
    events.clear();
    mapData = null;
    curLevel = null;
    hidePop();
    start();
}

// ---------- data ----------
async function loadSpaces() {
    const cached = localStorage.getItem(`robin.spaces.v2:${site.loc_id}`);
    if (cached) {
        try { spaces = JSON.parse(cached); } catch {}
    }
    if (spaces.length) refreshSpacesInBackground();
    else spaces = await fetchSpaces();
}
async function fetchSpaces() {
    const json = await robin(`/locations/${site.loc_id}/spaces?per_page=200&include=calendar`);
    const list = json.data
        .filter((s) => (s.behaviors || []).includes("scheduling") && (s.type !== "other" || s.calendar))
        .map((s) => ({
            id: +s.id,
            name: s.name,
            capacity: +s.capacity || 0,
            type: s.type,
            level_id: s.level_id == null ? null : +s.level_id,
            note: (s.description || "").trim() || undefined,
            img: s.image || undefined,
            cal: s.calendar ? { type: s.calendar.remote_type, mailbox: s.calendar.space_resource_email } : null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    localStorage.setItem(`robin.spaces.v2:${site.loc_id}`, JSON.stringify(list));
    return list;
}
async function refreshSpacesInBackground() {
    try {
        const fresh = await fetchSpaces();
        // keep already-known amenities so the background refresh doesn't wipe them
        for (const s of fresh) {
            const old = spaces.find((x) => x.id === s.id);
            if (old?.amenities) s.amenities = old.amenities;
        }
        if (JSON.stringify(fresh) !== JSON.stringify(spaces)) { spaces = fresh; renderGrid(); loadDay(); }
    } catch {}
}

// Amenities only come back from the per-space endpoint (include=amenities on the
// list returns []). Fetched once, cached with the spaces list.
async function loadAmenities() {
    const missing = spaces.filter((s) => !s.amenities);
    if (!missing.length) return;
    await Promise.all(missing.map(async (s) => {
        try {
            const json = await robin(`/spaces/${s.id}/amenities`);
            s.amenities = (json.data || []).map((a) => a.name).filter(Boolean);
        } catch {}
    }));
    localStorage.setItem(`robin.spaces.v2:${site.loc_id}`, JSON.stringify(spaces));
    if (view === "grid") for (const s of spaces) renderRow(s.id);
    buildAmenMenu();
}

function dayRange() {
    const after = new Date(day); after.setHours(0, 0, 0, 0);
    const before = new Date(day); before.setHours(23, 59, 0, 0);
    return { after: isoLocal(after), before: isoLocal(before) };
}

async function loadDay(onlyMissing = false) {
    const seq = ++fetchSeq;
    const { after, before } = dayRange();
    let visible = visibleSpaces();
    if (onlyMissing) visible = visible.filter((s) => !events.has(s.id));
    if (!visible.length) return;
    $("status").textContent = "Loading…";
    let done = 0;
    await Promise.all(visible.map(async (s) => {
        try {
            const json = await robin(`/spaces/${s.id}/events?per_page=100&after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}`);
            if (seq !== fetchSeq) return;
            events.set(s.id, (json.data || []).map((e) => ({
            desc: plainText(e.description),
                id: e.id,
                title: e.title || "Reserved",
                startMin: minutesOfDay(e.start),
                endMin: minutesOfDay(e.end),
                mine: e.creator_id === auth.account_id || (e.creator_email && e.creator_email.toLowerCase() === auth.email.toLowerCase()),
            })));
            updateSpaceView(s.id);
        } catch (e) {
            if (seq === fetchSeq) console.warn("events fetch failed for", s.name, e);
        } finally {
            done++;
            if (seq === fetchSeq) $("status").textContent = done < visible.length ? `Loading ${done}/${visible.length}` : "";
        }
    }));
}

function minutesOfDay(t) {
    const d = new Date(t.date_time);
    const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
    return Math.round((d - dayStart) / 60000);
}

// ---------- rendering ----------
let amenChecked = new Set();
function visibleSpaces() {
    const minCap = +$("mincap").value;
    return spaces.filter((s) =>
        (!minCap || (s.capacity || 0) >= minCap) &&
        [...amenChecked].every((a) => (s.amenities || []).includes(a)));
}

function buildAmenMenu() {
    const all = [...new Set(spaces.flatMap((s) => s.amenities || []))].sort();
    if (!all.length) return;
    $("amenmenu").innerHTML = all.map((a) =>
        `<label><input type="checkbox" value="${esc(a)}"${amenChecked.has(a) ? " checked" : ""}>${esc(a)}</label>`).join("");
    for (const cb of $("amenmenu").querySelectorAll("input")) {
        cb.onchange = () => {
            cb.checked ? amenChecked.add(cb.value) : amenChecked.delete(cb.value);
            document.querySelector("#amenfilter summary").classList.toggle("active", amenChecked.size > 0);
            renderView();
            loadDay(true);
        };
    }
}

function slotLabel(i) {
    const m = DAY_START * 60 + i * STEP_MIN;
    const h = Math.floor(m / 60), min = m % 60;
    if (min !== 0) return "";
    const h12 = ((h + 11) % 12) + 1;
    return h12 + (h < 12 ? "a" : "p");
}

function renderGrid() {
    const grid = $("grid");
    const visible = visibleSpaces();
    let html = "<colgroup><col>";
    const nowIdx = nowSlotIndex();
    for (let i = 0; i < SLOTS; i++) html += `<col${i === nowIdx ? ' class="nowcol"' : ""}>`;
    html += "</colgroup><thead><tr><th class='room'></th>";
    for (let i = 0; i < SLOTS; i++) {
        const lbl = slotLabel(i);
        html += `<th${lbl ? ' class="hourstart"' : ""}>${lbl}</th>`;
    }
    html += "</tr></thead><tbody>";
    for (const s of visible) {
        html += `<tr data-space="${s.id}">` + rowCells(s) + "</tr>";
    }
    html += "</tbody>";
    grid.innerHTML = html;
    $("datelabel").textContent = day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function nowSlotIndex() {
    const now = new Date();
    if (now.toDateString() !== day.toDateString()) return -1;
    const m = now.getHours() * 60 + now.getMinutes() - DAY_START * 60;
    if (m < 0 || m >= SLOTS * STEP_MIN) return -1;
    return Math.floor(m / STEP_MIN);
}

function rowCells(s) {
    const evs = events.get(s.id) || [];
    const now = new Date();
    const isToday = now.toDateString() === day.toDateString();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const tip = roomTip(s);
    const amen = amenEmojis(s);
    let html = `<td class="room"${tip ? ` title="${esc(tip)}"` : ""}>${esc(s.name)}<span class="cap">${s.capacity ? s.capacity + "p" : ""}</span>${s.note ? '<span class="note">&#9432;</span>' : ""}${amen ? `<span class="amen">${amen}</span>` : ""}</td>`;
    let i = 0;
    while (i < SLOTS) {
        const m0 = DAY_START * 60 + i * STEP_MIN;
        const ev = evs.find((e) => e.startMin < m0 + STEP_MIN && e.endMin > m0);
        if (ev) {
            // span the busy block across its slots
            const endSlot = Math.min(SLOTS, Math.ceil((ev.endMin - DAY_START * 60) / STEP_MIN));
            const span = Math.max(1, endSlot - i);
            const past = isToday && DAY_START * 60 + endSlot * STEP_MIN <= nowMin;
            html += `<td class="slot busy${ev.mine ? ' mine" draggable="true' : ""}${past ? " past" : ""}" colspan="${span}" data-event="${esc(ev.id)}" title="${esc(ev.title)}">${esc(ev.title)}${ev.mine ? '<span class="rsz"></span>' : ""}</td>`;
            i = endSlot;
        } else {
            const past = isToday && m0 + STEP_MIN <= nowMin;
            const hourstart = m0 % 60 === 0;
            html += `<td class="slot${past ? " past" : ""}${hourstart ? " hourstart" : ""}" data-slot="${i}"></td>`;
            i++;
        }
    }
    return html;
}

function renderRow(spaceId) {
    const tr = document.querySelector(`tr[data-space="${spaceId}"]`);
    const s = spaces.find((x) => x.id === spaceId);
    if (tr && s) tr.innerHTML = rowCells(s);
}

const AMEN_EMOJI = {
    "whiteboard": "\u{1F4DD}",
    "television": "\u{1F4FA}",
    "video conferencing": "\u{1F3A5}",
    "speakers": "\u{1F50A}",
    "google chromecast": "\u{1F4E1}",
    "couch": "\u{1F6CB}\uFE0F",
    "bed": "\u{1F6CF}\uFE0F",
    "pillows": "\u{1F6CC}",
    "blankets": "\u{1F9F6}",
    "projector": "\u{1F4FD}\uFE0F",
    "table": "\u{1FA91}",
    "weights": "\u{1F3CB}\uFE0F",
    "computer": "\u{1F4BB}",
    "rowing machine": "\u{1F6A3}",
    "foam roller": "\u{1F300}",
    "yoga mat": "\u{1F9D8}",
};

function amenEmojis(s) {
    return (s.amenities || [])
        .map((a) => {
            const e = AMEN_EMOJI[a.toLowerCase()];
            return e ? `<span title="${esc(a)}">${e}</span>` : "";
        })
        .join("");
}

function roomTip(s) {
    return [s.note, s.amenities?.length ? s.amenities.join(", ") : null].filter(Boolean).join("\n");
}

// Google-sourced event descriptions can be HTML; render them as plain text.
// DOMParser never executes scripts or loads resources.
function plainText(html) {
    if (!html) return "";
    if (!/[<&]/.test(html)) return html;
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body.textContent || "").trim();
}

function esc(x) {
    return String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- interactions ----------
$("grid").addEventListener("click", (e) => {
    if (suppressClick || e.target.closest(".rsz")) return;
    const td = e.target.closest("td");
    if (!td) return;
    const tr = td.closest("tr[data-space]");
    if (!tr) return;
    const spaceId = +tr.dataset.space;
    if (td.dataset.slot !== undefined) openBookPop(td, spaceId, +td.dataset.slot);
    else if (td.dataset.event && td.classList.contains("mine")) openEventPop(td, spaceId, td.dataset.event);
});

// drag the right edge of your own booking to change its duration
let rsz = null;
let suppressClick = false;
$("grid").addEventListener("pointerdown", (e) => {
    const h = e.target.closest(".rsz");
    if (!h) return;
    const td = h.closest("td.busy.mine");
    const tr = td.closest("tr[data-space]");
    const spaceId = +tr.dataset.space;
    const ev = (events.get(spaceId) || []).find((x) => x.id === td.dataset.event);
    if (!ev) return;
    e.preventDefault();
    td.removeAttribute("draggable");
    let maxEnd = DAY_END * 60;
    for (const x of events.get(spaceId) || []) {
        if (x.id !== ev.id && x.startMin >= ev.endMin) maxEnd = Math.min(maxEnd, x.startMin);
    }
    // snap to the actual rendered column boundaries (header cell edges) instead
    // of arithmetic scaling — border-collapse makes computed widths drift
    const ths = [...document.querySelectorAll("#grid thead th:not(.room)")];
    const bounds = ths.map((t) => t.getBoundingClientRect().left);
    bounds.push(ths[ths.length - 1].getBoundingClientRect().right);
    rsz = { td, tr, spaceId, ev, maxEnd, bounds, tdRect: td.getBoundingClientRect(), newEnd: ev.endMin, moved: false };
    document.body.style.cursor = "ew-resize";
});
document.addEventListener("pointermove", (e) => {
    if (!rsz) return;
    // nearest column boundary to the cursor becomes the new end time
    let best = 0, bd = Infinity;
    rsz.bounds.forEach((x, i) => {
        const d = Math.abs(e.clientX - x);
        if (d < bd) { bd = d; best = i; }
    });
    const ne = DAY_START * 60 + best * STEP_MIN;
    rsz.newEnd = Math.max(rsz.ev.startMin + STEP_MIN, Math.min(ne, rsz.maxEnd));
    if (rsz.newEnd !== rsz.ev.endMin) rsz.moved = true;
    for (const c of rsz.tr.querySelectorAll("td[data-slot]")) {
        const m0 = DAY_START * 60 + +c.dataset.slot * STEP_MIN;
        c.classList.toggle("droptgt", m0 >= rsz.ev.endMin && m0 < rsz.newEnd);
    }
    // when shrinking, paint the trailing part of the cell as free space live,
    // its left edge pinned to the real column boundary
    let cover = rsz.td.querySelector(".shrinkcover");
    const visEnd = Math.min(rsz.ev.endMin, DAY_END * 60);
    if (rsz.newEnd < visEnd) {
        if (!cover) {
            cover = document.createElement("div");
            cover.className = "shrinkcover";
            rsz.td.appendChild(cover);
        }
        const bx = rsz.bounds[(rsz.newEnd - DAY_START * 60) / STEP_MIN];
        cover.style.left = bx - rsz.tdRect.left - rsz.td.clientLeft + "px";
    } else if (cover) {
        cover.remove();
    }
    const t = $("toast");
    clearTimeout(toastTimer);
    t.textContent = `${fmtTime(rsz.ev.startMin)} \u2013 ${fmtTime(rsz.newEnd)}`;
    t.style.display = "block";
});
document.addEventListener("pointerup", async () => {
    if (!rsz) return;
    const { td, spaceId, ev, newEnd, moved } = rsz;
    rsz = null;
    document.body.style.cursor = "";
    for (const t of document.querySelectorAll(".droptgt")) t.classList.remove("droptgt");
    if (newEnd === ev.endMin || newEnd >= Math.min(ev.endMin, DAY_END * 60)) td.querySelector(".shrinkcover")?.remove();
    $("toast").style.display = "none";
    td.setAttribute("draggable", "true");
    if (moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
    if (newEnd === ev.endMin) return;
    const start = new Date(day); start.setHours(0, ev.startMin, 0, 0);
    const end = new Date(day); end.setHours(0, newEnd, 0, 0);
    td.classList.add("pending");
    try {
        await robin(`/events/${encodeURIComponent(ev.id)}`, {
            method: "PATCH",
            body: JSON.stringify({
                start: { date_time: isoLocal(start), time_zone: site.tz },
                end: { date_time: isoLocal(end), time_zone: site.tz },
            }),
        });
        toast(`${newEnd > ev.endMin ? "Extended" : "Shortened"} to ${fmtTime(newEnd)}`);
        reloadSpace(spaceId);
    } catch (err) {
        toast("Resize failed: " + err.message);
        td.querySelector(".shrinkcover")?.remove();
    } finally {
        td.classList.remove("pending");
    }
});

// drag one of your own bookings to a free slot in the same row to reschedule it
let dragEv = null;
$("grid").addEventListener("dragstart", (e) => {
    const td = e.target.closest("td.busy.mine");
    if (!td) { e.preventDefault(); return; }
    dragEv = { spaceId: +td.closest("tr[data-space]").dataset.space, eventId: td.dataset.event, td };
    e.dataTransfer.effectAllowed = "move";
});
$("grid").addEventListener("dragover", (e) => {
    const td = e.target.closest("td.slot");
    if (!td || td.classList.contains("busy") || !dragEv) return;
    const tgtSpace = +td.closest("tr[data-space]").dataset.space;
    if (tgtSpace !== dragEv.spaceId && !spaces.find((x) => x.id === tgtSpace)?.cal) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    td.classList.add("droptgt");
});
$("grid").addEventListener("dragleave", (e) => {
    const td = e.target.closest("td.slot");
    if (td) td.classList.remove("droptgt");
});
$("grid").addEventListener("dragend", () => {
    dragEv = null;
    for (const t of document.querySelectorAll(".droptgt")) t.classList.remove("droptgt");
});
$("grid").addEventListener("drop", async (e) => {
    const td = e.target.closest("td.slot");
    if (!td || td.classList.contains("busy") || !dragEv) return;
    e.preventDefault();
    td.classList.remove("droptgt");
    const { spaceId, eventId, td: srcTd } = dragEv;
    dragEv = null;
    const ev = (events.get(spaceId) || []).find((x) => x.id === eventId);
    if (!ev) return;
    const tgtSpace = +td.closest("tr[data-space]").dataset.space;
    const dur = ev.endMin - ev.startMin;
    const newStart = DAY_START * 60 + +td.dataset.slot * STEP_MIN;
    if (tgtSpace === spaceId && newStart === ev.startMin) return;
    const clash = (events.get(tgtSpace) || []).some((x) => x.id !== eventId && x.startMin < newStart + dur && x.endMin > newStart);
    if (clash) { toast("That time overlaps another booking"); return; }
    const start = new Date(day); start.setHours(0, newStart, 0, 0);
    const end = new Date(start.getTime() + dur * 60000);
    srcTd.classList.add("pending");
    td.classList.add("pending");
    try {
        if (tgtSpace === spaceId) {
            await robin(`/events/${encodeURIComponent(eventId)}`, {
                method: "PATCH",
                body: JSON.stringify({
                    start: { date_time: isoLocal(start), time_zone: site.tz },
                    end: { date_time: isoLocal(end), time_zone: site.tz },
                }),
            });
            toast(`Moved to ${fmtTime(newStart)}`);
        } else {
            // PATCH ignores space_id, so a room change is rebook + cancel. A dragged
            // occurrence of a series becomes a standalone booking in the new room.
            const s2 = spaces.find((x) => x.id === tgtSpace);
            const d = (await robin(`/events/${encodeURIComponent(eventId)}`)).data;
            const invitees = (d.invitees || [])
                .filter((i) => !i.is_resource && i.email)
                .map((i) => ({ email: i.email }));
            if (!invitees.length) invitees.push({ email: auth.email });
            await robin(`/events`, {
                method: "POST",
                body: JSON.stringify({
                    title: d.title || "Meeting",
                    ...(d.description ? { description: d.description } : {}),
                    space_id: tgtSpace,
                    calendar_type: s2.cal.type,
                    calendar_mailbox_address: s2.cal.mailbox,
                    invitees,
                    visibility: d.visibility === "private" ? "private" : "default",
                    start: { date_time: isoLocal(start), time_zone: site.tz },
                    end: { date_time: isoLocal(end), time_zone: site.tz },
                }),
            });
            await robin(`/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
            toast(`Moved to ${s2.name} at ${fmtTime(newStart)}`);
            reloadSpace(tgtSpace);
        }
        reloadSpace(spaceId);
    } catch (err) {
        toast("Move failed: " + err.message);
    } finally {
        srcTd.classList.remove("pending");
        td.classList.remove("pending");
    }
});

document.addEventListener("click", (e) => {
    if (!e.target.closest("#pop") && !e.target.closest("td")) hidePop();
    if (!e.target.closest("#amenfilter")) $("amenfilter").removeAttribute("open");
});

function positionPop(el) {
    const pop = $("pop");
    const r = el.getBoundingClientRect();
    pop.style.display = "flex";
    // measure the real rendered size (the photo reserves height via aspect-ratio)
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 8)) + "px";
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = r.top - h - 4; // flip above the cell
    pop.style.top = Math.max(8, Math.min(top, window.innerHeight - h - 8)) + "px";
}

function hidePop() { $("pop").style.display = "none"; }

// the popover grows when sections expand (e.g. recurrence options) — keep it on screen
function clampPop() {
    const pop = $("pop");
    if (pop.style.display !== "flex") return;
    const r = pop.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) pop.style.top = Math.max(8, window.innerHeight - r.height - 8) + "px";
    if (r.right > window.innerWidth - 4) pop.style.left = Math.max(4, window.innerWidth - r.width - 8) + "px";
}
new ResizeObserver(clampPop).observe($("pop"));

function fmtTime(min) {
    const h = Math.floor(min / 60), m = min % 60;
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// chip-style attendee editor inside #p-att; returns {get} -> email list (null if a
// half-typed entry is invalid)
function initChips(initial) {
    const box = $("p-att");
    const input = $("p-att-in");
    const emails = [...initial];
    const render = () => {
        for (const c of box.querySelectorAll(".chip")) c.remove();
        for (const em of emails) {
            const c = document.createElement("span");
            c.className = "chip";
            c.textContent = em;
            const x = document.createElement("button");
            x.type = "button";
            x.textContent = "×";
            x.onclick = () => { emails.splice(emails.indexOf(em), 1); render(); };
            c.appendChild(x);
            box.insertBefore(c, input);
        }
    };
    const commit = () => {
        const v = input.value.trim().replace(/,+$/, "");
        if (!v) return true;
        if (!EMAIL_RE.test(v)) { input.classList.add("bad"); return false; }
        input.classList.remove("bad");
        if (!emails.some((e) => e.toLowerCase() === v.toLowerCase())) { emails.push(v); render(); }
        input.value = "";
        return true;
    };
    input.onkeydown = (e) => {
        e.stopPropagation(); // keep Enter from submitting the popover
        if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
        else if (e.key === "Backspace" && !input.value && emails.length) { emails.pop(); render(); }
        else input.classList.remove("bad");
    };
    input.onblur = commit;
    input.oninput = () => { if (directory.some((u) => u.email === input.value)) commit(); };
    box.onclick = (e) => { if (e.target === box) input.focus(); };
    render();
    return { get: () => (commit() ? [...emails] : null) };
}

const chipsHtml = '<div class="chips" id="p-att"><input id="p-att-in" list="people" placeholder="Add attendee…"></div>';

function inviteesFrom(emails) {
    return [auth.email, ...emails]
        .filter((e, i, a) => a.findIndex((x) => x.toLowerCase() === e.toLowerCase()) === i)
        .map((email) => ({ email }));
}

// ---------- org directory (via the Worker's /api/users GraphQL proxy) ----------
let directory = [];

function fillPeopleList() {
    $("people").innerHTML = directory.map((u) => `<option value="${esc(u.email)}">${esc(u.name)}</option>`).join("");
}

async function loadDirectory() {
    try { directory = JSON.parse(localStorage.getItem(`robin.dir:${site.org_id}`)) || []; } catch {}
    if (directory.length) fillPeopleList();
    try {
        const res = await fetch("/api/users", {
            headers: { "Authorization": "Access-Token " + auth.token, "Tenant-Id": String(site.org_id) },
        });
        if (!res.ok) return;
        const fresh = (await res.json()).users || [];
        if (fresh.length && JSON.stringify(fresh) !== JSON.stringify(directory)) {
            directory = fresh;
            localStorage.setItem(`robin.dir:${site.org_id}`, JSON.stringify(directory));
            fillPeopleList();
        }
    } catch {}
}

// ---------- recurrence controls ----------
const BYDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINALS = ["", "first", "second", "third", "fourth", "fifth"];

function parseRule(rule) {
    if (!rule) return { freq: "", interval: 1, byday: [], bymonthday: null, count: null, until: null, monthlyBy: null, custom: false };
    const parts = {};
    for (const kv of rule.replace(/^RRULE:/, "").split(";")) {
        const [k, v] = kv.split("=");
        parts[k] = v;
    }
    const r = {
        freq: parts.FREQ || "",
        interval: +(parts.INTERVAL || 1),
        byday: parts.BYDAY ? parts.BYDAY.split(",") : [],
        bymonthday: parts.BYMONTHDAY ? +parts.BYMONTHDAY : null,
        count: parts.COUNT ? +parts.COUNT : null,
        until: parts.UNTIL ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}` : null,
        monthlyBy: null, // e.g. "BYMONTHDAY=15" or "BYDAY=3WE"
    };
    // figure out whether the editor can represent this rule; else offer keep-as-is
    const known = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "COUNT", "UNTIL", "WKST"]);
    let custom = !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(r.freq) ||
        Object.keys(parts).some((k) => !known.has(k)) ||
        (r.count && r.until);
    if (r.freq === "WEEKLY") {
        if (r.bymonthday !== null || r.byday.some((d) => !BYDAYS.includes(d))) custom = true;
    } else if (r.freq === "MONTHLY") {
        if (r.bymonthday !== null && !r.byday.length) r.monthlyBy = `BYMONTHDAY=${r.bymonthday}`;
        else if (r.byday.length === 1 && !r.bymonthday && /^(-1|[1-5])(SU|MO|TU|WE|TH|FR|SA)$/.test(r.byday[0])) r.monthlyBy = `BYDAY=${r.byday[0]}`;
        else if (r.byday.length || r.bymonthday !== null) custom = true;
    } else if (r.byday.length || r.bymonthday !== null) {
        custom = true; // BYDAY/BYMONTHDAY on DAILY/YEARLY
    }
    r.custom = custom;
    return r;
}

// monthly patterns derivable from the event's date
function monthlyChoices(date) {
    const dom = date.getDate();
    const wd = BYDAYS[date.getDay()];
    const nth = Math.ceil(dom / 7);
    const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const out = [
        [`BYMONTHDAY=${dom}`, `on day ${dom}`],
        [`BYDAY=${nth}${wd}`, `on the ${ORDINALS[nth]} ${DAY_NAMES[date.getDay()]}`],
    ];
    if (dom > daysInMonth - 7) out.push([`BYDAY=-1${wd}`, `on the last ${DAY_NAMES[date.getDay()]}`]);
    return out;
}

function recControlsHtml(rule, noneLabel) {
    const r = parseRule(rule);
    const sel = r.custom ? "__keep" : r.freq;
    const monthly = monthlyChoices(day);
    // a parsed monthly pattern not derivable from today's date still gets an option
    if (r.monthlyBy && !monthly.some(([v]) => v === r.monthlyBy)) {
        const m = r.monthlyBy.match(/^BYDAY=(-1|[1-5])(\w\w)$/);
        monthly.push([r.monthlyBy, m ? `on the ${m[1] === "-1" ? "last" : ORDINALS[+m[1]]} ${DAY_NAMES[BYDAYS.indexOf(m[2])]}` : `on day ${r.bymonthday}`]);
    }
    const units = { DAILY: "day(s)", WEEKLY: "week(s)", MONTHLY: "month(s)", YEARLY: "year(s)" };
    return `
        <select id="p-rep" data-orig="${esc(rule || "")}">
            <option value="">${noneLabel}</option>
            <option value="DAILY"${sel === "DAILY" ? " selected" : ""}>Daily</option>
            <option value="WEEKLY"${sel === "WEEKLY" ? " selected" : ""}>Weekly</option>
            <option value="MONTHLY"${sel === "MONTHLY" ? " selected" : ""}>Monthly</option>
            <option value="YEARLY"${sel === "YEARLY" ? " selected" : ""}>Yearly</option>
            ${r.custom ? '<option value="__keep" selected>Custom rule (keep as is)</option>' : ""}
        </select>
        <div id="p-recopts"${sel && sel !== "__keep" ? "" : " hidden"}>
            <div class="row recrow">
                <span class="sub">every</span>
                <input id="p-int" type="number" min="1" max="99" value="${r.custom ? 1 : r.interval}">
                <span class="sub" id="p-intu">${units[sel] || "week(s)"}</span>
            </div>
            <div class="days" id="p-bydays"${sel === "WEEKLY" ? "" : " hidden"}>
                ${BYDAYS.map((d, i) => `<button type="button" data-d="${d}" class="${r.byday.includes(d) ? "on" : ""}" title="${DAY_NAMES[i]}">${DAY_LETTERS[i]}</button>`).join("")}
            </div>
            <select id="p-monthly"${sel === "MONTHLY" ? "" : " hidden"}>
                ${monthly.map(([v, l]) => `<option value="${v}"${v === r.monthlyBy ? " selected" : ""}>${l}</option>`).join("")}
            </select>
            <div class="row" id="p-repend">
                <select id="p-endkind">
                    <option value="never"${!r.count && !r.until ? " selected" : ""}>never ends</option>
                    <option value="count"${r.count ? " selected" : ""}>ends after</option>
                    <option value="until"${r.until ? " selected" : ""}>ends on</option>
                </select>
                <input id="p-count" type="number" min="2" max="99" value="${r.count || 4}"${r.count ? "" : " hidden"}>
                <input id="p-until" type="date" value="${r.until || ""}"${r.until ? "" : " hidden"}>
            </div>
        </div>`;
}

function wireRecControls() {
    const units = { DAILY: "day(s)", WEEKLY: "week(s)", MONTHLY: "month(s)", YEARLY: "year(s)" };
    $("p-rep").onchange = () => {
        const f = $("p-rep").value;
        $("p-recopts").hidden = !f || f === "__keep";
        $("p-bydays").hidden = f !== "WEEKLY";
        $("p-monthly").hidden = f !== "MONTHLY";
        if (units[f]) $("p-intu").textContent = units[f];
        // weekly with nothing picked: default to the grid day's weekday
        if (f === "WEEKLY" && !$("p-bydays").querySelector(".on")) {
            $("p-bydays").querySelector(`[data-d="${BYDAYS[day.getDay()]}"]`).classList.add("on");
        }
        clampPop();
    };
    $("p-endkind").onchange = () => {
        const k = $("p-endkind").value;
        $("p-count").hidden = k !== "count";
        $("p-until").hidden = k !== "until";
        clampPop();
    };
    for (const b of $("p-bydays").querySelectorAll("button")) {
        b.onclick = () => b.classList.toggle("on");
    }
}

function buildRule() {
    const freq = $("p-rep").value;
    if (!freq) return null;
    if (freq === "__keep") return $("p-rep").dataset.orig || null;
    let rule = `RRULE:FREQ=${freq}`;
    const interval = Math.max(1, Math.min(99, +$("p-int").value || 1));
    if (interval > 1) rule += `;INTERVAL=${interval}`;
    if (freq === "WEEKLY") {
        const days = [...$("p-bydays").querySelectorAll(".on")].map((b) => b.dataset.d);
        if (days.length) rule += `;BYDAY=${days.join(",")}`;
    } else if (freq === "MONTHLY") {
        rule += `;${$("p-monthly").value}`;
    }
    const endkind = $("p-endkind").value;
    if (endkind === "count") rule += `;COUNT=${Math.max(2, Math.min(99, +$("p-count").value || 4))}`;
    else if (endkind === "until" && $("p-until").value) rule += `;UNTIL=${$("p-until").value.replaceAll("-", "")}T235959Z`;
    return rule;
}

function popEnterSubmits(fn) {
    $("pop").onkeydown = (e) => {
        if (e.key === "Escape") hidePop();
        if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") fn();
    };
}

function openBookPop(td, spaceId, slot) {
    const s = spaces.find((x) => x.id === spaceId);
    if (!s.cal) { toast(s.name + " has no calendar — book via the Robin dashboard"); return; }
    const startMin = DAY_START * 60 + slot * STEP_MIN;
    const evs = events.get(spaceId) || [];
    // max free duration from here
    let maxEnd = DAY_END * 60;
    for (const ev of evs) if (ev.startMin >= startMin) maxEnd = Math.min(maxEnd, ev.startMin);
    const maxDur = maxEnd - startMin;
    const durations = [15, 30, 45, 60, 90, 120].filter((d) => d <= maxDur);
    if (!durations.length) return;
    const pop = $("pop");
    pop.innerHTML = `
        ${s.img ? `<img class="thumb" src="${esc(s.img)}" alt="">` : ""}
        <div class="head">${esc(s.name)}</div>
        <div class="sub">${day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${fmtTime(startMin)}</div>
        ${s.note ? `<div class="sub roomnote">${esc(s.note)}</div>` : ""}
        ${s.amenities?.length ? `<div class="sub">${esc(s.amenities.join(" · "))}</div>` : ""}
        <input id="p-title" placeholder="Title" value="Meeting">
        <textarea id="p-desc" rows="2" placeholder="Description (optional)"></textarea>
        ${chipsHtml}
        ${recControlsHtml(null, "Does not repeat")}
        <label class="chk"><input type="checkbox" id="p-priv">Private</label>
        <div class="row">
            <select id="p-dur">${durations.map((d) => `<option value="${d}"${d === 30 ? " selected" : ""}>${d} min</option>`).join("")}</select>
            <button class="primary" id="p-book">Book</button>
        </div>
        <p class="err" id="p-err"></p>`;
    positionPop(td);
    wireRecControls();
    const chips = initChips([]);
    $("p-title").select();
    $("p-book").onclick = () => book(spaceId, startMin, chips);
    popEnterSubmits(() => book(spaceId, startMin, chips));
}

async function book(spaceId, startMin, chips) {
    const dur = +$("p-dur").value;
    const title = $("p-title").value.trim() || "Meeting";
    const desc = $("p-desc").value.trim();
    const start = new Date(day); start.setHours(0, startMin, 0, 0);
    const end = new Date(start.getTime() + dur * 60000);
    const emails = chips.get();
    if (!emails) { $("p-err").textContent = "Finish or clear the attendee email"; return; }
    $("p-book").disabled = true;
    $("p-err").textContent = "";
    const rule = buildRule();
    try {
        const s = spaces.find((x) => x.id === spaceId);
        await robin(`/events`, {
            method: "POST",
            body: JSON.stringify({
                title,
                ...(desc ? { description: desc } : {}),
                space_id: spaceId,
                calendar_type: s.cal.type,
                calendar_mailbox_address: s.cal.mailbox,
                invitees: inviteesFrom(emails),
                visibility: $("p-priv").checked ? "private" : "default",
                ...(rule ? { recurrence: [rule] } : {}),
                start: { date_time: isoLocal(start), time_zone: site.tz },
                end: { date_time: isoLocal(end), time_zone: site.tz },
            }),
        });
        hidePop();
        toast(`Booked ${s.name} at ${fmtTime(startMin)}${rule ? " (recurring)" : ""}`);
        reloadSpace(spaceId);
    } catch (e) {
        $("p-err").textContent = e.message;
        $("p-book").disabled = false;
    }
}

function openEventPop(td, spaceId, eventId) {
    const ev = (events.get(spaceId) || []).find((e) => e.id === eventId);
    if (!ev) return;
    const isInstance = eventId.includes("_");
    const pop = $("pop");
    pop.innerHTML = `
        <div class="head">${esc(ev.title)}</div>
        <div class="sub">${fmtTime(ev.startMin)} – ${fmtTime(ev.endMin)}</div>
        ${ev.desc ? `<div class="sub desc">${esc(ev.desc)}</div>` : ""}
        <button id="p-edit">Edit${isInstance ? " this occurrence" : ""}</button>
        <button class="danger" id="p-del">${isInstance ? "Cancel this occurrence" : "Cancel booking"}</button>
        ${isInstance ? '<button class="danger" id="p-delseries">Cancel whole series</button>' : ""}
        <p class="err" id="p-err"></p>`;
    positionPop(td);
    $("p-edit").onclick = () => openEditPop(td, spaceId, eventId);
    const del = async (id, msg) => {
        try {
            await robin(`/events/${encodeURIComponent(id)}`, { method: "DELETE" });
            hidePop();
            toast(msg);
            reloadSpace(spaceId);
        } catch (e) {
            $("p-err").textContent = e.message;
            $("p-del").disabled = false;
            const ps = $("p-delseries"); if (ps) ps.disabled = false;
        }
    };
    $("p-del").onclick = () => { $("p-del").disabled = true; del(eventId, "Booking cancelled"); };
    if (isInstance) $("p-delseries").onclick = () => { $("p-delseries").disabled = true; del(eventId.split("_")[0], "Series cancelled"); };
}

async function openEditPop(el, spaceId, eventId) {
    const pop = $("pop");
    pop.innerHTML = `<div class="sub">Loading…</div>`;
    positionPop(el);
    const isInstance = eventId.includes("_");
    const masterId = isInstance ? eventId.split("_")[0] : eventId;
    let d, masterRule;
    try {
        d = (await robin(`/events/${encodeURIComponent(eventId)}`)).data;
        // recurrence lives on the series master only
        masterRule = isInstance
            ? ((await robin(`/events/${encodeURIComponent(masterId)}`)).data.recurrence || [])[0] || null
            : (d.recurrence || [])[0] || null;
    } catch (e) {
        pop.innerHTML = `<p class="err">${esc(e.message)}</p>`;
        return;
    }
    const s = spaces.find((x) => x.id === spaceId);
    const startMin = minutesOfDay(d.start);
    const dur = minutesOfDay(d.end) - startMin;
    const attendees = (d.invitees || [])
        .filter((i) => !i.is_resource && i.email && i.email.toLowerCase() !== auth.email.toLowerCase())
        .map((i) => i.email);
    const starts = [];
    for (let m = DAY_START * 60; m < DAY_END * 60; m += STEP_MIN) starts.push(m);
    if (!starts.includes(startMin)) starts.push(startMin), starts.sort((a, b) => a - b);
    const durs = [15, 30, 45, 60, 90, 120];
    if (!durs.includes(dur)) durs.push(dur), durs.sort((a, b) => a - b);
    pop.innerHTML = `
        <div class="head">Edit — ${esc(s.name)}${isInstance ? '<span class="sub"> (this occurrence)</span>' : ""}</div>
        <input id="p-title" placeholder="Title" value="${esc(d.title || "")}">
        <textarea id="p-desc" rows="2" placeholder="Description (optional)">${esc(plainText(d.description))}</textarea>
        ${chipsHtml}
        <div class="row">
            <select id="p-start">${starts.map((m) => `<option value="${m}"${m === startMin ? " selected" : ""}>${fmtTime(m)}</option>`).join("")}</select>
            <select id="p-dur">${durs.map((x) => `<option value="${x}"${x === dur ? " selected" : ""}>${x} min</option>`).join("")}</select>
        </div>
        ${isInstance ? '<div class="sub">Series repeats:</div>' : ""}
        ${recControlsHtml(masterRule, isInstance ? "Stop repeating" : "Does not repeat")}
        <label class="chk"><input type="checkbox" id="p-priv"${d.visibility === "private" ? " checked" : ""}>Private</label>
        <button class="primary" id="p-save">Save</button>
        <p class="err" id="p-err"></p>`;
    positionPop(el);
    wireRecControls();
    const chips = initChips(attendees);
    const save = async () => {
        const emails = chips.get();
        if (!emails) { $("p-err").textContent = "Finish or clear the attendee email"; return; }
        const newStart = new Date(day); newStart.setHours(0, +$("p-start").value, 0, 0);
        const newEnd = new Date(newStart.getTime() + +$("p-dur").value * 60000);
        const rule = buildRule();
        $("p-save").disabled = true;
        $("p-err").textContent = "";
        try {
            await robin(`/events/${encodeURIComponent(eventId)}`, {
                method: "PATCH",
                body: JSON.stringify({
                    title: $("p-title").value.trim() || "Meeting",
                    description: $("p-desc").value.trim(),
                    invitees: inviteesFrom(emails),
                    visibility: $("p-priv").checked ? "private" : "default",
                    start: { date_time: isoLocal(newStart), time_zone: site.tz },
                    end: { date_time: isoLocal(newEnd), time_zone: site.tz },
                    // recurrence must be PATCHed on the master, separately for instances
                    ...(isInstance ? {} : rule !== masterRule ? { recurrence: rule ? [rule] : null } : {}),
                }),
            });
            if (isInstance && rule !== masterRule) {
                await robin(`/events/${encodeURIComponent(masterId)}`, {
                    method: "PATCH",
                    body: JSON.stringify({ recurrence: rule ? [rule] : null }),
                });
            }
            hidePop();
            toast("Booking updated");
            reloadSpace(spaceId);
        } catch (e) {
            $("p-err").textContent = e.message;
            $("p-save").disabled = false;
        }
    };
    $("p-save").onclick = save;
    popEnterSubmits(save);
}

async function reloadSpace(spaceId) {
    const { after, before } = dayRange();
    try {
        const json = await robin(`/spaces/${spaceId}/events?per_page=100&after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}`);
        events.set(spaceId, (json.data || []).map((e) => ({
            desc: plainText(e.description),
            id: e.id,
            title: e.title || "Reserved",
            startMin: minutesOfDay(e.start),
            endMin: minutesOfDay(e.end),
            mine: e.creator_id === auth.account_id || (e.creator_email && e.creator_email.toLowerCase() === auth.email.toLowerCase()),
        })));
        updateSpaceView(spaceId);
    } catch {}
}

function isoLocal(d) {
    // ISO 8601 with local offset, e.g. 2026-09-02T13:30:00-07:00
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const p = (n) => String(Math.abs(n)).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

let toastTimer;
function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.display = "none"), 2500);
}

// ---------- map view ----------
const ATLAS = "https://atlas.services.robinpowered.com";
let view = "grid";
let mapData = null;   // {levels:[{id,name}], plans:{levelId:svgUrl}, geo:{spaceId:[[x,y],...]}}
let curLevel = null;
let mapMin = null;    // selected map time, minutes of day

async function atlas(path) {
    const res = await fetch(ATLAS + path, {
        headers: { "Authorization": "Access-Token " + auth.token, "Tenant-Id": String(site.org_id) },
    });
    if (!res.ok) throw new Error("atlas " + res.status);
    return (await res.json()).data;
}

async function loadMapData() {
    if (mapData) return;
    try { mapData = JSON.parse(localStorage.getItem(`robin.map:${site.loc_id}`)); } catch {}
    if (mapData) { refreshMapDataInBackground(); return; }
    mapData = await fetchMapData();
}
async function fetchMapData() {
    const levelsJson = await robin(`/locations/${site.loc_id}/levels?per_page=100`);
    const levels = levelsJson.data
        .map((l) => ({ id: +l.id, name: l.name }))
        .sort((a, b) => (parseInt(a.name.replace(/\D/g, "")) || 0) - (parseInt(b.name.replace(/\D/g, "")) || 0));
    const [plansArr, feats] = await Promise.all([
        atlas(`/floorplans/levels?ids=${levels.map((l) => l.id).join(",")}`),
        atlas(`/layers/spaces?ids=${spaces.map((s) => s.id).join(",")}`),
    ]);
    const plans = {};
    for (const p of plansArr) plans[p.entityId] = p.svg;
    const geo = {};
    for (const f of feats) {
        if (f.geometry?.type === "Polygon") geo[f.properties.ownerId] = f.geometry.coordinates[0];
    }
    const data = { levels: levels.filter((l) => plans[l.id]), plans, geo };
    localStorage.setItem(`robin.map:${site.loc_id}`, JSON.stringify(data));
    return data;
}
async function refreshMapDataInBackground() {
    try {
        const fresh = await fetchMapData();
        if (JSON.stringify(fresh) !== JSON.stringify(mapData)) { mapData = fresh; if (view === "map") renderMap(); }
    } catch {}
}

// Floorplan natural sizes, measured by loading each SVG as an image once.
const planSizes = {};
function planSize(url) {
    if (planSizes[url]) return Promise.resolve(planSizes[url]);
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve((planSizes[url] = { w: img.naturalWidth || 3600, h: img.naturalHeight || 1800 }));
        img.onerror = () => reject(new Error("floorplan failed to load"));
        img.src = url;
    });
}

function defaultMapMin() {
    const now = new Date();
    if (now.toDateString() === day.toDateString()) {
        const m = Math.ceil((now.getHours() * 60 + now.getMinutes()) / STEP_MIN) * STEP_MIN;
        return Math.max(DAY_START * 60, Math.min(m, DAY_END * 60 - 30));
    }
    return 9 * 60;
}

function renderMap() {
    if (!mapData) return;
    if (!curLevel || !mapData.plans[curLevel]) curLevel = mapData.levels[0]?.id;
    if (mapMin === null) mapMin = defaultMapMin();
    $("floors").innerHTML = mapData.levels.map((l) =>
        `<button class="floor${l.id === curLevel ? " sel" : ""}" data-level="${l.id}">${esc(l.name.replace("Floor ", ""))}</button>`).join(" ");
    for (const b of $("floors").querySelectorAll("button")) b.onclick = () => {
        curLevel = +b.dataset.level;
        localStorage.setItem(`robin.level:${site.loc_id}`, String(curLevel));
        renderMap();
    };
    // time options: 30-min steps
    const opts = [];
    for (let m = DAY_START * 60; m < DAY_END * 60; m += 30) opts.push(`<option value="${m}"${m === mapMin ? " selected" : ""}>${fmtTime(m)}</option>`);
    $("maptime").innerHTML = opts.join("");
    $("maptime").onchange = () => { mapMin = +$("maptime").value; renderMap(); };
    const planUrl = mapData.plans[curLevel];
    const size = planSizes[planUrl];
    if (!size) {
        // measure the floorplan once, then re-render with real dimensions
        planSize(planUrl).then(() => renderMap()).catch(() => toast("Floorplan failed to load"));
        $("mapinner").innerHTML = "";
        return;
    }
    const { w: W, h: H } = size;
    // atlas world coords: x in [-180,180], y in [90,-90] (y up) over the full plan
    const px = (x) => ((x + 180) / 360 * W).toFixed(1);
    const py = (y) => ((90 - y) / 180 * H).toFixed(1);
    const fontSize = Math.round(W / 90);
    const visible = new Set(visibleSpaces().map((s) => s.id));
    // one self-contained SVG (white rect + floorplan image + room shapes): SVG
    // shapes use fill, which dark-mode extensions' background overrides can't touch
    let svg = `<svg viewBox="0 0 ${W} ${H}" font-size="${fontSize}">`;
    svg += `<rect width="${W}" height="${H}" fill="#fff" rx="${W / 300}"/>`;
    svg += `<image href="${esc(planUrl)}" width="${W}" height="${H}"/>`;
    for (const s of spaces) {
        if (s.level_id !== curLevel) continue;
        const ring = mapData.geo[s.id];
        if (!ring) continue;
        const pts = ring.map(([x, y]) => `${px(x)},${py(y)}`).join(" ");
        const evs = events.get(s.id) || [];
        const busy = evs.some((e) => e.startMin < mapMin + 30 && e.endMin > mapMin);
        const cls = !visible.has(s.id) || !s.cal ? "dim" : busy ? "busy" : "free";
        const cx = px(ring.reduce((a, p) => a + p[0], 0) / ring.length);
        const cy = py(ring.reduce((a, p) => a + p[1], 0) / ring.length);
        const tip = `${s.name}${s.capacity ? ` (${s.capacity}p)` : ""}${s.note ? `\n${s.note}` : ""}${s.amenities?.length ? "\n" + s.amenities.join(", ") : ""}`;
        svg += `<polygon class="${cls}" points="${pts}" data-space="${s.id}" stroke-width="${W / 900}"><title>${esc(tip)}</title></polygon>`;
        svg += `<text x="${cx}" y="${cy}">${esc(s.name)}</text>`;
    }
    svg += "</svg>";
    $("mapinner").innerHTML = svg;
    for (const poly of $("mapinner").querySelectorAll("polygon")) {
        poly.onclick = (e) => {
            e.stopPropagation();
            const spaceId = +poly.dataset.space;
            const slot = (mapMin - DAY_START * 60) / STEP_MIN;
            const evs = events.get(spaceId) || [];
            const ev = evs.find((x) => x.startMin < mapMin + 30 && x.endMin > mapMin);
            if (ev) { if (ev.mine) openEventPop(poly, spaceId, ev.id); return; }
            if (poly.classList.contains("free")) openBookPop(poly, spaceId, slot);
        };
    }
}

function updateSpaceView(spaceId) {
    if (view === "grid") renderRow(spaceId);
    else renderMap();
}

function renderView() {
    $("gridwrap").style.display = view === "grid" ? "" : "none";
    $("mapwrap").style.display = view === "map" ? "flex" : "none";
    $("viewtoggle").textContent = view === "grid" ? "Map" : "Grid";
    $("datelabel").textContent = day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    $("datepick").value = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    if (view === "grid") renderGrid();
    else { loadMapData().then(renderMap).catch((e) => toast("Map failed to load: " + e.message)); }
}

$("viewtoggle").onclick = () => { view = view === "grid" ? "map" : "grid"; hidePop(); renderView(); };

// ---------- nav ----------
function setDay(d) { day = d; hidePop(); events.clear(); mapMin = null; renderView(); loadDay(); }
$("prev").onclick = () => setDay(new Date(day.getTime() - 864e5));
$("next").onclick = () => setDay(new Date(day.getTime() + 864e5));
$("today").onclick = () => setDay(startOfToday());
$("datepick").onchange = () => {
    const [y, m, dd] = $("datepick").value.split("-").map(Number);
    if (y) setDay(new Date(y, m - 1, dd));
};
$("refresh").onclick = () => loadDay();
$("mincap").onchange = () => { renderView(); loadDay(true); };
$("logout").onclick = logout;
setInterval(() => { if (document.querySelector("tr[data-space]")) renderView(); }, 60000);

// ---------- boot ----------
async function start() {
    $("login").style.display = "none";
    // pre-generic cache keys
    for (const k of ["robin.spaces", "robin.spaces.v2", "robin.map", "robin.level"]) localStorage.removeItem(k);
    if (!site?.loc_id) {
        try {
            await pickSite();
        } catch (e) {
            logout();
            $("l-err").textContent = e.message;
            return;
        }
    }
    document.title = site.loc_name + " Rooms";
    $("sitename").textContent = site.loc_name;
    curLevel = +localStorage.getItem(`robin.level:${site.loc_id}`) || null;
    $("app").style.display = "flex";
    $("who").textContent = auth.email;
    await loadSpaces();
    buildAmenMenu();
    renderView();
    loadDay();
    loadAmenities();
    loadDirectory();
}
$("sitename").onclick = switchSite;
auth = loadAuth();
if (auth) start();
