import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME = join(ROOT, ".runtime");
const SOURCE = join(RUNTIME, "source", "credentio");
const LIBCPPBOR_SOURCE = join(RUNTIME, "source", "libcppbor");
const BIN_DIR = join(RUNTIME, "bin");
const TRUST_DIR = join(RUNTIME, "trust");
const SAMPLES_DIR = join(RUNTIME, "samples");
const BAZELISK = join(ROOT, "node_modules", ".bin", "bazelisk");
const CREDENTIO_URL = "https://mediaprovenance.googlesource.com/credentio";
const CREDENTIO_COMMIT = "4ac69fc58256d3871e765f615254373e19e250e9";
const TRUST_COMMIT = "99927caef670ca4ad9da5e5542dca39e42fad6f3";
const SAMPLE_COMMIT = "ae61d4c5cee15cf641cd9455916c75db81753567";
const C2PA_RS_COMMIT = "eb877f68f3876ed5334263ccdd3c51982aa025f8";
const LIBCPPBOR_COMMIT = "ef9626806649d45cd1b5dd692695eae82aff5542";
const BORINGSSL_INTEGRITY = "sha256-NWD33T8I4WufhNh3pb4h7GIHFWR4MAlXGvX8xvrXNNI=";
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 60_000;

const DOWNLOADS = [
  {
    destination: join(TRUST_DIR, "C2PA-TRUST-LIST.pem"),
    url: `https://raw.githubusercontent.com/c2pa-org/conformance-public/${TRUST_COMMIT}/trust-list/C2PA-TRUST-LIST.pem`,
    sha256: "75cacc98b79ecac33713c7ecfb58d4a0ef383f3c1f886e7409f9e37e8664aea5",
  },
  {
    destination: join(TRUST_DIR, "C2PA-TSA-TRUST-LIST.pem"),
    url: `https://raw.githubusercontent.com/c2pa-org/conformance-public/${TRUST_COMMIT}/trust-list/C2PA-TSA-TRUST-LIST.pem`,
    sha256: "c688d3555f4a2f1f8d663472bbd37888ff234abdd234c25934c0f9292e4eb5c9",
  },
  {
    destination: join(SAMPLES_DIR, "good.jpg"),
    url: `https://raw.githubusercontent.com/c2pa-org/public-testfiles/${SAMPLE_COMMIT}/2.2/image/good/jpeg/a.jpg`,
    sha256: "1994444eeec5d30a90e52f793f2764aa51e164a10334c60b991444369ccd30c6",
  },
  {
    destination: join(SAMPLES_DIR, "bad.jpg"),
    url: `https://raw.githubusercontent.com/c2pa-org/public-testfiles/${SAMPLE_COMMIT}/2.2/image/bad/jpeg/a-bad-01.jpg`,
    sha256: "0d8fb5d3510f5362ab5c68c1ab80adc51f4801d82a6c0f65171eb0c9238ab5e3",
  },
  {
    destination: join(SAMPLES_DIR, "good.mp4"),
    url: `https://raw.githubusercontent.com/c2pa-org/public-testfiles/${SAMPLE_COMMIT}/2.2/video/good/mp4/a.mp4`,
    sha256: "f17a742ed81c2c131df608c3b1724f1442df4b09a8c4bbc71e51014f05638778",
  },
  {
    destination: join(SAMPLES_DIR, "plain.jpg"),
    url: `https://raw.githubusercontent.com/contentauth/c2pa-rs/${C2PA_RS_COMMIT}/cli/sample/image.jpg`,
    sha256: "f999fd78bfe8a83c96e468a078830ba94485bc1bc6fd086fb94a43bd29dd0f23",
  },
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchDownload(url) {
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      const retryable = error.retryable !== false;
      if (!retryable || attempt === DOWNLOAD_ATTEMPTS) break;
      console.warn(`Download attempt ${attempt} failed; retrying...`);
      await wait(attempt * 750);
    }
  }
  throw new Error(`Could not download ${url}: ${lastError?.message || "unknown network error"}`);
}

async function download({ destination, url, sha256 }) {
  if (await exists(destination)) {
    const current = createHash("sha256").update(await readFile(destination)).digest("hex");
    if (current === sha256) return;
  }
  console.log(`Downloading ${destination.slice(ROOT.length + 1)}...`);
  const bytes = await fetchDownload(url);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) throw new Error(`SHA-256 checksum mismatch for ${url}`);
  await writeFile(destination, bytes, { mode: 0o600 });
}

function hardenModule(moduleText) {
  const floatingLibCppBor = `http_archive = use_repo_rule("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

http_archive(
    name = "libcppbor",
    build_file = "@//:external/libcppbor.BUILD",
    urls = ["https://android.googlesource.com/platform/system/libcppbor/+archive/refs/heads/main.tar.gz"],
)`;
  const pinnedLibCppBor = `local_repository = use_repo_rule("@bazel_tools//tools/build_defs/repo:local.bzl", "local_repository")

local_repository(
    name = "libcppbor",
    path = ${JSON.stringify(LIBCPPBOR_SOURCE)},
)`;
  const boringsslMarker = '    module_name = "boringssl",\n    patch_strip = 1,';
  const pinnedBoringssl = `    module_name = "boringssl",\n    integrity = "${BORINGSSL_INTEGRITY}",\n    patch_strip = 1,`;
  const withLibCppBor = moduleText.replace(floatingLibCppBor, pinnedLibCppBor);
  const hardened = withLibCppBor.replace(boringsslMarker, pinnedBoringssl);
  if (hardened === moduleText || !hardened.includes(LIBCPPBOR_SOURCE) || !hardened.includes(BORINGSSL_INTEGRITY)) {
    throw new Error("Could not pin Credentio dependency integrity data");
  }
  return hardened;
}

async function main() {
  if (!(await exists(BAZELISK))) {
    throw new Error("Run npm install first");
  }
  await run("xcode-select", ["-p"], { capture: true });
  await run("git", ["--version"], { capture: true });
  await Promise.all([
    mkdir(BIN_DIR, { recursive: true }),
    mkdir(TRUST_DIR, { recursive: true }),
    mkdir(SAMPLES_DIR, { recursive: true }),
    mkdir(dirname(SOURCE), { recursive: true }),
  ]);

  const sourceIsNew = !(await exists(join(SOURCE, ".git")));
  if (sourceIsNew) {
    console.log("Downloading the Credentio source from Google...");
    await run("git", ["clone", "--no-checkout", CREDENTIO_URL, SOURCE]);
    await run("git", ["fetch", "origin", CREDENTIO_COMMIT, "--depth=1"], { cwd: SOURCE });
    await run("git", ["checkout", "--detach", CREDENTIO_COMMIT], { cwd: SOURCE });
  }

  const libCppBorIsNew = !(await exists(join(LIBCPPBOR_SOURCE, ".git")));
  if (libCppBorIsNew) {
    console.log("Downloading the pinned LibCppBor revision...");
    await run("git", ["clone", "--no-checkout", "https://android.googlesource.com/platform/system/libcppbor", LIBCPPBOR_SOURCE]);
    await run("git", ["fetch", "origin", LIBCPPBOR_COMMIT, "--depth=1"], { cwd: LIBCPPBOR_SOURCE });
    await run("git", ["checkout", "--detach", LIBCPPBOR_COMMIT], { cwd: LIBCPPBOR_SOURCE });
  } else {
    const libHead = await run("git", ["rev-parse", "HEAD"], { cwd: LIBCPPBOR_SOURCE, capture: true });
    const libDirty = await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: LIBCPPBOR_SOURCE, capture: true });
    if (libHead !== LIBCPPBOR_COMMIT || libDirty) {
      throw new Error("The cached LibCppBor source differs from the pinned revision");
    }
  }
  await copyFile(join(SOURCE, "external", "libcppbor.BUILD"), join(LIBCPPBOR_SOURCE, "BUILD.bazel"));
  await writeFile(join(LIBCPPBOR_SOURCE, "WORKSPACE.bazel"), "");
  if (!sourceIsNew) {
    const head = await run("git", ["rev-parse", "HEAD"], { cwd: SOURCE, capture: true });
    if (head !== CREDENTIO_COMMIT) {
      throw new Error("The cached Credentio source is on a different revision; remove .runtime and run setup again");
    }
  }

  const upstreamModule = await run("git", ["show", `${CREDENTIO_COMMIT}:MODULE.bazel`], { cwd: SOURCE, capture: true });
  const hardenedModule = hardenModule(`${upstreamModule}\n`);
  const dirtyFiles = (await run("git", ["diff", "--name-only"], { cwd: SOURCE, capture: true })).split("\n").filter(Boolean);
  if (dirtyFiles.some((filename) => filename !== "MODULE.bazel")) {
    throw new Error("The cached Credentio source has unexpected local changes; setup stopped");
  }
  if (dirtyFiles.includes("MODULE.bazel")) {
    const currentModule = await readFile(join(SOURCE, "MODULE.bazel"), "utf8");
    if (currentModule !== hardenedModule) {
      throw new Error("MODULE.bazel in the cached Credentio source was modified unexpectedly");
    }
  } else {
    await writeFile(join(SOURCE, "MODULE.bazel"), hardenedModule);
  }

  await Promise.all(DOWNLOADS.map(download));
  console.log("Building Credentio (the first build may take several minutes)...");
  await run(BAZELISK, ["build", "//tools:c2pa_validate", "--noshow_progress"], { cwd: SOURCE });
  const outputBinary = join(BIN_DIR, "c2pa_validate");
  await copyFile(join(SOURCE, "bazel-bin", "tools", "c2pa_validate"), outputBinary);
  await chmod(outputBinary, 0o755);
  await writeFile(
    join(RUNTIME, "versions.json"),
    `${JSON.stringify({ credentioCommit: CREDENTIO_COMMIT, libcppborCommit: LIBCPPBOR_COMMIT, trustListCommit: TRUST_COMMIT, sampleCommit: SAMPLE_COMMIT }, null, 2)}\n`,
  );
  console.log("\nSetup complete. Start the app with: npm start");
}

main().catch((error) => {
  console.error(`\nSetup failed: ${error.message}`);
  process.exitCode = 1;
});
