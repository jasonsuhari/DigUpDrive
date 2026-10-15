import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launch, offscreenPage } from "./browser.mjs";

const token = readFileSync(process.env.DIGUP_READ_TOKEN_FILE ?? "/tmp/digup-read-token", "utf8").trim();
const fixtures = JSON.parse(readFileSync("test/results/google-fixtures.json", "utf8"));
const gmailQuery = process.env.DIGUP_GMAIL_QUERY ?? "newer_than:30d";

const CASES = [
  { q: "supplier delay with the titanium bolts", file: fixtures.doc, check: (s) => s.label?.endsWith("Risks") && !!s.loc.heading },
  { q: "backup vendor in Japan", file: fixtures.doc, check: (s) => s.label?.endsWith("Mitigation") && !!s.loc.heading },
  { q: "a bird standing in the reservoir", file: fixtures.doc, check: (s) => s.loc.tab === fixtures.secondTab },
  { q: "lab centrifuge purchase", file: fixtures.sheet, check: (s) => s.loc.gid === fixtures.gids.Equipment && covers(s.loc.range, 120) },
  { q: "hotel costs in Lisbon", file: fixtures.sheet, check: (s) => s.loc.gid === fixtures.gids.Travel },
  { q: "revenue grew in Europe", file: fixtures.deck, check: (s) => s.loc.slide === "digup_s1" },
  { q: "thank the Helsinki team", file: fixtures.deck, check: (s) => s.loc.slide === "digup_s4" },
  { q: "cats sleeping on a couch", file: fixtures.deck, check: (s) => s.loc.slide === "digup_s3" },
  { q: "titanium bolts supplier risk", file: fixtures.uploads.docx, check: (s) => s.label === "Risks" },
  { q: "refrigerated centrifuge", file: fixtures.uploads.xlsx, check: (s) => s.loc.tab === "Equipment" && covers(s.loc.range, 120) },
  { q: "thank the Helsinki team", file: fixtures.uploads.pptx, check: (s) => s.loc.slide === 4 },
  { q: "K7Q2LM", file: fixtures.uploads.png, check: () => true },
];

function covers(range, row) {
  const [, first, last] = /^[A-Z]+(\d+):[A-Z]+(\d+)$/.exec(range ?? "") ?? [];
  return Number(first) <= row && row <= Number(last);
}

async function runCases() {
    for (const test of CASES) {
      const { hits, ms, error } = await engine("search", { q: test.q });
      if (error) throw new Error(error);
      const rank = hits.findIndex((hit) => hit.item.ref?.fileId === test.file) + 1 || null;
      const hit = rank && hits[rank - 1];
      const placed = hit ? test.check(hit.segment ?? { loc: {} }) : false;
      const verdict = rank === 1 && placed ? "pass" : rank && placed ? `pass at #${rank}` : "FAIL";
      console.log(`${verdict.padEnd(10)} "${test.q}" → ${hit ? `${hit.item.name} [${hit.segment?.label ?? ""}] ${JSON.stringify(hit.segment?.loc)}` : `top: ${hits[0]?.item.name}`} (${ms} ms)\n           ${hit?.open ?? ""}`);
      report.cases.push({ q: test.q, rank, placed, verdict, open: hit?.open, loc: hit?.segment?.loc, label: hit?.segment?.label });
    }

}

async function gmail(path) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return response.json();
}

async function gmailCases() {
  const checks = [];
  const [newest] = (await gmail("messages?maxResults=1&q=-in:chats")).messages ?? [];
  if (newest) {
    const message = await gmail(`messages/${newest.id}?format=metadata&metadataHeaders=Subject`);
    const subject = message.payload.headers.find((h) => h.name === "Subject")?.value ?? "";
    checks.push({ q: subject, id: `gmail:${newest.id}`, thread: message.threadId });
  }
  const [withFile] = (await gmail("messages?maxResults=1&q=has:attachment newer_than:3d")).messages ?? [];
  if (withFile) {
    const message = await gmail(`messages/${withFile.id}?format=full`);
    const find = (part) => (part.filename && part.body?.attachmentId ? part : (part.parts ?? []).map(find).find(Boolean));
    const attachment = find(message.payload);
    if (attachment) checks.push({ q: attachment.filename, id: `gmail:${withFile.id}:${attachment.partId}`, thread: message.threadId });
  }
  for (const check of checks) {
    const { hits } = await engine("search", { q: check.q });
    const rank = hits.findIndex((hit) => hit.item.id === check.id) + 1 || null;
    const hit = rank && hits[rank - 1];
    const linked = !!hit?.open?.endsWith(`#all/${check.thread}`) || !!hit?.open?.includes("preview.html");
    const indexed = (await engine("item", { id: check.id })).item?.state ?? "not listed";
    const verdict = rank === 1 && linked ? "pass" : rank && linked ? `pass at #${rank}` : indexed !== "done" ? `not indexed yet (${indexed})` : "FAIL";
    console.log(`${verdict.padEnd(10)} gmail "${check.q.slice(0, 60)}" → ${hit ? `${hit.item.name}` : `top: ${hits[0]?.item.name}`}\n           ${hit?.open ?? ""}`);
    report.cases.push({ q: check.q, rank, verdict, open: hit?.open, gmail: true });
  }
}

const { browser, engine } = await launch({ extension: "dist-live", profile: join(tmpdir(), "digup-live-profile"), token });
const report = { cases: [], gmail: null };
try {
  await engine("reset").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (process.env.DIGUP_VERBOSE) offscreenPage(browser);
  await engine("saveSettings", { settings: { folders: [fixtures.folder], gmail: true, gmailQuery } });
  const started = Date.now();
  const gmailMinutes = Number(process.env.DIGUP_GMAIL_MINUTES ?? 10);
  let last = "";
  let checkedDrive = false;
  for (;;) {
    const { status, items, vectors, pending } = await engine("status");
    const line = `${status.phase} ${status.source ?? ""} ${status.listed ?? ""} ${status.done ?? 0}/${status.total ?? 0} ${status.current ?? ""}`;
    if (line !== last) console.log(`  ${Math.round((Date.now() - started) / 1000)}s ${line}`);
    last = line;
    if (status.phase === "error") throw new Error(status.error);
    const idle = status.phase === "idle" && status.lastSync;
    if (!checkedDrive && status.phase === "indexing" && pending.drive === 0) {
      checkedDrive = true;
      console.log(`Drive done at ${Math.round((Date.now() - started) / 1000)} s`);
      await runCases();
    }
    if (idle || Date.now() - started > gmailMinutes * 60000) {
      console.log(`${idle ? "idle" : "stopped waiting"}: ${items} items, ${vectors} vectors in ${Math.round((Date.now() - started) / 1000)} s`);
      if (!checkedDrive) await runCases();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await gmailCases();
  const { failed } = await engine("status");
  for (const item of failed) console.log(`failed: ${item.kind} ${item.name}: ${item.detail}`);
  report.failed = failed;

  const { status } = await engine("status");
  report.gmail = { items: status.total };
  mkdirSync("test/results", { recursive: true });
  writeFileSync("test/results/live.json", JSON.stringify(report, null, 2));
  if (process.env.DIGUP_HOLD) await new Promise((resolve) => setTimeout(resolve, Number(process.env.DIGUP_HOLD) * 1000));
} finally {
  if (!process.env.DIGUP_KEEP_OPEN) await browser.close();
}
