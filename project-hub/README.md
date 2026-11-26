# Project hub

A [Paseo](https://paseo.sh) sidebar view that shows one entry per git repository across every connected host, with each host's checkouts and workspaces underneath. See [OVERVIEW.md](OVERVIEW.md) for what it does.

## Install

```bash
paseo plugin install git:weedmo/my_paseo:project-hub
```

Then pick **Repositories across hosts** under Settings > Sidebar > Sidebar view. Install it on the daemon that has your other hosts registered (`paseo host ls`), and sign in `gh` there so private repositories resolve.

## Develop

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"
paseo plugin reload project-hub
```
