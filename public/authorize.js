"use strict";
// Consent page for the MCP OAuth flow. The Robin login happens here, in the browser:
// the password goes only to api.robinpowered.com; the Worker receives the resulting
// access token plus the chosen org and its buildings, verifies it against Robin, and stores it.
const API = "https://api.robinpowered.com/v1.0";
const $ = (id) => document.getElementById(id);
const form = $("form");
const handle = form.dataset.handle;
let auth = null;

async function post(body) {
    const res = await fetch("/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, ...body }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.redirectTo) throw new Error(json.error || "Authorization failed; start over from the app");
    location.href = json.redirectTo;
}

async function robin(path, orgId) {
    const res = await fetch(API + path, {
        headers: { "Authorization": "Access-Token " + auth.token, ...(orgId ? { "Tenant-Id": String(orgId) } : {}) },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.meta?.message || res.status + " error");
    return json;
}

function choose(title, options) {
    return new Promise((resolve) => {
        form.hidden = true;
        const card = $("site");
        card.querySelector("h1").textContent = title;
        const list = $("site-list");
        list.innerHTML = "";
        for (const o of options) {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = o.name;
            b.onclick = () => { card.hidden = true; resolve(o); };
            list.appendChild(b);
        }
        card.hidden = false;
    });
}

form.onsubmit = async (e) => {
    e.preventDefault();
    const email = $("l-email").value.trim(), pass = $("l-pass").value;
    $("l-err").textContent = "";
    if (!email || !pass) return;
    $("l-go").disabled = true;
    try {
        const res = await fetch(API + "/auth/users", {
            method: "POST",
            headers: { "Authorization": "Basic " + btoa(email + ":" + pass), "Content-Type": "application/json" },
            body: JSON.stringify({ remember_me: true }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.meta?.message || "Login failed");
        auth = { token: json.data.access_token, account_id: json.data.account_id, expire_at: json.data.expire_at, email };
        $("l-pass").value = "";

        const orgs = (await robin("/me/organizations")).data.filter((o) => !o.disabled_at);
        if (!orgs.length) throw new Error("Your account belongs to no Robin organization");
        const org = orgs.length === 1 ? orgs[0] : await choose("Choose an organization", orgs);
        const locs = (await robin(`/organizations/${org.id}/locations?per_page=100`, org.id)).data;
        if (!locs.length) throw new Error(`${org.name} has no locations`);
        const fallbackTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

        await post({
            decision: "approve",
            token: auth.token,
            account_id: auth.account_id,
            email: auth.email,
            expire_at: auth.expire_at,
            org_id: +org.id,
            org_name: org.name,
            locations: locs.map((l) => ({ id: +l.id, name: l.name, tz: l.time_zone || fallbackTz })),
        });
    } catch (err) {
        form.hidden = false;
        $("site").hidden = true;
        $("l-err").textContent = err.message;
        $("l-go").disabled = false;
    }
};

$("l-deny").onclick = async () => {
    try { await post({ decision: "deny" }); } catch (err) { $("l-err").textContent = err.message; }
};
