# VPS deployment loop

Deploy Agent Console to a server that already runs other sites (such as tayibbat) **without touching them**.

## How it works

```
You run one command on the VPS ──▶ it runs the current step ──▶ report goes to a PRIVATE repo
          ▲                                                              │
          └──── Claude reads the report, pushes the next step/fix ◀──────┘
```

Run this, as many times as asked:

```bash
curl -fsSL https://raw.githubusercontent.com/Abdelrahman-sadek/agent-console/claude/agents-framework-eval-hrmlxu/deploy/vps.sh | sudo bash
```

- `deploy/STEP` names the step that runs next; `deploy/steps/<step>.sh` is what it does.
- Every run fetches the newest scripts with git, so fixes pushed to GitHub apply on the next run.
- Output is saved on the server in `/opt/agent-framework/reports/` and published to the private repo
  **`Abdelrahman-sadek/agent-console-vps`** as `latest.md`.

## One-time setup

1. Create a **private** repo named `agent-console-vps` (empty, with a README) at https://github.com/new.
2. Run the command. The first run prints this server's key and where to add it
   (repo → Settings → Deploy keys → Add, with **Allow write access**). The key can only write to that one repo.
3. Run the command again. The report is published.

## Safety rules the steps follow

| | |
| --- | --- |
| **Read first** | Step 1 (`inventory`) only reads. Nothing is installed until the report has been reviewed. |
| **Own folder and user** | Everything lives in `/opt/agent-framework`, run by its own user. |
| **Own Node** | A private Node 22 inside `/opt/agent-framework`. The system Node that other apps use is not changed. |
| **Free port only** | Uses a port the inventory shows as free, bound to localhost. |
| **Web server** | Adds one new site file for its own subdomain. Existing site files are never edited, the config is backed up, and `nginx -t` must pass before any reload. |
| **Secrets** | Reports are filtered for passwords, tokens, keys and URL credentials, and only go to the private repo. |
| **Undo** | An `uninstall` step removes everything the install added. |

Take a VPS snapshot in your hosting dashboard before the first install step, for a one-click undo.
