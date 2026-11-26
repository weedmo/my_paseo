// Reaches this plugin on other hosts through the hosts registered on this daemon.
//
// The plugin's own Paseo session cannot call plugin RPCs on another host, so this module opens a
// second client connection to its daemon and asks it to route to the target host. That works over
// whatever path the daemon uses for the host: direct, SSH or relay.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createHostChannelTransport } from "@getpaseo/client/node";
import { PLUGIN_ID } from "../shared/rpc";

function home(): string {
  return process.env.PASEO_HOME || join(homedir(), ".paseo");
}

async function daemonUrl(): Promise<string> {
  const config = JSON.parse(await readFile(join(home(), "config.json"), "utf8")) as { daemon?: { listen?: string } };
  const listen = config.daemon?.listen ?? "127.0.0.1:6767";
  const match = /^(.*):(\d+)$/.exec(listen);
  if (!match) throw new Error(`Remote hosts need the daemon to listen on host:port, not ${listen}.`);
  const host = ["0.0.0.0", "::", "[::]", ""].includes(match[1]) ? "127.0.0.1" : match[1];
  return `ws://${host}:${match[2]}/ws`;
}

async function localCredential(): Promise<string | undefined> {
  try {
    return (await readFile(join(home(), "local-credential"), "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
}

export class Remote {
  private origin: Promise<DaemonClient> | null = null;
  private readonly routes = new Map<string, Promise<DaemonClient>>();

  private connectOrigin(): Promise<DaemonClient> {
    this.origin ??= (async () => {
      if (typeof WebSocket === "undefined") throw new Error("This daemon's runtime has no WebSocket support.");
      const credential = await localCredential();
      const client = new DaemonClient({
        url: await daemonUrl(),
        clientId: `${PLUGIN_ID}-${randomUUID()}`,
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

  private route(serverId: string): Promise<DaemonClient> {
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
    return route;
  }

  /** Calls this plugin's RPC on another host. */
  async call(serverId: string, label: string, method: string, input: unknown): Promise<unknown> {
    let client: DaemonClient;
    try {
      client = await this.route(serverId);
    } catch (error) {
      throw new Error(`Cannot reach ${label}: ${message(error)}`);
    }
    try {
      return await client.invokePluginRpc(PLUGIN_ID, method, input);
    } catch (error) {
      const text = message(error).replace(/^Request failed: /, "").replace(/ requestType=.*$/, "");
      if (!client.isConnected) this.routes.delete(serverId);
      if (/plugin is not (configured|available|running)|unknown plugin|no handler for/i.test(text)) {
        throw new Error(`The ${PLUGIN_ID} plugin is not installed or not running on ${label}. (${text})`);
      }
      throw new Error(text);
    }
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

function message(error: unknown): string {
  if (error && typeof error === "object" && "userMessage" in error && typeof error.userMessage === "string") {
    return error.userMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
