#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteDirectory = join(repositoryRoot, "dist", "dashboard-site");
const configuredPort = process.env.FORGE_DASHBOARD_PORT ?? "4173";
if (!/^[0-9]{1,5}$/u.test(configuredPort)) {
  throw new Error("FORGE_DASHBOARD_PORT must be an integer from 1 to 65535");
}
const port = Number(configuredPort);
if (port < 1 || port > 65_535) {
  throw new Error("FORGE_DASHBOARD_PORT must be an integer from 1 to 65535");
}

const files = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { name: "styles.css", type: "text/css; charset=utf-8" }],
]);
const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", ...securityHeaders });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const selected = files.get(url.pathname);
    if (selected === undefined) {
      response.writeHead(404, securityHeaders);
      response.end("Not found\n");
      return;
    }
    const path = join(siteDirectory, selected.name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("dashboard output is not a regular file");
    }
    response.writeHead(200, {
      ...securityHeaders,
      "Cache-Control": "no-store",
      "Content-Length": metadata.size,
      "Content-Type": selected.type,
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(path).pipe(response);
  } catch {
    if (!response.headersSent) response.writeHead(500, securityHeaders);
    response.end("Dashboard output is unavailable; run npm run build:dashboard.\n");
  }
});

server.on("error", (error) => {
  process.stderr.write(`Forge dashboard server failed: ${error.message}\n`);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Forge dashboard: http://127.0.0.1:${port}/\n`);
});
