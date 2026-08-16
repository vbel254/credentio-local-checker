const input = document.querySelector("#file-input");
const dropZone = document.querySelector("#drop-zone");
const selection = document.querySelector("#selection");
const preview = document.querySelector("#preview");
const fileName = document.querySelector("#file-name");
const fileSize = document.querySelector("#file-size");
const clearButton = document.querySelector("#clear-button");
const validateButton = document.querySelector("#validate-button");
const resultPanel = document.querySelector("#result-panel");
const resultContent = document.querySelector("#result-content");
let selectedFile = null;
let previewUrl = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toLocaleString("en-US", { maximumFractionDigits: 1 })} ${units[index]}`;
}

function clearPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  preview.replaceChildren();
}

function showFile(file) {
  selectedFile = file;
  input.value = "";
  fileName.textContent = file.name;
  fileSize.textContent = `${formatBytes(file.size)}${file.type ? ` · ${file.type}` : ""}`;
  selection.classList.remove("hidden");
  validateButton.disabled = false;
  clearPreview();
  if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
    previewUrl = URL.createObjectURL(file);
    const media = document.createElement(file.type.startsWith("image/") ? "img" : "video");
    media.src = previewUrl;
    media.muted = true;
    preview.append(media);
  } else {
    preview.textContent = file.name.split(".").pop()?.toUpperCase() || "FILE";
  }
}

function clearFile() {
  selectedFile = null;
  input.value = "";
  selection.classList.add("hidden");
  validateButton.disabled = true;
  clearPreview();
}

function setBusy(busy, label = "Validating locally...") {
  validateButton.disabled = busy || !selectedFile;
  validateButton.textContent = busy ? label : "Validate Content Credentials";
  document.querySelectorAll(".test-card").forEach((button) => (button.disabled = busy));
}

function statusList(items) {
  if (!items?.length) return "";
  return `<ul class="status-list">${items.map((item) => `<li><code>${escapeHtml(item.code)}</code><span>${escapeHtml(item.url || "")}</span></li>`).join("")}</ul>`;
}

function renderResult(payload) {
  const { summary, data, file, durationMs } = payload;
  const noCredentials = summary.verdict === "no_credentials";
  const invalid = summary.verdict === "invalid";
  const tone = noCredentials ? "neutral" : invalid ? "danger" : "success";
  const title = noCredentials
    ? "No Content Credentials found"
    : invalid
      ? "Integrity issue detected"
      : "Content Credentials are valid";
  const description = noCredentials
    ? "This does not mean the file is fake; it only means that no C2PA manifest was found."
    : invalid
      ? "The signature or its associated content failed one or more validation checks."
      : summary.allManifestsTrusted
        ? "Integrity is confirmed, and the certificates are present in the official C2PA Trust List."
        : "Integrity is confirmed, but not every certificate is present in the current C2PA Trust List.";
  const issuers = summary.issuers.length
    ? summary.issuers.map((issuer) => `<span class="chip">${escapeHtml(issuer)}</span>`).join("")
    : '<span class="muted">Not provided</span>';
  const raw = data ? `<details><summary>Show complete crJSON</summary><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></details>` : "";

  resultContent.innerHTML = `
    <div class="result-head ${tone}">
      <div class="verdict-icon">${noCredentials ? "—" : invalid ? "!" : "✓"}</div>
      <div><p class="step">Result</p><h2>${title}</h2><p>${description}</p></div>
    </div>
    <div class="file-line"><strong>${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)} · ${durationMs} ms</span></div>
    ${noCredentials ? "" : `
      <div class="metrics">
        <div><strong>${summary.manifestCount}</strong><span>manifests</span></div>
        <div><strong>${summary.successCount}</strong><span>successful checks</span></div>
        <div><strong>${summary.failureCount}</strong><span>failures</span></div>
        <div><strong>${summary.trustedManifests}/${summary.manifestCount}</strong><span>trusted signatures</span></div>
      </div>
      <div class="detail-block"><h3>Signed by</h3><div class="chips">${issuers}</div></div>
      ${summary.failures.length ? `<div class="detail-block"><h3>Failed checks</h3>${statusList(summary.failures)}</div>` : ""}
    `}
    ${raw}
  `;
  resultPanel.classList.remove("hidden");
  resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderError(message) {
  resultContent.innerHTML = `<div class="result-head danger"><div class="verdict-icon">!</div><div><p class="step">Error</p><h2>The file could not be validated</h2><p>${escapeHtml(message)}</p></div></div>`;
  resultPanel.classList.remove("hidden");
}

async function requestValidation(url, options = {}) {
  setBusy(true);
  resultPanel.classList.add("hidden");
  try {
    const response = await fetch(url, { method: "POST", ...options });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    renderResult(payload);
  } catch (error) {
    renderError(error.message);
  } finally {
    setBusy(false);
  }
}

input.addEventListener("change", () => {
  if (input.files?.[0]) showFile(input.files[0]);
});
clearButton.addEventListener("click", clearFile);
validateButton.addEventListener("click", () => {
  if (!selectedFile) return;
  requestValidation("/api/validate", {
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Filename": encodeURIComponent(selectedFile.name),
    },
    body: selectedFile,
  });
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
}
dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) showFile(file);
});
document.querySelectorAll(".test-card").forEach((button) => {
  button.addEventListener("click", () => requestValidation(`/api/sample/${button.dataset.sample}`));
});
