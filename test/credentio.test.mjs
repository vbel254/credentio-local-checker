import assert from "node:assert/strict";
import test from "node:test";
import { parseCredentioResult, summarizeCrJson } from "../lib/credentio.mjs";

const manifest = (failure = [], success = []) => ({
  label: "urn:c2pa:test",
  "claim.v2": { claim_generator_info: { name: "Test generator" } },
  signature: {
    certificateInfo: { subject: { O: "Test signer" } },
    timeStampInfo: { timestamp: "2026-01-01T00:00:00Z" },
  },
  validationResults: { failure, informational: [], success },
});

test("summary treats an integrity failure as invalid", () => {
  const summary = summarizeCrJson({
    manifests: [manifest([{ code: "assertion.dataHash.mismatch" }])],
  });
  assert.equal(summary.verdict, "invalid");
  assert.equal(summary.failureCount, 1);
  assert.deepEqual(summary.issuers, ["Test signer"]);
});

test("summary requires every manifest to be trusted", () => {
  const trusted = { code: "signingCredential.trusted" };
  const summary = summarizeCrJson({ manifests: [manifest([], [trusted]), manifest([], [trusted])] });
  assert.equal(summary.verdict, "valid");
  assert.equal(summary.allManifestsTrusted, true);
  assert.equal(summary.trustedManifests, 2);
});

test("missing manifest is a neutral result, not a server error", () => {
  const result = parseCredentioResult({
    stdout: "",
    stderr: "Validation failed: NOT_FOUND: No manifest store found",
    exitCode: 1,
  });
  assert.equal(result.kind, "no_credentials");
  assert.equal(result.summary.verdict, "no_credentials");
});

test("Credentio crJSON is parsed after its human-readable prefix", () => {
  const payload = { manifests: [manifest([], [{ code: "claimSignature.validated" }])] };
  const result = parseCredentioResult({
    stdout: `Validation successful!\nValidation Result (crjson):\n${JSON.stringify(payload)}`,
    stderr: "",
    exitCode: 0,
  });
  assert.equal(result.kind, "credentials");
  assert.equal(result.summary.verdict, "valid");
});
