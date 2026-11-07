# dsh-approval-audit

[简体中文（完整版）](README.md) · English (abridged)

> This is an **abridged English version**. The [Chinese README](README.md) is the source of truth;
> details that change often (design notes, changelog, edge cases) live there.

> **Risk warning: installing this switches the approval gate off.**
>
> - Every active session is forced to preset `danger-full-access` (sandbox `danger-full-access` + approval policy `never`). Nothing asks you before it runs: file deletions, overwrites and arbitrary commands just execute.
> - Manually switching back to "read-only" is not a rollback. Within a live session it is not overridden immediately, but the first session event after a DSH restart switches it again. While the plugin line is mounted, do not expect manual settings to hold. Real rollback: remove the plugin line and restart.
> - Approval events and **tool-call arguments** are appended to a local JSONL (default `<DSH_HOME>/audit/approvals.jsonl`). Nothing is uploaded, but the file can contain secrets (commands, paths, credentials in paths).
> - Only for machines that do not run untrusted code, and users who know exactly why they want this.
> - No undo, no "careful mode". You assume the consequences.

Host-side plugin for DeepSeek Harness: forces every active session to full access (approval never) and appends approval / tool-call events to a local audit JSONL. No UI; the only visible output is the audit file.

[![version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/wojiao42/dsh-approval-audit/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## What it does

- Switches each session to the `danger-full-access` preset on its first session event: sandbox `danger-full-access` + approval `never`.
- Covers **existing** sessions too, not only new ones — that is the difference from a profile default preset, which only applies to sessions created later.
- Appends one JSON line per watched event to a local audit file: `approval/asked`, `approval/decided`, `approval/policy`, `sandbox/mode`, `permission/preset`, `tool/call`, `tool/result`, `turn/end`, plus its own `auto-preset` / `auto-preset-failed` records.
- Payloads are truncated (tool arguments 300 chars, `tool/result` meta 200, other data 400); `tool/result` records only `error` and `meta`.
- Read-only otherwise: it does not modify session events or work files, has no network access, no `child_process`, and no third-party dependencies.

## Quick start

**Not a one-click install.** `package.json` has no `dsh` field and no `dsh.bundle.patch`, so `dsh plugin add` only installs the package and does not mount it. Install = package + one manual line in the profile patch layer + restart.

1. Install the package — GUI: Settings (Ctrl+,) → Plugin market → Custom install → `github:wojiao42/dsh-approval-audit`; or CLI:

```bash
# Desktop
dsh plugin --profile desktop add github:wojiao42/dsh-approval-audit

# Web
dsh plugin --profile web add github:wojiao42/dsh-approval-audit
```

2. Append this to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: approval-audit
      name: '@local/dsh-approval-audit'
```

Or use the absolute path of `index.js` on your machine as `name:` (forward slashes on Windows).

3. Optional: set `DSH_APPROVAL_AUDIT_LOG` to choose where the JSONL goes (default `<DSH_HOME>/audit/approvals.jsonl`), then restart DSH and check that file after one tool call.

## Key limits

- One switch per session object: manual read-only is not overridden immediately, but a restart or a rebuilt session switches again. Remove the plugin line to really stop it.
- Audit file is append-only and never rotated; delete it yourself (re-created on the next write).
- Audit path does not follow the workspace: `DSH_APPROVAL_AUDIT_LOG` → `<DSH_HOME>/audit/approvals.jsonl` → `~/.dsh/audit/approvals.jsonl`; writes fail silently.
- Failed `permissionPresets.set()` is swallowed and only logged as `auto-preset-failed`; the session keeps its old preset.
- `PRESET` is compiled in: changing it needs a Harness restart (Host hot reload is off by default).
- The plugin applies to every session, regardless of workspace.

## Compatibility

- Host-side plugin, no client UI (`dsh.client` not declared).
- Mounted through the profile user patch layer (`cordis.patch.yml`), so it needs a DSH that supports patch inserts; it is not auto-mounted from `package.json`.
- Requires the host's `permissionPresets` service and a preset literally named `danger-full-access`.
- Only Node built-ins (`node:fs`, `node:path`, `node:os`); no third-party packages, no `engines` or `peerDependencies`.
- No automated tests in this repo; see the Chinese README for the manual verification steps.

## License

MIT. See [LICENSE](LICENSE).
