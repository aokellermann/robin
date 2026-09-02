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
            html += `<td class="slot busy${ev.mine ? " mine" : ""}${past ? " past" : ""}" colspan="${span}" data-event="${esc(ev.id)}" title="${esc(ev.title)}">${esc(ev.title)}</td>`;
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

function esc(x) {
    return String(x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- interactions ----------
$("grid").addEventListener("click", (e) => {
    const td = e.target.closest("td");
    if (!td) return;
    const tr = td.closest("tr[data-space]");
    if (!tr) return;
    const spaceId = +tr.dataset.space;
    if (td.dataset.slot !== undefined) openBookPop(td, spaceId, +td.dataset.slot);
    else if (td.dataset.event && td.classList.contains("mine")) openEventPop(td, spaceId, td.dataset.event);
});

document.addEventListener("click", (e) => {
    if (!e.target.closest("#pop") && !e.target.closest("td")) hidePop();
    if (!e.target.closest("#amenfilter")) $("amenfilter").removeAttribute("open");
});

function positionPop(el) {
    const pop = $("pop");
    const r = el.getBoundingClientRect();
    pop.style.display = "flex";
    pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 280)) + "px";
    pop.style.top = Math.max(4, Math.min(r.bottom + 4, window.innerHeight - 260)) + "px";
}

function hidePop() { $("pop").style.display = "none"; }

function fmtTime(min) {
    const h = Math.floor(min / 60), m = min % 60;
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
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
        <input id="p-att" placeholder="Attendees (emails, comma-separated)">
        <div class="row">
            <select id="p-rep">
                <option value="">Does not repeat</option>
                <option value="FREQ=DAILY">Daily</option>
                <option value="FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR">Every weekday</option>
                <option value="FREQ=WEEKLY">Weekly</option>
                <option value="FREQ=MONTHLY">Monthly</option>
            </select>
            <input id="p-count" type="number" min="2" max="52" value="4" title="Number of occurrences" hidden>
        </div>
        <label class="chk"><input type="checkbox" id="p-priv">Private</label>
        <div class="row">
            <select id="p-dur">${durations.map((d) => `<option value="${d}"${d === 30 ? " selected" : ""}>${d} min</option>`).join("")}</select>
            <button class="primary" id="p-book">Book</button>
        </div>
        <p class="err" id="p-err"></p>`;
    positionPop(td);
    $("p-rep").onchange = () => { $("p-count").hidden = !$("p-rep").value; };
    $("p-title").select();
    $("p-book").onclick = () => book(spaceId, startMin);
    pop.onkeydown = (e) => { if (e.key === "Enter") book(spaceId, startMin); if (e.key === "Escape") hidePop(); };
}

async function book(spaceId, startMin) {
    const dur = +$("p-dur").value;
    const title = $("p-title").value.trim() || "Meeting";
    const start = new Date(day); start.setHours(0, startMin, 0, 0);
    const end = new Date(start.getTime() + dur * 60000);
    $("p-book").disabled = true;
    $("p-err").textContent = "";
    const attendees = $("p-att").value.split(",").map((e) => e.trim()).filter(Boolean);
    const bad = attendees.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad) { $("p-err").textContent = `Invalid email: ${bad}`; $("p-book").disabled = false; return; }
    const invitees = [auth.email, ...attendees]
        .filter((e, i, a) => a.findIndex((x) => x.toLowerCase() === e.toLowerCase()) === i)
        .map((email) => ({ email }));
    const rep = $("p-rep").value;
    try {
        const s = spaces.find((x) => x.id === spaceId);
        await robin(`/events`, {
            method: "POST",
            body: JSON.stringify({
                title,
                space_id: spaceId,
                calendar_type: s.cal.type,
                calendar_mailbox_address: s.cal.mailbox,
                invitees,
                visibility: $("p-priv").checked ? "private" : "default",
                ...(rep ? { recurrence: [`RRULE:${rep};COUNT=${Math.max(2, Math.min(52, +$("p-count").value || 4))}`] } : {}),
                start: { date_time: isoLocal(start), time_zone: site.tz },
                end: { date_time: isoLocal(end), time_zone: site.tz },
            }),
        });
        hidePop();
        toast(`Booked ${spaces.find((s) => s.id === spaceId).name} at ${fmtTime(startMin)}${rep ? " (recurring)" : ""}`);
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
    let d;
    try {
        d = (await robin(`/events/${encodeURIComponent(eventId)}`)).data;
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
        <div class="head">Edit — ${esc(s.name)}</div>
        <input id="p-title" placeholder="Title" value="${esc(d.title || "")}">
        <input id="p-att" placeholder="Attendees (emails, comma-separated)" value="${esc(attendees.join(", "))}">
        <div class="row">
            <select id="p-start">${starts.map((m) => `<option value="${m}"${m === startMin ? " selected" : ""}>${fmtTime(m)}</option>`).join("")}</select>
            <select id="p-dur">${durs.map((x) => `<option value="${x}"${x === dur ? " selected" : ""}>${x} min</option>`).join("")}</select>
        </div>
        <label class="chk"><input type="checkbox" id="p-priv"${d.visibility === "private" ? " checked" : ""}>Private</label>
        <button class="primary" id="p-save">Save</button>
        <p class="err" id="p-err"></p>`;
    positionPop(el);
    $("p-save").onclick = async () => {
        const emails = $("p-att").value.split(",").map((e) => e.trim()).filter(Boolean);
        const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
        if (bad) { $("p-err").textContent = `Invalid email: ${bad}`; return; }
        const invitees = [auth.email, ...emails]
            .filter((e, i, a) => a.findIndex((x) => x.toLowerCase() === e.toLowerCase()) === i)
            .map((email) => ({ email }));
        const newStart = new Date(day); newStart.setHours(0, +$("p-start").value, 0, 0);
        const newEnd = new Date(newStart.getTime() + +$("p-dur").value * 60000);
        $("p-save").disabled = true;
        $("p-err").textContent = "";
        try {
            await robin(`/events/${encodeURIComponent(eventId)}`, {
                method: "PATCH",
                body: JSON.stringify({
                    title: $("p-title").value.trim() || "Meeting",
                    invitees,
                    visibility: $("p-priv").checked ? "private" : "default",
                    start: { date_time: isoLocal(newStart), time_zone: site.tz },
                    end: { date_time: isoLocal(newEnd), time_zone: site.tz },
                }),
            });
            hidePop();
            toast("Booking updated");
            reloadSpace(spaceId);
        } catch (e) {
            $("p-err").textContent = e.message;
            $("p-save").disabled = false;
        }
    };
}

async function reloadSpace(spaceId) {
    const { after, before } = dayRange();
    try {
        const json = await robin(`/spaces/${spaceId}/events?per_page=100&after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}`);
        events.set(spaceId, (json.data || []).map((e) => ({
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
}
$("sitename").onclick = switchSite;
auth = loadAuth();
if (auth) start();
