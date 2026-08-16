import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCredentio } from "../lib/credentio.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const binaryPath = join(ROOT, ".runtime", "bin", "c2pa_validate");
const claimTrustPath = join(ROOT, ".runtime", "trust", "C2PA-TRUST-LIST.pem");
const tsaTrustPath = join(ROOT, ".runtime", "trust", "C2PA-TSA-TRUST-LIST.pem");

async function runtimeReady() {
  try {
    await Promise.all([access(binaryPath), access(claimTrustPath), access(tsaTrustPath)]);
    return true;
  } catch {
    return false;
  }
}

test("built Credentio distinguishes valid, tampered, plain, and video assets", async (context) => {
  if (!(await runtimeReady())) {
    context.skip("npm run setup has not been run");
    return;
  }

  const validate = (filename) =>
    runCredentio({
      binaryPath,
      assetPath: join(ROOT, ".runtime", "samples", filename),
      claimTrustPath,
      tsaTrustPath,
    });

  const [goodPhoto, badPhoto, plainPhoto, goodVideo] = await Promise.all([
    validate("good.jpg"),
    validate("bad.jpg"),
    validate("plain.jpg"),
    validate("good.mp4"),
  ]);

  assert.equal(goodPhoto.summary.verdict, "valid");
  assert.equal(goodPhoto.summary.allManifestsTrusted, true);
  assert.equal(badPhoto.summary.verdict, "invalid");
  assert.ok(badPhoto.summary.failures.some((item) => item.code === "assertion.dataHash.mismatch"));
  assert.equal(plainPhoto.summary.verdict, "no_credentials");
  assert.equal(goodVideo.summary.verdict, "valid");
});
