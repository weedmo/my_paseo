// One page that holds every open viewer as its own tab.
//
// Paseo can open a browser tab but cannot bring an existing one forward, so opening episodes as
// separate Paseo tabs would add a tab per click. Instead the app opens this page once; it shows the
// viewers in tabs of its own, switches to an episode that is already open, and polls this server
// for what to show. Served on localhost, like the viewers, so video decoding keeps working.
import { type Server, createServer } from "node:http";

export interface HubViewer {
  id: string;
  title: string;
  url: string | null;
  state: string;
}

/** A page that stopped polling this long ago is treated as closed. */
const ALIVE_MS = 4000;

export class ViewerHub {
  private server: Server | null = null;
  private port: Promise<number> | null = null;
  private active: string | null = null;
  private lastPoll = 0;
  private readonly list: () => HubViewer[];
  private readonly close: (id: string) => void;

  constructor(list: () => HubViewer[], close: (id: string) => void) {
    this.list = list;
    this.close = close;
  }

  /** Shows `id` in the page; returns the page URL and whether a page is open now. */
  async focus(id: string | null): Promise<{ url: string; alive: boolean }> {
    if (id) this.active = id;
    const port = await this.start();
    return { url: `http://localhost:${port}/`, alive: Date.now() - this.lastPoll < ALIVE_MS };
  }

  alive(): boolean {
    return Date.now() - this.lastPoll < ALIVE_MS;
  }

  stop(): void {
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
    this.port = null;
  }

  private start(): Promise<number> {
    this.port ??= new Promise((done, fail) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/state") {
          this.lastPoll = Date.now();
          const viewers = this.list();
          if (this.active && !viewers.some((v) => v.id === this.active)) this.active = viewers[0]?.id ?? null;
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ viewers, active: this.active }));
          return;
        }
        if (req.method === "POST" && url.pathname === "/activate") {
          this.active = url.searchParams.get("id");
          res.writeHead(204).end();
          return;
        }
        if (req.method === "POST" && url.pathname === "/close") {
          const id = url.searchParams.get("id");
          if (id) this.close(id);
          res.writeHead(204).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(PAGE);
      });
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address !== "object") return fail(new Error("No local port"));
        this.server = server;
        done(address.port);
      });
    });
    this.port.catch(() => {
      this.port = null;
    });
    return this.port;
  }
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>LeRobot viewer</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0d1011; color: #d6d9db; font: 13px system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  #tabs { display: flex; gap: 2px; padding: 4px 6px 0; background: #16191b; border-bottom: 1px solid #2a2f33; overflow-x: auto; flex: none; }
  .tab { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px 6px 0 0; cursor: pointer; white-space: nowrap; color: #9aa1a6; }
  .tab.on { background: #0d1011; color: #f1f3f4; box-shadow: inset 0 -2px #3d8bfd; }
  .tab .x { opacity: .6; padding: 0 2px; }
  .tab .x:hover { opacity: 1; }
  .tab .state { font-size: 11px; color: #e0b050; }
  #frames { position: relative; flex: 1; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: none; background: #0d1011; }
  iframe.on { display: block; }
  #empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #8a9196; }
</style></head>
<body><div id="tabs"></div><div id="frames"><div id="empty">Open an episode from LeRobot datasets in Paseo.</div></div>
<script>
const tabs = document.getElementById("tabs"), frames = document.getElementById("frames"), empty = document.getElementById("empty");
const iframes = new Map();
let active = null;
async function post(path, id) { await fetch(path + "?id=" + encodeURIComponent(id), { method: "POST" }); poll(); }
function render(viewers) {
  tabs.replaceChildren(...viewers.map((v) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (v.id === active ? " on" : "");
    tab.title = v.title;
    tab.onclick = () => post("/activate", v.id);
    const label = document.createElement("span");
    label.textContent = v.title;
    tab.append(label);
    if (v.state !== "ready") { const s = document.createElement("span"); s.className = "state"; s.textContent = v.state; tab.append(s); }
    const x = document.createElement("span");
    x.className = "x"; x.textContent = "\\u2715"; x.title = "Close this viewer";
    x.onclick = (e) => { e.stopPropagation(); post("/close", v.id); };
    tab.append(x);
    return tab;
  }));
  // A viewer's frame is created the first time it is shown and kept, so switching back is instant.
  for (const v of viewers) {
    if (v.id === active && v.url && !iframes.has(v.id)) {
      const f = document.createElement("iframe");
      f.src = v.url; f.allow = "fullscreen; clipboard-read; clipboard-write";
      frames.append(f); iframes.set(v.id, f);
    }
  }
  for (const [id, f] of iframes) {
    if (!viewers.some((v) => v.id === id && v.url)) { f.remove(); iframes.delete(id); continue; }
    f.className = id === active ? "on" : "";
  }
  empty.style.display = iframes.has(active) ? "none" : "flex";
  const current = viewers.find((v) => v.id === active);
  document.title = current ? current.title : "LeRobot viewer";
}
async function poll() {
  try {
    const state = await (await fetch("/state", { cache: "no-store" })).json();
    active = state.active;
    render(state.viewers);
  } catch {}
}
poll(); setInterval(poll, 700);
</script></body></html>`;
