import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static server for fixtures/badsite.
 *
 * Deliberately dependency-free: this runs in CI, in the eval container, and as
 * the demo fallback when venue wifi is bad, so it should not be able to break
 * for reasons unrelated to the product.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = path.resolve(here, "../../../../fixtures/badsite");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function createFixtureServer(root = FIXTURE_ROOT): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";

    // Contain to root — this serves a fixture, but a path-traversal hole in a
    // tool that also runs against real sites is not worth the convenience.
    const target = path.resolve(root, `.${rel}`);
    if (!target.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    fs.readFile(target, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>404</title><h1>Not found</h1>");
        return;
      }
      res.writeHead(200, {
        "content-type": TYPES[path.extname(target)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    });
  });
}

/** Starts on an ephemeral port unless one is given. Returns the base URL. */
export async function startFixtureServer(
  port = 0,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createFixtureServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const port = Number(process.env.FIXTURE_PORT ?? 4321);
  startFixtureServer(port).then(({ url }) => {
    console.log(`fixture site serving ${FIXTURE_ROOT}`);
    console.log(`  ${url}`);
  });
}
