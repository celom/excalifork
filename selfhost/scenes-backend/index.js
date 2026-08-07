/**
 * Scene storage for "Export to link" on a self-hosted Excalidraw.
 *
 * Replaces json.excalidraw.com, which only returns CORS headers to origins on
 * its own allowlist — from any other domain the POST succeeds but the browser
 * refuses to hand the response to JS, surfacing as "Couldn't create shareable
 * link" (see excalidraw-app/data/index.ts).
 *
 * Contract expected by the app:
 *
 *   POST <base>       raw encrypted body  -> { id }
 *   GET  <base>/<id>                      -> the same bytes back
 *
 * The app concatenates the id straight onto VITE_APP_BACKEND_V2_GET_URL
 * (data/index.ts:207), so that variable needs a trailing slash.
 *
 * Scenes are encrypted in the browser and the key is kept in the URL fragment,
 * which is never sent to a server — this process only ever sees opaque bytes.
 *
 * Deliberately dependency-free: node stdlib only, so there is no install step,
 * no lockfile to refresh, and nothing to patch for CVEs.
 */

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { randomBytes } = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || "/data";
// Where the app addresses this service. Requests may also arrive at the root,
// so that a path-routed proxy can strip the prefix before forwarding.
const BASE_PATH = process.env.BASE_PATH || "/api/v2/scenes";
const UPSTREAM_PATH = "/api/v2";
const UPSTREAM_POST_SEGMENT = "post";
const MAX_SCENE_BYTES = Number(process.env.MAX_SCENE_BYTES || 10 * 1024 * 1024);
// Comma-separated and matched exactly, scheme included. Empty allows any
// origin, which is only sensible behind a private network.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// Must satisfy the share-link hash regex in excalidraw-app/App.tsx:238,
// /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/ — base64url is exactly that set.
const generateSceneId = () => randomBytes(16).toString("base64url");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Sharded two levels deep so the directory stays usable at scale. The id is
// validated before it ever reaches here, so it cannot escape DATA_DIR.
const scenePath = (id) => path.join(DATA_DIR, id.slice(0, 2), id);

const send = (res, status, headers, body) => {
  res.writeHead(status, headers);
  res.end(body);
};

const sendJson = (res, status, payload, extraHeaders = {}) =>
  send(
    res,
    status,
    { "Content-Type": "application/json", ...extraHeaders },
    JSON.stringify(payload),
  );

const corsHeaders = (req) => {
  const origin = req.headers.origin;
  // Vary regardless: the response differs per origin even when one is refused,
  // so a shared cache must not reuse an allowed response for a denied origin.
  const headers = { Vary: "Origin" };

  if (!origin) {
    return { headers, allowed: true };
  }
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    return { headers, allowed: true };
  }
  return { headers, allowed: false };
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on("data", (chunk) => {
      if (tooLarge) {
        // Keep draining but discard: memory stays bounded, and the connection
        // still completes normally so the client can read our 413. Destroying
        // the socket here instead would surface as a network error, and the app
        // would show its generic failure rather than the "too big" message.
        return;
      }
      size += chunk.length;
      if (size > MAX_SCENE_BYTES) {
        tooLarge = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(tooLarge ? { tooLarge: true } : { body: Buffer.concat(chunks) }),
    );
    req.on("error", reject);
  });

const createScene = async (req, res, headers) => {
  const { body, tooLarge } = await readBody(req);

  if (tooLarge) {
    // The app matches on error_class, not on the status code
    // (data/index.ts:294), and shows a "too big" message instead of the
    // generic failure.
    sendJson(res, 413, { error_class: "RequestTooLargeError" }, headers);
    return;
  }

  if (body.length === 0) {
    sendJson(res, 400, { message: "Empty scene payload." }, headers);
    return;
  }

  const id = generateSceneId();
  const target = scenePath(id);
  const tmp = `${target}.${process.pid}.tmp`;

  await fsp.mkdir(path.dirname(target), { recursive: true });
  // Write then rename so a crash mid-write can never leave a truncated scene
  // behind a live id.
  await fsp.writeFile(tmp, body, { flag: "wx" });
  await fsp.rename(tmp, target);

  sendJson(res, 200, { id }, headers);
};

const readScene = async (id, res, headers) => {
  const target = scenePath(id);

  try {
    await fsp.access(target);
  } catch {
    sendJson(res, 404, { message: "Scene not found." }, headers);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    // A scene id is never reused and its bytes never change.
    "Cache-Control": "public, max-age=31536000, immutable",
    ...headers,
  });
  fs.createReadStream(target).pipe(res);
};

const server = http.createServer(async (req, res) => {
  const { headers, allowed } = corsHeaders(req);
  const url = new URL(req.url, "http://localhost");
  let route = url.pathname;

  if (route === "/healthz") {
    send(res, 200, { "Content-Type": "text/plain" }, "ok");
    return;
  }

  if (req.method === "OPTIONS") {
    send(res, 204, {
      ...headers,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "3600",
    });
    return;
  }

  // A browser request from an unlisted origin could not read the response
  // anyway; refusing here also keeps unknown origins from filling the volume.
  if (!allowed) {
    sendJson(res, 403, { message: "Origin not allowed." }, headers);
    return;
  }

  // BASE_PATH is checked first: it starts with UPSTREAM_PATH, so the looser
  // prefix would otherwise swallow it.
  if (route.startsWith(BASE_PATH)) {
    route = route.slice(BASE_PATH.length);
  } else if (route.startsWith(UPSTREAM_PATH)) {
    route = route.slice(UPSTREAM_PATH.length);
  }

  let id = route.replace(/^\/+/, "").replace(/\/+$/, "");
  // POST /api/v2/post/ means "create", same as POST to the base path.
  if (req.method === "POST" && id === UPSTREAM_POST_SEGMENT) {
    id = "";
  }

  try {
    if (req.method === "POST" && !id) {
      await createScene(req, res, headers);
      return;
    }
    if (req.method === "GET" && ID_PATTERN.test(id)) {
      await readScene(id, res, headers);
      return;
    }
    sendJson(res, 404, { message: "Not found." }, headers);
  } catch (error) {
    console.error("scenes request failed", error);
    sendJson(res, 500, { message: "Internal error." }, headers);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`scenes backend listening on ${PORT}, data dir ${DATA_DIR}`);
});
