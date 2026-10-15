import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "./fake-drive.mjs";
import { launch, offscreenPage } from "./browser.mjs";

const evalFile = process.argv[2] ?? "../evals/synthetic.json";
const testbed = process.env.DIGUP_TESTBED ?? "/tmp/digup-testbed";
const keep = process.argv.includes("--keep-index");
const DEPTH = 10;
const KINDS = { screenshot: ["image"], image: ["image"], pdf: ["pdf"], doc: ["doc"], audio: ["audio"], video: ["video"] };

const { server, files, log } = await serve(testbed, 8765);
const pathOf = new Map(files.map((file) => [file.id, file.path]));
const profile = join(tmpdir(), "digup-eval-profile");
const { browser, engine } = await launch({ profile });
const started = Date.now();

try {
  if (!keep) {
    await engine("reset").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (process.env.DIGUP_VERBOSE) offscreenPage(browser);
  await engine("saveSettings", { settings: { gmail: false } });
  let last = "";
  for (;;) {
    const { status, items, vectors } = await engine("status");
    const line = `${status.phase} ${status.done ?? 0}/${status.total ?? 0} ${status.current ?? ""}`;
    if (line !== last) console.log(`  ${Math.round((Date.now() - started) / 1000)}s ${line}`);
    last = line;
    if (status.phase === "error") throw new Error(status.error);
    if (status.phase === "idle" && status.lastSync) {
      console.log(`indexed ${items} items, ${vectors} vectors in ${Math.round((Date.now() - started) / 1000)} s`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const { failed } = await engine("status");
  for (const item of failed) console.log(`failed: ${item.name}: ${item.detail}`);

  const spec = JSON.parse(readFileSync(evalFile, "utf8"));
  const tags = {};
  const rows = [];
  let shown = 0;
  let listed = 0;
  for (const query of spec.queries) {
    const reply = await engine("search", { q: query.q, kinds: query.kind ? KINDS[query.kind] : null });
    if (reply.error) throw new Error(reply.error);
    const hits = reply.hits.slice(0, DEPTH);
    shown += hits.filter((hit) => hit.strong).length;
    listed += hits.length;
    const targets = query.expect.map((entry) => {
      const [path, range] = entry.split("@");
      return { path, range: range?.split("-").map(Number) };
    });
    const place = (hit) => hit.segment?.loc?.page ?? hit.segment?.loc?.t ?? hit.segment?.loc?.chunk ?? null;
    const rank = hits.findIndex((hit) =>
      targets.some((target) => {
        if (pathOf.get(hit.item.ref.fileId) !== target.path) return false;
        if (!target.range) return true;
        const at = place(hit);
        return at !== null && at >= target.range[0] && at <= target.range[1];
      }),
    ) + 1 || null;
    const tag = query.tag ?? "all";
    for (const key of [tag, "ALL"]) {
      const row = (tags[key] ??= { n: 0, at1: 0, at5: 0, at10: 0, mrr: 0 });
      row.n++;
      if (rank) {
        if (rank <= 1) row.at1++;
        if (rank <= 5) row.at5++;
        if (rank <= 10) row.at10++;
        row.mrr += 1 / rank;
      }
    }
    const top = hits[0];
    const topText = top ? `${pathOf.get(top.item.ref.fileId)?.split("/").at(-1)}${top.segment?.label ? ` [${top.segment.label}]` : ""}` : "-";
    rows.push({ q: query.q, tag, rank, top: topText, ms: reply.ms });
    console.log(`${(rank ? `#${rank}` : "miss").padStart(4)}  ${tag.padEnd(12)} ${`"${query.q}"`.padEnd(46)} top: ${topText}  (${reply.ms} ms)`);
  }
  console.log("\ntag            n    R@1    R@5   R@10    MRR");
  for (const [tag, row] of Object.entries(tags).sort(([a], [b]) => (a === "ALL" ? 1 : b === "ALL" ? -1 : a.localeCompare(b)))) {
    const f = (x) => (x / row.n).toFixed(2).padStart(6);
    console.log(`${tag.padEnd(12)} ${String(row.n).padStart(3)} ${f(row.at1)} ${f(row.at5)} ${f(row.at10)} ${f(row.mrr)}`);
  }
  console.log(`weaker-matches fold: ${(shown / spec.queries.length).toFixed(1)} of ${(listed / spec.queries.length).toFixed(1)} shown per query`);
  mkdirSync("test/results", { recursive: true });
  const out = `test/results/${evalFile.split("/").at(-1).replace(".json", "")}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.json`;
  writeFileSync(out, JSON.stringify({ tags, rows, failed, requests: log.length }, null, 2));
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
  server.close();
}
