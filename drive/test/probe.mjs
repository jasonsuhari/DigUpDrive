import { serve } from "./fake-drive.mjs";
import { launch, offscreenPage } from "./browser.mjs";
import { mkdtempSync, cpSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

const files = process.argv.slice(2);
const root = mkdtempSync(join(tmpdir(), "digup-probe-"));
for (const file of files) cpSync(file, join(root, basename(file)));
const { server } = await serve(root, 8765);
const { browser, engine } = await launch({ profile: join(tmpdir(), "digup-eval-profile") });
await engine("reset").catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 1500));
const offscreen = await offscreenPage(browser);
globalThis.offscreen = offscreen;
await engine("saveSettings", { settings: { gmail: false } });
const started = Date.now();
for (;;) {
  const { status } = await engine("status");
  if (status.phase === "error") { console.log("error", status.error); break; }
  if (status.phase === "idle" && status.lastSync) break;
  if (Date.now() - started > Number(process.env.PROBE_SECONDS ?? 120) * 1000) { console.log("timed out", JSON.stringify(status)); break; }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
console.log(JSON.stringify((await engine("status")).failed));
await browser.close();
server.close();
