import { createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { runCredentio } from "./lib/credentio.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const RUNTIME_DIR = join(ROOT, ".runtime");
const BINARY_PATH = join(RUNTIME_DIR, "bin", "c2pa_validate");
const CLAIM_TRUST_PATH = join(RUNTIME_DIR, "trust", "C2PA-TRUST-LIST.pem");
const TSA_TRUST_PATH = join(RUNTIME_DIR, "trust", "C2PA-TSA-TRUST-LIST.pem");
const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "3210", 10);
const MAX_UPLOAD_BYTES = Number.parseInt(
  process.env.MAX_UPLOAD_BYTES || String(2 * 1024 * 1024 * 1024),
  10,
);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
if (!Number.isSafeInteger(MAX_UPLOAD_BYTES) || MAX_UPLOAD_BYTES < 1) {
  throw new Error("MAX_UPLOAD_BYTES must be a positive safe integer");
}
const SUPPORTED_EXTENSIONS = new Set([
  ".avif", ".dng", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png",
  ".tif", ".tiff", ".webp", ".avi", ".m4a", ".mov", ".mp3", ".mp4",
  ".wav", ".flac", ".pdf", ".docx", ".pptx", ".xlsx",
]);
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const SAMPLE_FILES = new Map([
  ["good-photo", "good.jpg"],
  ["bad-photo", "bad.jpg"],
  ["plain-photo", "plain.jpg"],
  ["good-video", "good.mp4"],
]);
let validationInProgress = false;

function setSecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function friendlyError(error) {
  if (error?.code === "ENOENT") return "Run npm run setup before validating files";
  return error?.message || "The file could not be validated";
}

function formattedUploadLimit() {
  const gibibytes = MAX_UPLOAD_BYTES / 1024 ** 3;
  if (Number.isInteger(gibibytes)) return `${gibibytes} GiB`;
  const mebibytes = MAX_UPLOAD_BYTES / 1024 ** 2;
  return `${Math.round(mebibytes)} MiB`;
}

function hasAllowedOrigin(request) {
  const origin = request.headers.origin;
  return !origin || origin === `http://${HOST}:${PORT}`;
}

function decodeFilename(headerValue) {
  if (typeof headerValue !== "string" || !headerValue) return null;
  try {
    return basename(decodeURIComponent(headerValue));
  } catch {
    return null;
  }
}

async function validatePath(assetPath, filename) {
  const startedAt = performance.now();
  const result = await runCredentio({
    binaryPath: BINARY_PATH,
    assetPath,
    claimTrustPath: CLAIM_TRUST_PATH,
    tsaTrustPath: TSA_TRUST_PATH,
  });
  const assetStat = await stat(assetPath);
  return {
    ...result,
    file: { name: filename, size: assetStat.size },
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function withValidationLock(request, response, operation) {
  if (validationInProgress) {
    request.resume();
    sendJson(response, 429, { error: "Another validation is already in progress" });
    return;
  }
  validationInProgress = true;
  try {
    sendJson(response, 200, await operation());
  } catch (error) {
    sendJson(response, 422, { error: friendlyError(error) });
  } finally {
    validationInProgress = false;
  }
}

async function handleUpload(request, response) {
  const filename = decodeFilename(request.headers["x-filename"]);
  const extension = extname(filename || "").toLowerCase();
  if (!filename || !SUPPORTED_EXTENSIONS.has(extension)) {
    sendJson(response, 415, { error: "Unsupported file type" });
    return;
  }

  const contentLength = Number.parseInt(request.headers["content-length"] || "0", 10);
  if (contentLength > MAX_UPLOAD_BYTES) {
    sendJson(response, 413, { error: `The file exceeds the ${formattedUploadLimit()} local limit` });
    request.resume();
    return;
  }

  await withValidationLock(request, response, async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "credentio-web-"));
    const assetPath = join(tempDirectory, `asset${extension}`);
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES) {
          callback(Object.assign(new Error(`The file exceeds the ${formattedUploadLimit()} local limit`), { code: "TOO_LARGE" }));
        } else {
          callback(null, chunk);
        }
      },
    });

    try {
      await pipeline(request, limiter, createWriteStream(assetPath, { flags: "wx", mode: 0o600 }));
      if (received === 0) throw new Error("The uploaded file is empty");
      return await validatePath(assetPath, filename);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
}

async function handleSample(request, response, sampleName) {
  request.resume();
  const filename = SAMPLE_FILES.get(sampleName);
  if (!filename) {
    sendJson(response, 404, { error: "Sample file not found" });
    return;
  }
  const assetPath = join(RUNTIME_DIR, "samples", filename);
  await withValidationLock(request, response, () => validatePath(assetPath, filename));
}

async function serveStatic(response, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const [filename, contentType] = entry;
  const filePath = normalize(join(PUBLIC_DIR, filename));
  const body = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  setSecurityHeaders(response);
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);

  try {
    if (request.method === "POST" && !hasAllowedOrigin(request)) {
      request.resume();
      sendJson(response, 403, { error: "Cross-origin requests are not allowed" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      await Promise.all([access(BINARY_PATH), access(CLAIM_TRUST_PATH), access(TSA_TRUST_PATH)]);
      sendJson(response, 200, { ready: true, localOnly: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/validate") {
      await handleUpload(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/sample/")) {
      await handleSample(request, response, url.pathname.slice("/api/sample/".length));
      return;
    }
    if (request.method === "GET") {
      await serveStatic(response, url.pathname);
      return;
    }
    sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(response, 500, { error: friendlyError(error) });
  }
});

server.requestTimeout = 130_000;
server.headersTimeout = 10_000;
server.listen(PORT, HOST, () => {
  console.log(`Credentio Local Checker: http://${HOST}:${PORT}`);
  console.log("The server is available only on this computer. Press Ctrl+C to stop it.");
});
