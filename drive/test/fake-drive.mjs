import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readdirSync, statSync, createReadStream } from "node:fs";
import { join, relative, extname } from "node:path";

const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".heic": "image/heic", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".rtf": "application/rtf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".mp4": "video/mp4", ".ts": "video/mp2t", ".mov": "video/quicktime",
};

const id = (path) => createHash("sha1").update(path).digest("hex").slice(0, 20);

export function scan(root) {
  const files = [];
  const walk = (dir, parent) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const path = relative(root, full);
      const stat = statSync(full);
      const entry = {
        id: id(path), name, parents: parent ? [parent] : ["root"], ownedByMe: true, trashed: false,
        modifiedTime: stat.mtime.toISOString(), version: "1", webViewLink: `https://drive.example/${id(path)}`, path, full,
      };
      if (stat.isDirectory()) {
        files.push({ ...entry, mimeType: "application/vnd.google-apps.folder" });
        walk(full, entry.id);
      } else {
        files.push({ ...entry, mimeType: MIME[extname(name).toLowerCase()] ?? "application/octet-stream", size: String(stat.size) });
      }
    }
  };
  walk(root, null);
  return files;
}

export function serve(root, port) {
  const files = scan(root);
  const byId = new Map(files.map((file) => [file.id, file]));
  const strip = ({ path, full, ...file }) => file;
  const log = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    log.push(`${request.method} ${url.pathname}`);
    const json = (body, status = 200) => {
      response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== "Bearer test-token") return json({ error: { code: 401, message: "bad token" } }, 401);
    const path = url.pathname;
    if (path === "/drive/v3/about") return json({ user: { emailAddress: "test@example.com" } });
    if (path === "/drive/v3/changes/startPageToken") return json({ startPageToken: "1" });
    if (path === "/drive/v3/changes") return json({ changes: [], newStartPageToken: "1" });
    if (path === "/drive/v3/files" && url.searchParams.get("q")?.includes("fullText")) return json({ files: [] });
    if (path === "/drive/v3/files") {
      const size = Number(url.searchParams.get("pageSize") ?? 100);
      const start = Number(url.searchParams.get("pageToken") ?? 0);
      const page = files.slice(start, start + size).map(strip);
      return json({ files: page, ...(start + size < files.length ? { nextPageToken: String(start + size) } : {}) });
    }
    const match = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (match && url.searchParams.get("alt") === "media") {
      const file = byId.get(match[1]);
      if (!file?.full) return json({ error: { code: 404, message: "not found" } }, 404);
      response.writeHead(200, { "content-type": file.mimeType, "access-control-allow-origin": "*" });
      return createReadStream(file.full).pipe(response);
    }
    json({ error: { code: 404, message: `fake drive has no ${path}` } }, 404);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, files, log })));
}
