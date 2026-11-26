import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expandHome } from "./datasets";
import { SCRIPT } from "./script";

const NEEDS = "It needs the packages rerun-sdk, pyarrow, av and pillow.";
/** Every host must record and view with the same Rerun version, so the managed environment pins it. */
export const RERUN_VERSION = "0.22.1";
const PACKAGES = [`rerun-sdk==${RERUN_VERSION}`, "pyarrow", "av", "pillow", "numpy"];
/** The environment this plugin creates when no usable Python exists; scripts/install-host.sh uses it too. */
const MANAGED_VENV = join(homedir(), ".local", "share", "paseo-lerobot-rerun", "venv");
export const SETTING_UP = "Setting up the viewer's Python environment on this computer";

function run(python: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((done, fail) => {
    execFile(python, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      // The script reports its own failures as one JSON line on stdout.
      if (stdout.trim()) return done(stdout);
      fail(error ?? new Error(stderr.trim() || "Python printed nothing"));
    });
  });
}

function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
}

async function candidates(): Promise<string[]> {
  // The venv that scripts/install-host.sh creates comes first.
  const list = [join(MANAGED_VENV, "bin", "python"), "python3", "python"];
  for (const base of ["miniconda3", "anaconda3", "miniforge3", "mambaforge", ".conda"]) {
    const envs = join(homedir(), base, "envs");
    try {
      for (const name of await readdir(envs)) list.push(join(envs, name, "bin", "python"));
    } catch {
      // This conda layout is not installed.
    }
  }
  return list;
}

/** Calls `onEvent` for each JSON line the script prints. */
export function readEvents(child: ChildProcess, onEvent: (event: Record<string, unknown>) => void): void {
  if (!child.stdout) return;
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      onEvent(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Not one of the script's events.
    }
  });
}

export class Python {
  private folder: Promise<string> | null = null;
  private setup: Promise<void> | null = null;
  private setupError: string | null = null;
  private found: { setting: string; python: string } | null = null;

  /** A temp folder for this plugin process: the script, exports and downloads. */
  workDir(): Promise<string> {
    this.folder ??= mkdtemp(join(tmpdir(), "paseo-lerobot-rerun-"));
    return this.folder;
  }

  /** The Python script. The plugin process cannot locate its own folder, so the script travels inside the bundle. */
  async scriptPath(): Promise<string> {
    const path = join(await this.workDir(), "lerobot_rerun.py");
    await writeFile(path, SCRIPT, "utf8");
    return path;
  }

  async cleanup(): Promise<void> {
    if (this.folder) await rm(await this.folder, { recursive: true, force: true });
    this.folder = null;
  }

  /** Starts a long-running script command. Its stdin stays open; closing it stops `view`. */
  async spawn(setting: string, args: string[]): Promise<ChildProcess> {
    const python = await this.resolve(setting);
    return spawn(python, [await this.scriptPath(), ...args], { stdio: ["pipe", "pipe", "pipe"] });
  }

  private async works(python: string): Promise<boolean> {
    const script = await this.scriptPath();
    try {
      return lastJson(await run(python, [script, "check"], 30_000)).ok === true;
    } catch {
      return false;
    }
  }

  /** Resolves the interpreter: the configured one, or the first that has the packages. */
  async resolve(setting: string): Promise<string> {
    if (this.found?.setting === setting) return this.found.python;
    const configured = setting.trim();
    if (configured) {
      const python = expandHome(configured);
      if (!(await this.works(python))) throw new Error(`Python at ${configured} cannot run the viewer. ${NEEDS}`);
      this.found = { setting, python };
      return python;
    }
    for (const python of await candidates()) {
      if (await this.works(python)) {
        this.found = { setting, python };
        return python;
      }
    }
    // Nothing usable: create the managed environment once, in the background.
    if (!this.setup) {
      this.setupError = null;
      this.setup = this.createEnvironment().then(
        () => {
          this.setup = null;
        },
        (error: unknown) => {
          this.setup = null;
          this.setupError = error instanceof Error ? error.message : String(error);
        },
      );
    }
    if (this.setupError) {
      throw new Error(`Could not set up Python for the viewer: ${this.setupError}. ${NEEDS} Install them, or set the Python path in the plugin settings.`);
    }
    throw new Error(`${SETTING_UP} (one time, about a minute). It continues by itself.`);
  }

  /** python3 -m venv, then the pinned packages from PyPI. Needs python3 with venv and internet access. */
  private async createEnvironment(): Promise<void> {
    const exec = (file: string, args: string[], timeoutMs: number) =>
      new Promise<void>((done, fail) => {
        execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
          if (error) fail(new Error(stderr.trim().split("\n").pop() || error.message));
          else done();
        });
      });
    console.log("[lerobot-rerun] creating", MANAGED_VENV);
    await exec("python3", ["-m", "venv", MANAGED_VENV], 120_000);
    const python = join(MANAGED_VENV, "bin", "python");
    await exec(python, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], 300_000);
    await exec(python, ["-m", "pip", "install", "--quiet", ...PACKAGES], 900_000);
    console.log("[lerobot-rerun] Python environment ready");
  }

  /** Runs a script command that prints one JSON document. */
  async json(setting: string, args: string[]): Promise<Record<string, unknown>> {
    const python = await this.resolve(setting);
    const result = lastJson(await run(python, [await this.scriptPath(), ...args], 120_000));
    if (result.ok === false) throw new Error(String(result.message));
    return result;
  }
}
