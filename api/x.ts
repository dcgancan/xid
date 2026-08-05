import { ProfileNotFound, resolveProfile } from "./profile.js";

/**
 * `GET /api/x?u=<handle>` -> `Profile` JSON.
 *
 * Web-standard `Request`/`Response` so the same function runs unmodified on
 * Vercel Edge, Cloudflare Workers, Deno Deploy, and the Vite dev middleware.
 */
export default async function handler(request: Request): Promise<Response> {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
  };

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: cors });
  }

  const handle = new URL(request.url).searchParams.get("u");
  if (!handle) {
    return Response.json({ error: "missing_handle" }, { status: 400, headers: cors });
  }

  try {
    const profile = await resolveProfile(handle);
    return Response.json(profile, {
      headers: {
        ...cors,
        // Long shared cache: an account's name and join date barely move.
        "cache-control": "public, max-age=300, s-maxage=21600, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    if (err instanceof ProfileNotFound) {
      return Response.json({ error: "not_found", handle }, { status: 404, headers: cors });
    }
    console.error("[xid] /api/x failed:", err);
    return Response.json({ error: "upstream_failed" }, { status: 502, headers: cors });
  }
}

export const config = { runtime: "edge" };
