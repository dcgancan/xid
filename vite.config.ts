import { existsSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/**
 * TLS is opt-in via `bun run dev:tls`, not inferred from a cert lying around --
 * a stray file silently changing the server's protocol is a nasty surprise.
 *
 * Phones need it: gyroscope readings require a secure context and `localhost`
 * is the only insecure origin browsers exempt, so a LAN address must be served
 * over HTTPS. Plain `bun run dev` stays HTTP for desktop and headless tools.
 */
function loadCert() {
  const dir = new URL(".certs/", import.meta.url);
  const key = new URL("key.pem", dir);
  const cert = new URL("cert.pem", dir);
  if (!existsSync(key) || !existsSync(cert)) {
    throw new Error("XID_TLS=1 but no certificate found. Run `bun run cert` first.");
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const https = process.env.XID_TLS === "1" ? loadCert() : undefined;

/**
 * Serves `api/x.ts` during `vite dev` so local development exercises the exact
 * handler that ships to production, instead of a mock.
 */
function apiMiddleware(): Plugin {
  return {
    name: "xid-api",
    configureServer(server) {
      server.middlewares.use("/api/x", async (req, res) => {
        const { default: handler } = await server.ssrLoadModule("/api/x.ts");
        const request = new Request(new URL(req.url ?? "/", "http://localhost"), {
          method: req.method,
        });
        const response: Response = await handler(request);

        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    },
  };
}

export default defineConfig({
  // GitHub Pages serves a project repo under `/<repo>/`; everywhere else the
  // app owns the root.
  base: process.env.BASE_PATH ?? "/",
  plugins: [apiMiddleware()],
  server: {
    host: true,
    https,
    // Tunnels (cloudflared / ngrok) are a fallback route for phone testing;
    // Vite 7 rejects unknown Host headers by default.
    allowedHosts: [".trycloudflare.com", ".ngrok-free.dev", ".ngrok-free.app", ".ts.net"],
  },
  build: { target: "es2022" },
});
