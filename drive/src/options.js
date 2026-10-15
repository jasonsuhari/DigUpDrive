import { background, engine, onEngine, element, formatCount } from "./ui/common.js";
import { folderId } from "./engine/links.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["drive", "sharedWithMe", "sharedDrives", "gmail"];

async function showAccount() {
  const { account } = await background("account");
  $("account").textContent = account ? `Signed in as ${account}.` : "Not signed in.";
  $("sign-in").hidden = !!account;
  $("sign-out").hidden = !account;
}

function showStatus({ status, counts, vectors, failed }) {
  const s = status ?? {};
  let text;
  if (s.signedOut) text = "Sign in to start.";
  else if (s.phase === "error") text = `Stopped: ${s.error}`;
  else if (s.phase === "listing") text = `Listing ${s.source === "gmail" ? "Gmail" : "Drive"}… ${formatCount(s.listed ?? 0)} found`;
  else if (s.phase === "indexing") text = `Read ${formatCount(s.done)} of ${formatCount(s.total)}${s.current ? `: ${s.current}` : ""}`;
  else if (counts?.pending) text = `Read ${formatCount(counts.total - counts.pending)} of ${formatCount(counts.total)} files and emails. Paused or waiting for the next check.`;
  else text = `${formatCount(counts?.total ?? s.total ?? 0)} files and emails, ${formatCount(vectors ?? 0)} passages, pages, slides and moments.` +
    (s.lastSync ? ` Checked ${new Date(s.lastSync).toLocaleTimeString()}.` : "");
  $("progress-text").textContent = text;
  $("progress").hidden = s.phase !== "indexing";
  if (s.total) {
    $("progress").max = s.total;
    $("progress").value = s.done;
  }
  if (failed) {
    $("failures-title").hidden = !failed.length;
    $("failures").replaceChildren(...failed.map((item) => element("li", {}, `${item.name}: ${item.detail}`)));
  }
}

async function refresh() {
  const reply = await engine("status");
  for (const field of FIELDS) $(field).checked = reply.settings[field];
  $("gmailQuery").value = reply.settings.gmailQuery;
  $("folders").value = reply.settings.folders.map((id) => `https://drive.google.com/drive/folders/${id}`).join(" ");
  showStatus(reply);
}

$("save").addEventListener("click", async () => {
  const settings = Object.fromEntries(FIELDS.map((field) => [field, $(field).checked]));
  settings.gmailQuery = $("gmailQuery").value.trim();
  settings.folders = $("folders").value.split(/\s+/).filter(Boolean).map(folderId);
  await engine("saveSettings", { settings });
  refresh();
});
$("sign-in").addEventListener("click", async () => {
  const reply = await background("signIn");
  if (reply.error) $("account").textContent = `Sign-in failed: ${reply.error}`;
  showAccount();
});
$("sign-out").addEventListener("click", async () => {
  await background("signOut");
  showAccount();
});
$("sync").addEventListener("click", () => engine("sync"));
$("pause").addEventListener("click", () => engine("pause"));
$("reset").addEventListener("click", async () => {
  if (confirm("Delete the index? DigUp reads everything again next time.")) await engine("reset");
});

onEngine("status", ({ status }) => showStatus({ status }));
onEngine("download", ({ download }) => {
  $("download-text").hidden = !download;
  if (download) $("download-text").textContent = `Downloading the model (once): ${Math.round(download.loaded / 1e6)} of ${Math.round(download.total / 1e6)} MB`;
});

chrome.commands.getAll().then((commands) => {
  const shortcut = commands.find((command) => command.name === "_execute_action")?.shortcut;
  if (shortcut) $("shortcut").textContent = shortcut;
});

showAccount();
refresh();
setInterval(() => engine("status").then(showStatus), 5000);
