// Viewers for episodes on this host. Each Viewer shows one episode; ViewerPool keeps a few at once
// and stops the least recently opened when it needs room.
//
// An episode is exported to an .rrd file on the host that holds the dataset, copied here when that
// host is another machine, and served by a Rerun web viewer on this host.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open as openFile, rm } from "node:fs/promises";
import { type IncomingHttpHeaders, createServer as createHttpServer, request as httpRequest } from "node:http";
import { type Socket, connect, createServer } from "node:net";
import { join } from "node:path";
import { type ExportStatus, type Quality, READ_CHUNK_BYTES, type Session, exportStatusSchema } from "../shared/rpc";
import type { Exports } from "./exports";
import { type Python, readEvents } from "./python";
import type { Remote } from "./remote";

const POLL_MS = 400;
const EXPORT_TIMEOUT_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 60_000;

export interface OpenRequest {
  /** null for this host. */
  serverId: string | null;
  selfServerId: string;
  hostLabel: string;
  root: string;
  episode: number;
  quality: Quality;
  pythonSetting: string;
  viewerHost: string;
  /** Title of the viewer page, which Paseo shows on its browser tab; null for viewers served to another host. */
  title: string | null;
  /** The address this host reaches the remote host at; null means only copying works. */
  address: string | null;
}

class Cancelled extends Error {}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? done(address.port) : fail(new Error("No free port"))));
    });
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** True when a TCP connection to host:port opens within the timeout. */
function reachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

interface Forward {
  port: number;
  close(): void;
}

/**
 * Relays a local port to host:port. Browsers decode video (WebCodecs) only in secure contexts such
 * as localhost, so a viewer served by another machine is shown through localhost.
 */
function forward(host: string, port: number): Promise<Forward> {
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect({ host, port });
    sockets.add(client).add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", close).on("close", close);
    upstream.on("error", close).on("close", close);
    client.pipe(upstream).pipe(client);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") return fail(new Error("No local port"));
      done({
        port: address.port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/**
 * Serves the web viewer at host:port through a local port, with `title` as the page title. Paseo
 * names browser tabs after the page title, so each tab shows its episode instead of "Rerun Viewer".
 */
function titledViewer(host: string, port: number, title: string): Promise<Forward> {
  const server = createHttpServer((req, res) => {
    const page = req.method === "GET" && /^\/(\?|index\.html|$)/.test(req.url ?? "");
    const headers: IncomingHttpHeaders = { ...req.headers, host: `${host}:${port}` };
    if (page) headers["accept-encoding"] = "identity";
    const upstream = httpRequest({ host, port, method: req.method, path: req.url, headers }, (reply) => {
      if (!page || !String(reply.headers["content-type"] ?? "").includes("text/html")) {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
        return;
      }
      const chunks: Buffer[] = [];
      reply.on("data", (chunk: Buffer) => chunks.push(chunk));
      reply.on("end", () => {
        const html = Buffer.concat(chunks).toString("utf8").replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(title)}</title>`);
        const body = Buffer.from(html, "utf8");
        const out = { ...reply.headers, "content-length": String(body.length) };
        delete out["content-encoding"];
        delete out["transfer-encoding"];
        res.writeHead(reply.statusCode ?? 200, out);
        res.end(body);
      });
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") return fail(new Error("No local port"));
      done({
        port: address.port,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

/** The web viewer's and data server's host:port pairs inside a viewer URL. */
function viewerEndpoints(url: string): { host: string; port: number }[] {
  const page = new URL(url);
  const endpoints = [{ host: page.hostname, port: Number(page.port) }];
  const source = page.searchParams.get("url");
  if (source) {
    const data = new URL(source.replace(/^rerun\+/, ""));
    endpoints.push({ host: data.hostname, port: Number(data.port || (data.protocol === "https:" ? 443 : 80)) });
  }
  return endpoints;
}

export class Viewer {
  private session: Session | null = null;
  private child: ChildProcess | null = null;
  private download: string | null = null;
  /** Stops the viewer that a remote host serves directly for this session. */
  private remoteStop: (() => Promise<void>) | null = null;
  /** Local ports relaying that remote viewer. */
  private forwards: Forward[] = [];
  /** Bumped by every open and stop; a pipeline that sees a newer value gives up. */
  private generation = 0;
  private readonly python: Python;
  private readonly exports: Exports;
  private readonly remote: Remote;

  constructor(python: Python, exports: Exports, remote: Remote) {
    this.python = python;
    this.exports = exports;
    this.remote = remote;
  }

  current(): Session | null {
    return this.session;
  }

  /** Resolves once a viewer on a remote host has been asked to stop as well. */
  stop(): Promise<void> {
    this.generation++;
    this.kill();
    const remoteStopped = this.remoteStop?.() ?? Promise.resolve();
    this.remoteStop = null;
    this.closeForwards();
    // Downloads can be large; an open file is fine to unlink on POSIX.
    if (this.download) void rm(this.download, { force: true });
    this.download = null;
    if (this.session && this.session.state !== "error") this.session = { ...this.session, state: "stopped", url: null };
    return remoteStopped;
  }

  open(request: OpenRequest): Session {
    const serverId = request.serverId ?? request.selfServerId;
    const live = this.session;
    if (
      live &&
      live.serverId === serverId &&
      live.root === request.root &&
      live.episode === request.episode &&
      live.state !== "error" &&
      live.state !== "stopped"
    ) {
      return live;
    }
    this.stop();
    const generation = this.generation;
    this.session = {
      id: randomUUID(),
      title: request.title,
      serverId,
      hostLabel: request.hostLabel,
      root: request.root,
      episode: request.episode,
      quality: request.quality,
      state: "preparing",
      url: null,
      done: 0,
      total: 0,
      message: null,
    };
    void this.run(request, generation).catch((error: unknown) => {
      if (error instanceof Cancelled || generation !== this.generation) return;
      this.kill();
      this.update(generation, { state: "error", url: null, message: error instanceof Error ? error.message : String(error) });
    });
    return this.session;
  }

  private update(generation: number, patch: Partial<Session>): void {
    if (generation !== this.generation) throw new Cancelled();
    this.session = { ...(this.session as Session), ...patch };
  }

  private closeForwards(): void {
    for (const relay of this.forwards) relay.close();
    this.forwards = [];
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.stdin?.end();
      child.kill("SIGTERM");
    }
  }

  /**
   * Shows the episode without copying it when possible: a dataset on this host is served live from
   * here, and one on a remote host is served live by that host, which the app then reaches directly.
   * When the remote host is not reachable that way, the episode is copied here first.
   */
  private async run(request: OpenRequest, generation: number): Promise<void> {
    const remote = request.serverId !== null && request.serverId !== request.selfServerId;
    if (!remote) {
      await this.spawnViewer(request, ["serve", "--root", request.root, "--episode", String(request.episode), "--quality", request.quality], generation);
      await this.applyTitle(request, generation);
      return;
    }
    if (request.address) {
      try {
        await this.serveRemote(request, generation);
        return;
      } catch (error) {
        if (error instanceof Cancelled || generation !== this.generation) throw error;
        void this.remoteStop?.();
        this.remoteStop = null;
        this.closeForwards();
        const reason = error instanceof Error ? error.message : String(error);
        this.update(generation, { message: `Direct view unavailable (${reason}). Copying the episode instead.` });
      }
    }
    const rrd = await this.fetchRemote(request, generation);
    await this.spawnViewer(request, ["view", "--rrd", rrd], generation);
    await this.applyTitle(request, generation);
  }

  /** Asks the remote host to serve the episode itself, then checks this host can reach it. */
  private async serveRemote(request: OpenRequest, generation: number): Promise<void> {
    const serverId = request.serverId as string;
    const call = (method: string, input: unknown) => this.remote.call(serverId, request.hostLabel, method, input);
    const started = (await call("viewer.serve", {
      root: request.root,
      episode: request.episode,
      host: request.address,
      quality: request.quality,
    })) as Session;
    this.remoteStop = () => call("viewer.stop", { id: started.id }).then(() => undefined, () => undefined);
    this.update(generation, { state: "starting", done: 0, total: 0, message: `Starting the viewer on ${request.hostLabel}` });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const { sessions } = (await call("viewer.sessions", {})) as { sessions: Session[] };
      const there = sessions.find((s) => s.id === started.id);
      if (!there) throw new Error(`the viewer on ${request.hostLabel} stopped`);
      if (there.state === "error") throw new Error(there.message ?? "the remote viewer failed");
      if (there.state === "ready" && there.url) {
        const [web, data] = viewerEndpoints(there.url);
        for (const endpoint of [web, data]) {
          if (!(await reachable(endpoint.host, endpoint.port))) throw new Error(`cannot reach ${endpoint.host}:${endpoint.port}`);
        }
        if (generation !== this.generation) throw new Cancelled();
        const webRelay = request.title ? await titledViewer(web.host, web.port, request.title) : await forward(web.host, web.port);
        const dataRelay = await forward(data.host, data.port);
        this.forwards.push(webRelay, dataRelay);
        const source = `ws://localhost:${dataRelay.port}`;
        this.update(generation, {
          state: "ready",
          url: `http://localhost:${webRelay.port}/?url=${encodeURIComponent(source)}`,
          message: `Streaming directly from ${request.hostLabel}`,
          done: there.done,
          total: there.total,
        });
        void this.followRemote(generation, () => call("viewer.sessions", {}) as Promise<{ sessions: Session[] }>, started.id);
        return;
      }
      if (Date.now() > deadline) throw new Error("the remote viewer did not start in time");
      await sleep(POLL_MS);
    }
  }

  private async fetchRemote(request: OpenRequest, generation: number): Promise<string> {
    const serverId = request.serverId as string;
    const call = (method: string, input: unknown) => this.remote.call(serverId, request.hostLabel, method, input);
    const { exportId } = (await call("export.start", { root: request.root, episode: request.episode, quality: request.quality })) as { exportId: string };
    const status = await this.watch(generation, async () => exportStatusSchema.parse(await call("export.status", { exportId })));
    if (status.state === "error") throw new Error(`${request.hostLabel}: ${status.message ?? "the export failed"}`);

    const file = join(await this.python.workDir(), `download-${serverId}-${request.episode}-${Date.now()}.rrd`);
    this.update(generation, { state: "downloading", done: 0, total: status.bytes, message: null });
    const handle = await openFile(file, "w");
    try {
      let offset = 0;
      while (offset < status.bytes) {
        const length = Math.min(READ_CHUNK_BYTES, status.bytes - offset);
        const chunk = await call("export.read", { exportId, offset, length });
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) throw new Error("The host sent no data.");
        await handle.write(chunk, 0, chunk.byteLength, offset);
        offset += chunk.byteLength;
        this.update(generation, { done: offset });
      }
    } catch (error) {
      await handle.close();
      await rm(file, { force: true });
      throw error;
    }
    await handle.close();
    if (generation !== this.generation) {
      await rm(file, { force: true });
      throw new Cancelled();
    }
    this.download = file;
    return file;
  }

  /** Polls an export until it finishes, mirroring its progress into the session. */
  private async watch(generation: number, read: () => Promise<ExportStatus>): Promise<ExportStatus> {
    const deadline = Date.now() + EXPORT_TIMEOUT_MS;
    for (;;) {
      const status = await read();
      this.update(generation, { done: status.done, total: status.total, message: status.message });
      if (status.state !== "running") return status;
      if (Date.now() > deadline) throw new Error("Preparing the episode took too long.");
      await sleep(POLL_MS);
    }
  }

  /** Puts the titled page in front of a viewer that runs on this host. */
  private async applyTitle(request: OpenRequest, generation: number): Promise<void> {
    const url = this.session?.url;
    if (!request.title || !url || generation !== this.generation) return;
    const page = new URL(url);
    const relay = await titledViewer(page.hostname, Number(page.port), request.title);
    if (generation !== this.generation) {
      relay.close();
      throw new Cancelled();
    }
    this.forwards.push(relay);
    page.hostname = "localhost";
    page.port = String(relay.port);
    this.update(generation, { url: page.toString() });
  }

  /** Mirrors the remote viewer's loading progress until its cameras are all in. */
  private async followRemote(generation: number, read: () => Promise<{ sessions: Session[] }>, id: string): Promise<void> {
    while (generation === this.generation) {
      await sleep(1000);
      const there = (await read().catch(() => null))?.sessions.find((s) => s.id === id);
      if (!there || generation !== this.generation) return;
      this.session = { ...(this.session as Session), done: there.done, total: there.total };
      if (there.state !== "ready" || (there.total > 0 && there.done >= there.total)) return;
    }
  }

  /** Starts `view` (an .rrd file) or `serve` (live from the dataset) and waits for its URL. */
  private async spawnViewer(request: OpenRequest, command: string[], generation: number): Promise<void> {
    this.update(generation, { state: "starting", done: 0, total: 0 });
    const [webPort, dataPort] = [await freePort(), await freePort()];
    const child = await this.python.spawn(request.pythonSetting, [
      ...command,
      "--web-port", String(webPort),
      "--data-port", String(dataPort),
      "--host", request.viewerHost || "localhost",
    ]);
    if (generation !== this.generation) {
      child.kill("SIGTERM");
      throw new Cancelled();
    }
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    await new Promise<void>((done, fail) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) fail(error);
        else done();
      };
      const timer = setTimeout(() => settle(new Error("The viewer did not start in time.")), READY_TIMEOUT_MS);
      readEvents(child, (event) => {
        if (event.event === "ready") {
          try {
            this.update(generation, { state: "ready", url: String(event.url), message: null });
            settle();
          } catch (error) {
            settle(error as Error);
          }
        } else if (event.event === "progress" && generation === this.generation) {
          // A live viewer is ready before the cameras and plots are logged.
          this.session = { ...(this.session as Session), done: Number(event.done), total: Number(event.total) };
        } else if (event.event === "loaded" && generation === this.generation) {
          const session = this.session as Session;
          this.session = { ...session, done: session.total };
        } else if (event.event === "warning" && generation === this.generation) {
          this.session = { ...(this.session as Session), message: String(event.message) };
        } else if (event.event === "error") {
          if (settled && this.child === child && generation === this.generation) {
            this.session = { ...(this.session as Session), state: "error", message: String(event.message) };
          }
          settle(new Error(String(event.message)));
        }
      });
      child.once("error", (error) => settle(new Error(`Could not start Python: ${error.message}`)));
      child.once("exit", (code) => {
        const reason = stderr.trim().split("\n").pop() || `The viewer exited with code ${code}.`;
        if (!settled) return settle(new Error(reason));
        // The viewer died after it was ready.
        if (this.child === child && generation === this.generation) {
          this.child = null;
          this.session = { ...(this.session as Session), state: "error", url: null, message: reason };
        }
      });
    });
  }
}

const sessionKey = (serverId: string, root: string, episode: number, quality: Quality) =>
  `${serverId}\n${root}\n${episode}\n${quality}`;

export class ViewerPool {
  private readonly viewers: { viewer: Viewer; openedAt: number }[] = [];
  readonly max: number;
  private readonly make: () => Viewer;

  constructor(make: () => Viewer, max: number) {
    this.make = make;
    this.max = max;
  }

  /** Reuses the viewer of the same episode, else takes an idle one, else replaces the oldest. */
  open(request: OpenRequest): Session {
    const key = sessionKey(request.serverId ?? request.selfServerId, request.root, request.episode, request.quality);
    const live = (s: Session | null) => s !== null && s.state !== "error" && s.state !== "stopped";
    let slot = this.viewers.find(({ viewer }) => {
      const s = viewer.current();
      return live(s) && sessionKey(s!.serverId, s!.root, s!.episode, s!.quality) === key;
    });
    slot ??= this.viewers.find(({ viewer }) => !live(viewer.current()));
    if (!slot && this.viewers.length < this.max) {
      slot = { viewer: this.make(), openedAt: 0 };
      this.viewers.push(slot);
    }
    slot ??= [...this.viewers].sort((a, b) => a.openedAt - b.openedAt)[0];
    slot.openedAt = Date.now();
    return slot.viewer.open(request);
  }

  /** Running and failed viewers, newest first. */
  list(): Session[] {
    return [...this.viewers]
      .sort((a, b) => b.openedAt - a.openedAt)
      .map(({ viewer }) => viewer.current())
      .filter((s): s is Session => s !== null && s.state !== "stopped");
  }

  stop(id?: string): Promise<void> {
    const stopping = this.viewers.filter(({ viewer }) => !id || viewer.current()?.id === id).map(({ viewer }) => viewer.stop());
    return Promise.all(stopping).then(() => undefined);
  }
}
