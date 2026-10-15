/* global __DEV__ */
const SYNC_MINUTES = 15;
const TOKEN_MARGIN_MS = 60 * 1000;

let engineReady = null;
let markReady;

function ensureEngine() {
  engineReady ??= (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts.length) return;
    const ready = new Promise((resolve) => (markReady = resolve));
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Runs the search model and keeps the index of your Drive and Gmail",
    });
    await ready;
  })();
  return engineReady;
}

async function engine(message) {
  await ensureEngine();
  return chrome.runtime.sendMessage({ ...message, to: "offscreen" });
}

function authURL({ interactive, account }) {
  const { client_id, scopes } = chrome.runtime.getManifest().oauth2;
  const params = new URLSearchParams({
    client_id,
    response_type: "token",
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: scopes.join(" "),
    include_granted_scopes: "true",
    prompt: interactive ? "consent select_account" : "none",
  });
  if (account) params.set("login_hint", account);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function signIn(interactive) {
  const { auth } = await chrome.storage.local.get("auth");
  const redirect = await chrome.identity.launchWebAuthFlow({ url: authURL({ interactive, account: auth?.account }), interactive });
  const params = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (params.get("error")) throw new Error(params.get("error"));
  const token = {
    value: params.get("access_token"),
    expires: Date.now() + Number(params.get("expires_in")) * 1000,
    scopes: (params.get("scope") ?? "").split(" "),
  };
  await chrome.storage.session.set({ token });
  if (!auth?.account) {
    const response = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
      headers: { Authorization: `Bearer ${token.value}` },
    });
    const account = response.ok ? (await response.json()).user.emailAddress : null;
    await chrome.storage.local.set({ auth: { account } });
  }
  return token;
}

async function devToken() {
  if (!__DEV__) return null;
  const { devToken } = await chrome.storage.local.get("devToken");
  return devToken ?? null;
}

async function token({ force = false } = {}) {
  const injected = await devToken();
  if (injected) return { token: injected };
  const { token: cached } = await chrome.storage.session.get("token");
  if (!force && cached && cached.expires - TOKEN_MARGIN_MS > Date.now()) return { token: cached.value, scopes: cached.scopes };
  const { auth } = await chrome.storage.local.get("auth");
  if (!auth) return { error: "signed out" };
  try {
    const fresh = await signIn(false);
    return { token: fresh.value, scopes: fresh.scopes };
  } catch (error) {
    return { error: `signed out (${error.message})` };
  }
}

const handlers = {
  token: (message) => token(message),
  async signIn() {
    const fresh = await signIn(true);
    engine({ op: "sync" });
    return { signedIn: true, scopes: fresh.scopes };
  },
  async signOut() {
    const { token: cached } = await chrome.storage.session.get("token");
    if (cached) fetch(`https://oauth2.googleapis.com/revoke?token=${cached.value}`, { method: "POST" }).catch(() => {});
    await chrome.storage.session.remove("token");
    await chrome.storage.local.remove("auth");
    return { signedOut: true };
  },
  async account() {
    const { auth } = await chrome.storage.local.get("auth");
    return { account: auth?.account ?? null };
  },
  engine: ({ message }) => engine(message),
};

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.to === "ui" && message.op === "ready") markReady?.();
  if (message.to !== "background") return false;
  const handler = handlers[message.op];
  if (!handler) return false;
  Promise.resolve(handler(message)).then(reply, (error) => reply({ error: error.message }));
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.alarms.create("sync", { periodInMinutes: SYNC_MINUTES });
  if (reason === "install" && !__DEV__) chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => engine({ op: "sync" }));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "sync") return;
  if ((await token()).token) engine({ op: "sync" });
});

const escapeXML = (text) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const { hits = [] } = await engine({ op: "search", q: text });
  suggest(
    hits.slice(0, 6).filter((hit) => hit.open).map((hit) => ({
      content: hit.open,
      description: `${escapeXML(hit.item.name)}${hit.segment?.label ? ` <dim>· ${escapeXML(hit.segment.label)}</dim>` : ""}`,
    })),
  );
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  let url = /^(https:|chrome-extension:)/.test(text) ? text : null;
  if (!url) url = (await engine({ op: "search", q: text })).hits?.[0]?.open;
  url ??= chrome.runtime.getURL(`popup.html?q=${encodeURIComponent(text)}`);
  if (disposition === "currentTab") chrome.tabs.update({ url });
  else chrome.tabs.create({ url, active: disposition === "newForegroundTab" });
});
