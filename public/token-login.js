"use strict";
// Shared by app.js and authorize.js: sign in with a Robin access token the user already has
// (copied from dashboard.robinpowered.com), for people who sign in to Robin with Google/SSO
// and have no password, or who would rather not type one here. The token goes only to
// api.robinpowered.com, exactly like the one a password login mints.
const ROBIN_API = "https://api.robinpowered.com/v1.0";
const TOKEN_DAYS = 14; // Robin's remember_me tokens last ~14 days; /me doesn't report expiry

// Accepts the bare token, "Access-Token <token>", a whole "Authorization: Access-Token …"
// header line, or the dashboard's JSON {"access_token": …, "expire_at": …} (URL-encoded or not).
function parseRobinToken(raw) {
    let s = String(raw || "").trim();
    try { s = decodeURIComponent(s); } catch {}
    const json = s.match(/"access_token"\s*:\s*"([^"]+)"/);
    if (json) return { token: json[1], expire_at: s.match(/"expire_at"\s*:\s*"([^"]+)"/)?.[1] || null };
    s = s.replace(/^authorization\s*:\s*/i, "").replace(/^(access-token|bearer)\s+/i, "");
    return { token: s.replace(/\s+/g, ""), expire_at: null };
}

// Resolves to {token, account_id, email, expire_at} after checking the token against /me.
async function robinTokenLogin(raw) {
    const { token, expire_at } = parseRobinToken(raw);
    if (!token) throw new Error("Paste your Robin access token first");
    const res = await fetch(ROBIN_API + "/me", { headers: { "Authorization": "Access-Token " + token } });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new Error("Robin rejected that token — copy a fresh one from the dashboard");
    if (!res.ok || !json.data?.id) throw new Error(json.meta?.message || "Could not verify the token");
    const exp = expire_at && new Date(expire_at) > new Date() ? expire_at : null;
    return {
        token,
        account_id: json.data.id,
        email: json.data.primary_email?.email || "",
        expire_at: exp || new Date(Date.now() + TOKEN_DAYS * 864e5).toISOString(),
    };
}
