import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const test = process.argv.includes("--test");
const live = process.argv.includes("--live");
const dev = test || live;
const out = test ? "dist-test" : live ? "dist-live" : "dist";
const fakeDrive = process.env.DIGUP_FAKE_DRIVE ?? "http://127.0.0.1:8765";

const apis = test
  ? { drive: fakeDrive, docs: fakeDrive, sheets: fakeDrive, slides: fakeDrive, gmail: fakeDrive }
  : {
      drive: "https://www.googleapis.com",
      docs: "https://docs.googleapis.com",
      sheets: "https://sheets.googleapis.com",
      slides: "https://slides.googleapis.com",
      gmail: "https://gmail.googleapis.com",
    };

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "ort"), { recursive: true });

await esbuild.build({
  entryPoints: ["background", "offscreen", "popup", "options", "preview"].map((name) => `src/${name}.js`),
  bundle: true,
  format: "esm",
  target: "chrome135",
  outdir: out,
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  define: {
    __APIS__: JSON.stringify(apis),
    __DEV__: JSON.stringify(dev),
  },
  logLevel: "warning",
});

cpSync("static", out, { recursive: true });
for (const file of readdirSync("node_modules/onnxruntime-web/dist")) {
  if (/^ort-wasm-simd-threaded\.(jsep|asyncify)\.(wasm|mjs)$/.test(file)) {
    cpSync(`node_modules/onnxruntime-web/dist/${file}`, join(out, "ort", file));
  }
}
cpSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", join(out, "pdf.worker.min.mjs"));
for (const folder of ["cmaps", "standard_fonts", "wasm"]) cpSync(`node_modules/pdfjs-dist/${folder}`, join(out, "pdfjs", folder), { recursive: true });

const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));
if (test) manifest.host_permissions.push(`${fakeDrive}/*`);
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`built ${out}/`);
