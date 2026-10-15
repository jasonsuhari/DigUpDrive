import puppeteer from "puppeteer-core";
import { computeExecutablePath, Browser } from "@puppeteer/browsers";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const CACHE = join(homedir(), ".cache", "digup-drive-chrome");
export const EXTENSION_ID = "lncdjplbfcdmflkbeimdpikliedjlkkh";

function chromePath() {
  const builds = readdirSync(join(CACHE, "chrome")).sort();
  const buildId = builds.at(-1).split("-").at(-1);
  return computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir: CACHE });
}

export async function launch({ extension = "dist-test", profile = join(CACHE, "profile"), headless = true } = {}) {
  const path = resolve(extension);
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless,
    userDataDir: profile,
    enableExtensions: [path],
    args: ["--enable-unsafe-webgpu", "--no-first-run", "--no-default-browser-check"],
    protocolTimeout: 30 * 60 * 1000,
  });
  const worker = await browser.waitForTarget(
    (target) => target.type() === "service_worker" && target.url().startsWith(`chrome-extension://${EXTENSION_ID}/`),
    { timeout: 30000 },
  );
  const page = await browser.newPage();
  page.on("console", (message) => process.env.DIGUP_VERBOSE && console.log(`[page] ${message.text()}`));
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  const engine = (op, extra = {}) =>
    page.evaluate(
      (message) => chrome.runtime.sendMessage({ to: "background", op: "engine", message }),
      { op, ...extra },
    );
  return { browser, page, worker, engine };
}

export async function offscreenPage(browser) {
  const target = await browser.waitForTarget((t) => t.url().endsWith("/offscreen.html"), { timeout: 60000 });
  const page = await target.asPage();
  page.on("console", (message) => console.log(`[offscreen ${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.log(`[offscreen error] ${error.message}`));
  return page;
}
