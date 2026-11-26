Project hub adds a sidebar view that shows one entry per git repository across every connected host. Paseo keeps a separate project list on each daemon, so the same repository checked out on a laptop and on two servers otherwise appears as three unrelated projects. Pick the view under Settings > Sidebar > Sidebar view; Default view stays available.

Projects are grouped by the git remote Paseo already records for them. GitHub remotes are resolved to their current name with the `gh` CLI on the daemon that runs this plugin, so a renamed repository and its old remote land in the same group. Each repository shows its name with the owner's GitHub avatar in place of the owner prefix; the daemon downloads the avatar so the app does not contact GitHub. Directories without a remote stay in their own group.

Under a repository that spans several hosts, each host is a row with its workspaces below it. Hover a repository or host and press + to open Paseo's New workspace flow for that checkout. Collapsed repositories are remembered on this device.

The gear on a repository opens its settings: open it on GitHub, set one display name for every host's project, or remove a single host's checkout or the whole repository from Paseo. Removing never changes files on disk, but archives the project's workspaces the same way Default view's Remove project does. The daemon running the plugin performs these actions on other hosts through the hosts registered on it.

Setup: the daemon running the plugin needs `gh` signed in to resolve private repositories. Without it, grouping falls back to the raw remote. The plugin sends repository names to GitHub through `gh` and downloads owner avatars from GitHub's avatar CDN.

Hover a workspace to archive it. Mod+1..9 jumps to the first nine visible workspaces and Mod+[ / Mod+] steps through them in this view's order (Mod is Cmd on macOS, Ctrl elsewhere); hold Mod to see the numbers. Paseo's own Jump to workspace and Previous/Next workspace bindings use the same keys and handle them first, so unbind those under Settings > Shortcuts for these to take effect. The built-in archive shortcut keeps working on the open workspace.

The view does not reproduce Default view's pinning, label folders, row context menu, drag ordering, or pull request badges.
