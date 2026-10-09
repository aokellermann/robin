// The Worker has three jobs:
//   1. /api/users — proxy for Robin's GraphQL people directory (browser-inaccessible
//      because of its CORS allowlist). Forwards the caller's own token.
//   2. OAuth 2.1 authorization server (via @cloudflare/workers-oauth-provider) so that
//      MCP clients such as Claude Desktop can connect. /authorize is our page: the
//      browser logs in to Robin *client-side* and hands the Worker only the resulting
//      Robin access token, which is stored encrypted in KV (OAUTH_KV) against the grant.
//      The password never reaches this server.
//   3. /mcp — the MCP server (mcp.js), run with the caller's own Robin token.
import { OAuthProvider, OAuthError, AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { handleMcp } from "./mcp.js";

const ORIGIN = "https://robin.aok.site";
const ROBIN = "https://api.robinpowered.com/v1.0";
const GRAPHQL = "https://federation-gateway.robinpowered.com/graphql";
const USERS_QUERY_HASH = "5a3d5281feda79e8939c7fcfa5d88f77d64618e4417529ab75bcb7a833fd3163";
const SCOPE = "rooms";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Robin tokens from /auth/users with remember_me last ~14 days and cannot be refreshed,
// so the OAuth grant must not outlive them.
const robinSecondsLeft = (props) => Math.floor((Date.parse(props.expire_at) - Date.now()) / 1000);

async function apiUsers(req) {
    const auth = req.headers.get("authorization");
    const tenant = req.headers.get("tenant-id");
    if (!auth || !/^\d+$/.test(tenant || "")) return new Response("Unauthorized", { status: 401 });
    const qs = new URLSearchParams({
        operationName: "getPagedUsers",
        variables: JSON.stringify({
            limit: 5000,
            offset: 0,
            filters: { favoriteFilter: false, userNameFilter: "" },
            organizationId: tenant,
        }),
        extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: USERS_QUERY_HASH } }),
    });
    const res = await fetch(`${GRAPHQL}?${qs}`, {
        headers: {
            "authorization": auth,
            "tenant-id": tenant,
            "content-type": "application/json",
            "apollographql-client-name": "people-ui",
        },
    });
    if (!res.ok) return new Response("Upstream error", { status: 502 });
    const data = await res.json();
    const users = (data.data?.getPagedUsers?.accountUsers || [])
        .map((u) => ({ name: (u.name || "").trim(), email: u.primaryEmail?.email || null }))
        .filter((u) => u.email);
    return Response.json({ users }, { headers: { "cache-control": "private, max-age=3600" } });
}

// ---------- /authorize: consent page with client-side Robin login ----------
function consentPage(details, handle) {
    const who = details.clientDomain
        ? `<strong>${esc(details.clientName)}</strong> (${esc(details.clientDomain)})`
        : `<strong>${esc(details.clientName)}</strong> <span class="muted">(self-registered, name unverified)</span>`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to Robin Rooms</title>
<link rel="stylesheet" href="/style.css">
<script src="/authorize.js" defer></script>
</head>
<body>
<div id="login" class="consent">
    <h1>Connect ${who} to Robin</h1>
    <p>Lets it list rooms and book, edit and cancel room bookings <em>as you</em>, through robin.aok.site.
       Access goes to <strong>${esc(details.redirectHost)}</strong>.</p>
    ${details.redirectIsLoopback ? `<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>` : ""}
    <p class="muted">Your password is sent from this page straight to api.robinpowered.com and never to this server.
       The server keeps only the resulting Robin access token (encrypted, valid about two weeks) so it can act for you.
       You can disconnect at any time from your Claude settings.</p>
    <form id="form" data-handle="${esc(handle)}">
        <input id="l-email" type="email" placeholder="Email" autocomplete="username" required>
        <input id="l-pass" type="password" placeholder="Robin password" autocomplete="current-password" required>
        <p class="err" id="l-err"></p>
        <button class="primary" id="l-go" type="submit">Sign in and allow</button>
        <button id="l-deny" type="button">Deny</button>
    </form>
    <div id="site" hidden>
        <h1>Choose a building</h1>
        <div id="site-list"></div>
    </div>
</div>
</body>
</html>`;
}

const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https://api.robinpowered.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

async function authorizeGet(req, env) {
    const oauth = env.OAUTH_PROVIDER;
    const authReq = await oauth.parseAuthRequest(req);
    const details = await oauth.describeConsent(authReq);
    const consent = await oauth.beginConsent(authReq);
    consent.headers.set("content-type", "text/html; charset=utf-8");
    consent.headers.set("content-security-policy", PAGE_CSP);
    consent.headers.set("referrer-policy", "no-referrer");
    consent.headers.set("cache-control", "no-store");
    return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

// The page posts JSON: {handle, decision, token, account_id, email, expire_at, org_id,
// org_name, loc_id, loc_name, tz}. The token is verified against Robin before anything is
// stored, so a caller can only ever bind their own Robin session to the grant.
async function authorizePost(req, env) {
    const oauth = env.OAUTH_PROVIDER;
    const body = await req.json().catch(() => ({}));
    const handle = String(body.handle || "");
    if (body.decision !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return Response.json({ redirectTo: denied.redirectTo }, { headers: denied.headers });
    }
    const props = {
        token: String(body.token || ""),
        account_id: Number(body.account_id),
        email: String(body.email || "").slice(0, 200),
        expire_at: String(body.expire_at || ""),
        org_id: Number(body.org_id),
        org_name: String(body.org_name || "").slice(0, 200),
        loc_id: Number(body.loc_id),
        loc_name: String(body.loc_name || "").slice(0, 200),
        tz: String(body.tz || "UTC").slice(0, 64),
    };
    if (!props.token || !props.account_id || !props.org_id || !props.loc_id || !(robinSecondsLeft(props) > 60)) {
        return Response.json({ error: "Incomplete login" }, { status: 400 });
    }
    try { new Intl.DateTimeFormat("en-US", { timeZone: props.tz }); } catch { props.tz = "UTC"; }
    const check = await fetch(`${ROBIN}/me/organizations`, {
        headers: { "Authorization": "Access-Token " + props.token },
    });
    const orgs = check.ok ? (await check.json()).data || [] : null;
    if (!orgs || !orgs.some((o) => Number(o.id) === props.org_id && !o.disabled_at)) {
        return Response.json({ error: "Robin rejected the session" }, { status: 400 });
    }
    const approved = await oauth.approveConsent(req, handle, { scope: [SCOPE] });
    const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: `robin-${props.account_id}`,
        metadata: { email: props.email, org: props.org_name, building: props.loc_name },
        scope: [SCOPE],
        props,
    });
    return Response.json({ redirectTo }, { headers: approved.headers });
}

const defaultHandler = {
    async fetch(req, env) {
        const url = new URL(req.url);
        try {
            if (url.pathname === "/api/users" && req.method === "GET") return await apiUsers(req);
            if (url.pathname === "/authorize" && req.method === "GET") return await authorizeGet(req, env);
            if (url.pathname === "/authorize" && req.method === "POST") return await authorizePost(req, env);
        } catch (e) {
            if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
            if (e instanceof AuthorizationError || e instanceof CimdFetchError || e instanceof OAuthError) {
                const msg = e instanceof CimdFetchError ? "This app could not be verified." : (e.description || e.message || "Invalid request");
                if (req.method === "POST") return Response.json({ error: msg }, { status: 400 });
                return new Response(msg, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
            }
            throw e;
        }
        return new Response("Not found", { status: 404 });
    },
};

const apiHandler = {
    fetch(req, env, ctx) {
        return handleMcp(req, ctx.props, { robin: ROBIN });
    },
};

export default new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: {
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
        resource_name: "Robin Rooms",
    },
    accessTokenTTL: 3600,
    refreshTokenTTL: 15 * 24 * 3600,
    tokenExchangeCallback: ({ grantType, props }) => {
        const left = robinSecondsLeft(props);
        if (!(left > 60)) {
            // Revokes the grant: the client sends the user back through /authorize.
            throw new OAuthError("invalid_grant", { description: "Your Robin session has expired. Reconnect to sign in again." });
        }
        if (grantType === "authorization_code" || grantType === "refresh_token") {
            return { accessTokenTTL: Math.min(3600, left) };
        }
    },
});
