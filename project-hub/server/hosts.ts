// Opens daemon clients for this host and for the hosts registered on it.
//
// The plugin's own Paseo session exposes no project rename/remove, and cannot reach other hosts,
// so this opens a second client to its daemon and routes through it to the target host. That
// works over whatever path the daemon uses for the host: direct, SSH or relay.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createHostChannelTransport } from "@getpaseo/client/node";

const CLIENT_PREFIX = "project-hub";

function home(): string {
  return process.env.PASEO_HOME || join(homedir(), ".paseo");
}

async function daemonUrl(): Promise<string> {
  const config = JSON.parse(await readFile(join(home(), "config.json"), "utf8")) as { daemon?: { listen?: string } };
  const listen = config.daemon?.listen ?? "127.0.0.1:6767";
  const match = /^(.*):(\d+)$/.exec(listen);
  if (!match) throw new Error(`Project actions need the daemon to listen on host:port, not ${listen}.`);
  const host = ["0.0.0.0", "::", "[::]", ""].includes(match[1]!) ? "127.0.0.1" : match[1];
  return `ws://${host}:${match[2]}/ws`;
}

async function readTrimmed(name: string): Promise<string | undefined> {
  try {
    return (await readFile(join(home(), name), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

export class Hosts {
  private origin: Promise<DaemonClient> | null = null;
  private readonly routes = new Map<string, Promise<DaemonClient>>();
  private ownServerId: Promise<string | undefined> | null = null;

  private connectOrigin(): Promise<DaemonClient> {
    this.origin ??= (async () => {
      if (typeof WebSocket === "undefined") throw new Error("This daemon's runtime has no WebSocket support.");
      const credential = await readTrimmed("local-credential");
      const client = new DaemonClient({
        url: await daemonUrl(),
        clientId: `${CLIENT_PREFIX}-${randomUUID()}`,
        clientType: "cli",
        localCredential: () => credential,
        reconnect: { enabled: true },
      });
      await client.connect();
      return client;
    })();
    this.origin.catch(() => {
      this.origin = null;
    });
    return this.origin;
  }

  /** A client for `serverId`: this daemon itself, or a route through it. */
  async client(serverId: string): Promise<DaemonClient> {
    this.ownServerId ??= readTrimmed("server-id");
    if ((await this.ownServerId) === serverId) return this.connectOrigin();
    let route = this.routes.get(serverId);
    if (!route) {
      route = (async () => {
        const origin = await this.connectOrigin();
        origin.requireConnectedHosts();
        const scopeId = randomUUID();
        const routeId = await origin.openHostRoute(serverId, scopeId);
        const client = new DaemonClient({
          url: "ws://routed-host/ws",
          clientId: scopeId,
          clientType: "cli",
          transportFactory: createHostChannelTransport(origin, serverId, scopeId, routeId),
          reconnect: { enabled: false },
        });
        await client.connect();
        return client;
      })();
      route.catch(() => this.routes.delete(serverId));
      this.routes.set(serverId, route);
    }
    const client = await route;
    if (!client.isConnected) {
      this.routes.delete(serverId);
      return this.client(serverId);
    }
    return client;
  }

  async close(): Promise<void> {
    const routes = [...this.routes.values()];
    this.routes.clear();
    for (const route of routes) await route.then((client) => client.close()).catch(() => undefined);
    const origin = this.origin;
    this.origin = null;
    await origin?.then((client) => client.close()).catch(() => undefined);
  }
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "userMessage" in error && typeof error.userMessage === "string") {
    return error.userMessage;
  }
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Request failed: /, "").replace(/ requestType=.*$/, "");
}
