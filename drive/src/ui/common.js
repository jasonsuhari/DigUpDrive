export const background = (op, extra = {}) => chrome.runtime.sendMessage({ to: "background", op, ...extra });

export async function engine(op, extra = {}) {
  const reply = await background("engine", { message: { op, ...extra } });
  if (reply?.error) throw new Error(reply.error);
  return reply;
}

export function onEngine(op, callback) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.to === "ui" && message.op === op) callback(message);
  });
}

export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

export const KIND_LABELS = {
  doc: "Doc", sheet: "Sheet", slides: "Slides", pdf: "PDF", image: "Picture", audio: "Audio", video: "Video",
  email: "Email", other: "File",
};

export const formatCount = (n) => new Intl.NumberFormat().format(n);

export function formatDate(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

export function marked(text) {
  return text.split(/(«[^»]*»)/).map((part) =>
    part.startsWith("«") && part.endsWith("»") ? element("mark", {}, part.slice(1, -1)) : part,
  );
}
