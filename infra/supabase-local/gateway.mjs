#!/usr/bin/env node
// Minimal local API gateway (stand-in for Kong): /auth/v1 → GoTrue, /rest/v1 → PostgREST,
// /templates/* → OTP email templates, CORS for the desktop webview. Loopback only.
import { createServer, request } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTES = [
  ["/auth/v1", { host: "127.0.0.1", port: 54325 }],
  ["/rest/v1", { host: "127.0.0.1", port: 54324 }],
];
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,apikey,content-type,prefer,x-client-info,accept-profile,content-profile,range,x-supabase-api-version",
  "access-control-expose-headers": "content-range,x-supabase-api-version",
  "access-control-max-age": "600",
};

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  const url = req.url ?? "/";
  if (url.startsWith("/templates/")) {
    const name = url.slice("/templates/".length).replace(/[^a-z.]/g, "");
    try {
      res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(join(here, "templates", name)));
    } catch {
      res.writeHead(404).end();
    }
    return;
  }
  if (url.startsWith("/auth-complete")) {
    res.writeHead(200, { "content-type": "text/plain" }).end("You can return to FlightSimApp.");
    return;
  }
  const route = ROUTES.find(([prefix]) => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`));
  if (!route) {
    res.writeHead(404, cors).end();
    return;
  }
  const [prefix, target] = route;
  const headers = { ...req.headers, host: `${target.host}:${target.port}` };
  const upstream = request({ ...target, method: req.method, path: url.slice(prefix.length) || "/", headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, { ...up.headers, ...cors });
    up.pipe(res);
  });
  upstream.on("error", () => res.writeHead(502, cors).end(JSON.stringify({ message: "upstream unavailable" })));
  req.pipe(upstream);
});
server.listen(54321, "127.0.0.1", () => console.log("gateway listening on http://127.0.0.1:54321"));

// GoTrue (in Docker) fetches the email templates from the host. Serve ONLY the static templates on
// the Docker bridge address — never the API — so nothing else is reachable from outside loopback.
const TEMPLATES_HOST = process.env.SB_LOCAL_TEMPLATES_HOST ?? "172.17.0.1";
createServer((req, res) => {
  const name = (req.url ?? "").startsWith("/templates/") ? (req.url ?? "").slice("/templates/".length) : "";
  if (req.method !== "GET" || !["confirmation.html", "recovery.html"].includes(name)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html" }).end(readFileSync(join(here, "templates", name)));
})
  .on("error", (e) => console.log(`templates server not started on ${TEMPLATES_HOST}:54329 (${e.message}); GoTrue will use its default templates`))
  .listen(54329, TEMPLATES_HOST, () => console.log(`email templates served to GoTrue on http://${TEMPLATES_HOST}:54329`));
