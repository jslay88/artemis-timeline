interface Env {
  UPSTREAM: string;
  ALLOWED_ORIGIN: string;
}

const GCS_ORION = "https://storage.googleapis.com/p-2-cen1/October/1/October_105_1.txt";

const ALLOWED_PATHS = [
  "/api/arow",
  "/api/orbit",
  "/api/state",
  "/api/dsn",
  "/api/solar",
  "/api/all",
  "/api/stats",
  "/api/timeline",
  "/api/history",
  "/api/snapshot",
  "/api/dsn/history",
];

function corsHeaders(origin: string, allowedOrigin: string): Record<string, string> {
  const allowed = allowedOrigin === "*" || origin === allowedOrigin;
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") ?? "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 8000);
      let upstream: string;

      if (path === "/gcs/orion") {
        upstream = GCS_ORION;
      } else if (ALLOWED_PATHS.some((p) => path === p || path.startsWith(p + "?"))) {
        upstream = `${env.UPSTREAM}${path}${url.search}`;
      } else {
        return new Response("Not found", { status: 404, headers: cors });
      }

      const resp = await fetch(upstream, {
        headers: { "User-Agent": "artemis-arow-proxy/1.0" },
        signal: ctrl.signal,
      });
      clearTimeout(timeout);

      const headers = new Headers(resp.headers);
      for (const [k, v] of Object.entries(cors)) headers.set(k, v);
      headers.set("Content-Type", "application/json");

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      });
    } catch {
      return new Response(JSON.stringify({ error: "upstream unavailable" }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  },
};
