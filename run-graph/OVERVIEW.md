Run Graph draws the runs of the weed-harness purpose loops in one workspace panel, as git-graph style lanes. It shows the matt-design spec a build started from, the matt-auto or autocode build run, that run's qa-gate, review-gate and pr-visual results, and the Claude workflow runs and subagents that the build's workers started. A run started by another run hangs under the node that started it, as a collapsible sub-graph.

Open it with **Open Run Graph** in the Command Center. It opens in the right sidebar next to Files and Changes; **Open Run Graph in a tab** opens it as a workspace tab instead. The panel covers the repository of the current workspace, including every linked worktree. Filter by source (matt, workflow, autocode), show live runs only, or limit to the last 1, 7, 30 or 90 days. Select a node to see its facts, notes, prompt and result, and its parent and child runs. A badge under each workspace in the sidebar counts that repository's live runs.

Runs are linked by explicit ids, by the worker's worktree path, or by time window. A time-window link is a guess: it is drawn dashed and labelled "inferred".

The plugin only reads files. It reads `~/.claude/projects` and these files in each checkout of the repository:

- `docs/design`
- `docs/agents/matt-auto-log`
- `.autocode`
- `.qa`
- `.review`
- `.pr-visual`

It never writes those files, and never starts, stops or messages agents. Transcript text is shown as plain text. The daemon that owns the workspace reads its own files.
