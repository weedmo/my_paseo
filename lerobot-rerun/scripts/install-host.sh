#!/usr/bin/env bash
# Install this plugin on another computer over SSH and register that computer as a host of the
# local Paseo daemon, so the dataset screen can open its episodes.
#
# Usage: scripts/install-host.sh [--enable-plugins] [--with-ui] user@host [label]
#
# The host becomes a dataset host: its plugin serves episodes, folders and Parquet files to this
# computer, but does not show the dataset screen or sidebar itself, so the app always opens them on
# the computer it runs on. --with-ui keeps the screen on that host too, for people who run the
# Paseo app on that machine.
#
# On the remote computer this:
#   1. copies the plugin to ~/.local/share/paseo-plugins/lerobot-rerun and installs its runtime
#      npm dependencies,
#   2. creates ~/.local/share/paseo-lerobot-rerun/venv with rerun-sdk (same version as here),
#      pyarrow, av and pillow,
#   3. with --enable-plugins, sets pluginsEnabled in ~/.paseo/config.json and reloads the daemon.
#      Without it, a daemon that has plugins disabled stops the script,
#   4. installs or reloads the plugin in its Paseo daemon.
# Locally it registers ssh://user@host as a host, unless that daemon is already registered.
set -euo pipefail

enable_plugins=0
with_ui=0
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --enable-plugins) enable_plugins=1 ;;
    --with-ui) with_ui=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
target="${1:?usage: $0 [--enable-plugins] user@host [label]}"
label="${2:-$target}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$here/paseo-plugin.json")"
remote_dir='.local/share/paseo-plugins/lerobot-rerun'
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10)

# Keep the recording format identical on both ends.
local_python=""
for candidate in "$HOME/.local/share/paseo-lerobot-rerun/venv/bin/python" python3 "$HOME"/miniconda3/envs/*/bin/python; do
  if "$candidate" -c 'import rerun' 2>/dev/null; then local_python="$candidate"; break; fi
done
rerun_version="$("${local_python:-python3}" -c 'import rerun; print(rerun.__version__)' 2>/dev/null || echo 0.22.1)"

step() { printf '\n== %s: %s\n' "$target" "$*"; }
remote() { ssh "${ssh_opts[@]}" "$target" "bash -lc $(printf '%q' "$1")"; }

step "copy plugin files"
ssh "${ssh_opts[@]}" "$target" "mkdir -p ~/$remote_dir && find ~/$remote_dir -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +"
tar -C "$here" --exclude=node_modules --exclude=.git --exclude=__pycache__ -cf - . \
  | ssh "${ssh_opts[@]}" "$target" "tar -C ~/$remote_dir -xf -"

step "install npm runtime dependencies"
remote "cd ~/$remote_dir && npm ci --omit=dev --no-audit --no-fund --loglevel=error"

step "install Python packages (rerun-sdk==$rerun_version)"
remote "set -e
venv=~/.local/share/paseo-lerobot-rerun/venv
[ -x \$venv/bin/python ] || python3 -m venv \$venv
\$venv/bin/python -m pip install --quiet --upgrade pip
\$venv/bin/python -m pip install --quiet 'rerun-sdk==$rerun_version' pyarrow av pillow
\$venv/bin/python ~/$remote_dir/server/lerobot_rerun.py check"

step "check the Paseo daemon"
enabled="$(remote "python3 -c 'import json,os; print(json.load(open(os.path.expanduser(\"~/.paseo/config.json\"))).get(\"pluginsEnabled\") is True)'")"
if [[ "$enabled" != "True" ]]; then
  if [[ $enable_plugins -ne 1 ]]; then
    echo "Plugins are disabled on $target. Re-run with --enable-plugins after the owner agrees." >&2
    exit 2
  fi
  step "enable plugins"
  remote "python3 - <<'PY'
import json, os
path = os.path.expanduser('~/.paseo/config.json')
config = json.load(open(path))
config['pluginsEnabled'] = True
tmp = path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(config, f, indent=2)
    f.write('\n')
os.replace(tmp, path)
PY
paseo daemon reload --json"
fi

step "set the host role"
if [[ $with_ui -eq 1 ]]; then
  remote "rm -f ~/.local/share/paseo-lerobot-rerun/data-host"
else
  remote "mkdir -p ~/.local/share/paseo-lerobot-rerun && echo 'Dataset host for another computer: the lerobot-rerun plugin hides its screen and sidebar here. Delete this file to show them.' > ~/.local/share/paseo-lerobot-rerun/data-host"
fi

step "install the plugin in the daemon"
# `paseo plugin ls <id>` exits 0 even for a missing plugin, so read the JSON listing instead.
plugin_status() {
  remote "paseo plugin ls --json 2>/dev/null" | python3 -c '
import json, sys
for plugin in json.load(sys.stdin):
    if plugin.get("id") == sys.argv[1]:
        print(plugin.get("status", "unknown"), plugin.get("error") or "")
        break
else:
    print("missing")' "$plugin_id"
}
if [[ "$(plugin_status)" == missing* ]]; then
  remote "paseo plugin install \$HOME/$remote_dir" >/dev/null
else
  remote "paseo plugin reload $plugin_id" >/dev/null
fi
status="$(plugin_status)"
echo "plugin status: $status"
[[ "$status" == running* ]] || { echo "The plugin is not running on $target." >&2; exit 3; }

step "register the host on this computer"
remote_server="$(remote 'cat ~/.paseo/server-id' | tr -d '[:space:]')"
if paseo host ls --json 2>/dev/null | grep -q "\"$remote_server\""; then
  echo "already registered ($remote_server)"
else
  paseo host add "ssh://$target" --label "$label"
fi
