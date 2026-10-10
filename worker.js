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

const ROBIN = "https://api.robinpowered.com/v1.0";
const GRAPHQL = "https://federation-gateway.robinpowered.com/graphql";
const USERS_QUERY_HASH = "5a3d5281feda79e8939c7fcfa5d88f77d64618e4417529ab75bcb7a833fd3163";
const SCOPE = "rooms";

function validTz(tz) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; }
}

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
function consentPage(details, handle, host) {
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
<script src="/token-login.js" defer></script>
<script src="/authorize.js" defer></script>
</head>
<body>
<div id="login" class="consent">
    <h1>Connect ${who} to Robin</h1>
    <p>Lets it list rooms and book, edit and cancel room bookings <em>as you</em>, through ${esc(host)}.
       Access goes to <strong>${esc(details.redirectHost)}</strong>.</p>
    ${details.redirectIsLoopback ? `<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>` : ""}
    <p class="muted">Your password is sent from this page straight to api.robinpowered.com and never to this server.
       The server keeps only the resulting Robin access token (encrypted, valid about two weeks) so it can act for you.
       You can disconnect at any time from your Claude settings.</p>
    <form id="form" data-handle="${esc(handle)}">
        <div class="lform" id="l-passform">
            <input id="l-email" type="email" placeholder="Email" autocomplete="username">
            <input id="l-pass" type="password" placeholder="Robin password" autocomplete="current-password">
            <button class="primary" id="l-go" type="submit">Sign in and allow</button>
            <button class="link" id="l-usetoken" type="button">Sign in with an access token instead</button>
            <p class="muted">For Google / SSO accounts without a Robin password, or if you'd rather not type yours here.</p>
        </div>
        <div class="lform" id="l-tokform" hidden>
            <textarea id="l-token" rows="3" placeholder="Paste your Robin access token" autocomplete="off" spellcheck="false"></textarea>
            <button class="primary" id="l-tokgo" type="button">Allow with token</button>
            <details class="help">
                <summary>How to get your token</summary>
                <ol>
                    <li>Sign in at <a href="https://dashboard.robinpowered.com" target="_blank" rel="noopener">dashboard.robinpowered.com</a> as usual (Google sign-in works).</li>
                    <li>Open the browser's developer tools (<kbd>F12</kbd>), choose the <b>Network</b> tab and reload the page.</li>
                    <li>Click any request to <code>api.robinpowered.com</code>, find the <code>Authorization</code> request header and copy its value (<code>Access-Token …</code>) here.</li>
                </ol>
                <p>The token is what the dashboard itself uses; it lasts about two weeks and can't change your password.</p>
            </details>
            <button class="link" id="l-usepass" type="button">Sign in with email and password instead</button>
        </div>
        <p class="err" id="l-err"></p>
        <button id="l-deny" type="button">Deny</button>
    </form>
    <div id="site" hidden>
        <h1>Choose an organization</h1>
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
    return new Response(consentPage(details, consent.handle, new URL(req.url).host), { headers: consent.headers });
}

// The page posts JSON: {handle, decision, token, account_id, email, expire_at, org_id,
// org_name, locations: [{id, name, tz}]}. The token is verified against Robin before anything is
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
        locations: (Array.isArray(body.locations) ? body.locations : []).slice(0, 50).map((l) => ({
            id: Number(l?.id),
            name: String(l?.name || "").slice(0, 200),
            tz: validTz(String(l?.tz || "")),
        })).filter((l) => l.id > 0 && l.name),
    };
    if (!props.token || !props.account_id || !props.org_id || !props.locations.length || !(robinSecondsLeft(props) > 60)) {
        return Response.json({ error: "Incomplete login" }, { status: 400 });
    }
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
        metadata: { email: props.email, org: props.org_name },
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
        return handleMcp(req, ctx.props, { robin: ROBIN, kv: env.OAUTH_KV });
    },
};

// The site's origin is whatever the request came in on (custom domain, workers.dev, local
// dev), so nothing about the deployment is hardcoded. The provider needs the canonical
// resource URL up front, so one instance is built per origin seen by this isolate.
const providers = new Map();
function provider(origin) {
    let p = providers.get(origin);
    if (!p) providers.set(origin, (p = makeProvider(origin)));
    return p;
}

export default {
    fetch(req, env, ctx) {
        return provider(new URL(req.url).origin).fetch(req, env, ctx);
    },
};

const makeProvider = (ORIGIN) => new OAuthProvider({
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
