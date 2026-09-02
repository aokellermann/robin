// Tiny API proxy. The org people directory only exists on Robin's GraphQL
// gateway (federation-gateway.robinpowered.com), whose CORS allowlist covers
// Robin's own dashboards only — so the browser can't call it directly. This
// route forwards the caller's own token; no credentials live in the Worker.
const GRAPHQL = "https://federation-gateway.robinpowered.com/graphql";
const USERS_QUERY_HASH = "5a3d5281feda79e8939c7fcfa5d88f77d64618e4417529ab75bcb7a833fd3163";

export default {
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/api/users" || req.method !== "GET") {
            return new Response("Not found", { status: 404 });
        }
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
    },
};
