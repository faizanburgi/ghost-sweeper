# Recovery and session history

Ghost Sweeper stores cleanup journals and original file bytes outside the project:

- macOS: `~/Library/Application Support/Ghost Sweeper`
- Windows: `%LOCALAPPDATA%\GhostSweeper`
- Linux: `$XDG_STATE_HOME/ghost-sweeper`, or `~/.local/state/ghost-sweeper`

Set `GHOST_SWEEPER_STATE_DIR` to use a different directory. Keep this directory private and do not remove it while you may need to undo a session. Files are created with restrictive permissions where the platform supports them.

Use `ghost-sweeper history` to see sessions and verification results. Restore a session with `ghost-sweeper undo <session-id>`. For deleted files, undo restores only when the destination path is absent. For replaced Markdown destinations, it restores only while the current content still matches the merged draft hash. If a file was recreated or edited after cleanup, Ghost Sweeper leaves it alone, reports a conflict, and continues restoring other conflict-free files. Move or back up the conflicting file, then retry undo.

If a process exits during apply or undo, the journal records the last completed operations. `ghost-sweeper undo <session-id>` can resume recovery from `prepared`, `applying`, `interrupted`, `restoring`, or `conflict` states. An operation that completed just before a crash is recognized from the file content hash. Markdown merges back up the original destination and every selected source removal in the same journal.

Backups are local recovery data, not a replacement for repository backups. If the state directory or its journal is lost or corrupted, recovery may be impossible.
