import { spawn } from "node:child_process";

const JSON_MARKER = "Validation Result (crjson):";
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function statusItems(manifest, key) {
  const items = manifest?.validationResults?.[key];
  return Array.isArray(items) ? items : [];
}

function displayName(subject) {
  if (!subject || typeof subject !== "object") return null;
  return subject.O || subject.CN || null;
}

export function summarizeCrJson(data) {
  const manifests = Array.isArray(data?.manifests) ? data.manifests : [];
  const failures = manifests.flatMap((manifest) => statusItems(manifest, "failure"));
  const successes = manifests.flatMap((manifest) => statusItems(manifest, "success"));
  const informationals = manifests.flatMap((manifest) =>
    statusItems(manifest, "informational"),
  );

  const issuers = uniqueStrings(
    manifests.map((manifest) =>
      displayName(manifest?.signature?.certificateInfo?.subject),
    ),
  );
  const generators = uniqueStrings(
    manifests.map((manifest) => manifest?.["claim.v2"]?.claim_generator_info?.name),
  );
  const timestamps = uniqueStrings(
    manifests.map((manifest) => manifest?.signature?.timeStampInfo?.timestamp),
  );
  const trustedManifests = manifests.filter((manifest) =>
    statusItems(manifest, "success").some(
      (item) => item?.code === "signingCredential.trusted",
    ),
  ).length;

  return {
    verdict: failures.length > 0 ? "invalid" : "valid",
    manifestCount: manifests.length,
    successCount: successes.length,
    informationalCount: informationals.length,
    failureCount: failures.length,
    failures,
    issuers,
    generators,
    timestamps,
    trustedManifests,
    allManifestsTrusted:
      manifests.length > 0 && trustedManifests === manifests.length,
  };
}

function cleanError(stderr) {
  const firstPart = stderr.split("=== Source Location Trace")[0].trim();
  return firstPart.replace(/^Validation failed:\s*/i, "") || "Credentio could not process the file";
}

export function parseCredentioResult({ stdout, stderr, exitCode }) {
  if (exitCode !== 0 && /No manifest store found/i.test(stderr)) {
    return {
      kind: "no_credentials",
      summary: {
        verdict: "no_credentials",
        manifestCount: 0,
        successCount: 0,
        informationalCount: 0,
        failureCount: 0,
        failures: [],
        issuers: [],
        generators: [],
        timestamps: [],
        trustedManifests: 0,
        allManifestsTrusted: false,
      },
      data: null,
    };
  }

  const markerIndex = stdout.indexOf(JSON_MARKER);
  if (exitCode !== 0 || markerIndex < 0) {
    const error = new Error(cleanError(stderr));
    error.code = "CREDENTIO_FAILED";
    throw error;
  }

  const jsonText = stdout.slice(markerIndex + JSON_MARKER.length).trim();
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    const error = new Error("Credentio returned an unexpected result format");
    error.code = "INVALID_CREDENTIO_OUTPUT";
    throw error;
  }

  return {
    kind: "credentials",
    summary: summarizeCrJson(data),
    data,
  };
}

export function runCredentio({
  binaryPath,
  assetPath,
  claimTrustPath,
  tsaTrustPath,
  timeoutMs = 120_000,
}) {
  return new Promise((resolve, reject) => {
    const args = [
      `--asset=${assetPath}`,
      `--claim_signer_trust=${claimTrustPath}`,
      `--tsa_trust=${tsaTrustPath}`,
      "--output_format=crjson",
    ];
    const child = spawn(binaryPath, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let finished = false;

    const finish = (callback) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      callback();
    };

    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("The validation output exceeded the safety limit")));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode) =>
      finish(() => {
        try {
          resolve(parseCredentioResult({ stdout, stderr, exitCode }));
        } catch (error) {
          reject(error);
        }
      }),
    );

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Validation exceeded two minutes and was stopped")));
    }, timeoutMs);
  });
}
