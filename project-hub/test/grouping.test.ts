import assert from "node:assert/strict";
import { test } from "node:test";
import { groupRepositories, repoKeyOf, type HostProject } from "../client/grouping.ts";

test("repoKeyOf normalizes remote keys and rejects host-local keys", () => {
  assert.equal(repoKeyOf("remote:github.com/Tommoro-AI/Repo.git"), "remote:github.com/tommoro-ai/repo");
  assert.equal(repoKeyOf("host:srv_x:/home/a/b"), null);
  assert.equal(repoKeyOf(null), null);
  assert.equal(repoKeyOf("remote:"), null);
});

const project = (hostId: string, projectId: string, projectKey: string | null, rootPath: string): HostProject => ({
  hostId,
  projectId,
  projectKey,
  rootPath,
  displayName: rootPath.split("/").pop() ?? rootPath,
});

test("groups the same remote across hosts and keeps local directories separate", () => {
  const projects = [
    project("laptop", "p1", "remote:github.com/tommoro-ai/data_foundry_platform", "/home/weed/dfp"),
    project("vn", "p2", "remote:github.com/tommoro-ai/data_foundry_platform", "/srv/dfp"),
    project("vn", "p3", "remote:github.com/tommoro-ai/data_foundry_platform", "/srv/tdp_dev"),
    project("dc", "p4", "host:dc:/home/tommoro/viewer", "/home/tommoro/viewer"),
    project("laptop", "p5", "remote:github.com/weedmo/skills", "/home/weed/skills"),
  ];
  const workspaces = [
    { hostId: "vn", projectId: "p3", workspaceId: "w1" },
    { hostId: "laptop", projectId: "p5", workspaceId: "w2" },
    { hostId: "laptop", projectId: "p5", workspaceId: "w3" },
  ];
  const groups = groupRepositories(projects, workspaces, ["laptop", "vn", "dc"]);

  assert.deepEqual(
    groups.map((group) => group.title),
    ["data_foundry_platform", "skills", "viewer"],
  );
  const dfp = groups[0]!;
  assert.equal(dfp.isRemote, true);
  assert.equal(dfp.owner, "tommoro-ai");
  assert.equal(groups[2]!.owner, null);
  assert.deepEqual(dfp.hosts.map((host) => host.hostId), ["laptop", "vn"]);
  assert.equal(dfp.hosts[1]!.checkouts.length, 2);
  assert.deepEqual(dfp.hosts[1]!.checkouts[1]!.workspaceIds, ["w1"]);
  assert.equal(dfp.workspaceCount, 1);
  assert.equal(groups[2]!.isRemote, false);
});

test("merges renamed repositories through the canonical map", () => {
  const projects = [
    project("laptop", "p1", "remote:github.com/tommoro-ai/habilis-datakit", "/home/weed/habilis-datakit"),
    project("dc", "p2", "remote:github.com/tommoro-ai/habilis-dataset-core", "/home/tommoro/habilis-datakit"),
  ];
  const groups = groupRepositories(projects, [], ["laptop", "dc"], {
    "github.com/tommoro-ai/habilis-datakit": "github.com/tommoro-ai/habilis-dataset-core",
    "github.com/tommoro-ai/habilis-dataset-core": "github.com/tommoro-ai/habilis-dataset-core",
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.title, "habilis-dataset-core");
  assert.deepEqual(groups[0]!.hosts.map((host) => host.hostId), ["laptop", "dc"]);
});

test("a custom project name overrides the repository title", () => {
  const groups = groupRepositories(
    [{ ...project("laptop", "p1", "remote:github.com/weedmo/my_paseo", "/home/weed/my_paseo"), customName: "Paseo lab" }],
    [],
    ["laptop"],
  );
  assert.equal(groups[0]!.title, "Paseo lab");
  assert.equal(groups[0]!.repoName, "my_paseo");
});
