# Ghost Sweeper 👻

Review potentially unused source and Markdown files, and remove only the candidates you explicitly approve. Ghost Sweeper uses [Knip](https://knip.dev/) for source analysis and a limited local-link scan for Markdown; neither can prove that a file is unnecessary.

## Current status

Ghost Sweeper uses Knip to find unused source files and a small local-link scanner to find Markdown files that cannot be reached from recognized project guides. The interactive review can select and remove these source and Markdown candidates; exports, types, and dependencies are view-only. Markdown findings are marked uncertain because standalone guides, externally linked documents, or generated documentation navigation may not be visible in the repository. Project guide files such as `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`, and GitHub templates are protected. Uncertain Markdown candidates must be selected individually. Destructive apply requires a Git repository. Basic JavaScript/TypeScript and React/Vite are experimental until broader fixture and real-project validation is complete.

## Development

Requires Node.js 22.12 or later.

```sh
npm install
npm run build
node dist/cli.js --help
```

## Use

```sh
npx ghost-sweeper
npx ghost-sweeper scan --json --allow-config-execution
npx ghost-sweeper history
npx ghost-sweeper undo
npx ghost-sweeper markdown --offline
npx ghost-sweeper markdown
```

Run scans in a trusted project. Knip plugins may load and execute project tool configuration files. Interactive runs ask for confirmation; non-interactive runs require `--allow-config-execution`.

Before apply, Ghost Sweeper copies the project to a private temporary directory, excluding `.git` and `node_modules`, and removes the selected files in that copy. The preview shows each selected path, line count, and content hash. From the preview, press `v` to review available `test`, `build`, `typecheck`, and `lint` npm scripts. Each script needs its own approval and runs in the temporary copy. Script code may still access network resources, credentials, and files outside the copy; the temporary directory is not a sandbox. Checks may fail when they depend on `node_modules`, which is intentionally excluded. Press `s` to skip checks and continue.

Apply checks the project content and permissions against the staged snapshot, writes the original bytes to the local recovery store, and then removes only the selected files. `ghost-sweeper history` shows session and verification state. `ghost-sweeper undo [session-id]` restores deleted files that remain absent and replaced files that still match the merged draft; changed paths are left untouched and reported as conflicts. Recovery details are in [docs/recovery.md](docs/recovery.md), and execution boundaries are in [docs/security.md](docs/security.md).

## Markdown comparison and merges

`scan --json` includes local Markdown match groups. Ghost Sweeper compares normalized text and TF-IDF similarity over headings and prose; it labels pairs as duplicate, overlapping, or related. It reads `.md` files throughout the repository, skips dependency/build folders, and includes protected guides as read-only comparison material. Similarity is a shortlist for human review, not proof that two documents can safely be combined.

Run `ghost-sweeper markdown --offline` to inspect one local group without using Gemini. Run `ghost-sweeper markdown` to open a group for a proposed merge. Before any upload, Ghost Sweeper lists the exact Markdown files and asks for approval. In non-interactive use, a selected `--group <group-id>` requires `--allow-cloud-upload`; `--offline` always disables Gemini. Set `GEMINI_API_KEY` in the environment or enter it at the hidden prompt. The key is not written to the journal and is removed from Knip and verification child-process environments. The default model is `gemini-3.8-flash`; set `GHOST_SWEEPER_GEMINI_MODEL` to override it.

Gemini returns a structured draft, per-section source line references, and conflicts. Ghost Sweeper checks every citation against exact uploaded file lines and displays which passages support each section. In the terminal review, choose a destination that is not a protected guide, resolve each conflict by selecting a cited passage or editing the draft, then choose any source files to remove. Sources are kept unless you select them. The combined replacement/deletions are staged, optionally verified with individually approved npm scripts, and applied only after typing `APPLY`. `ghost-sweeper undo <session-id>` restores the prior destination and removed sources, while leaving later edits in place and reporting conflicts.

Cloud analysis sends only the selected comparison group's Markdown content to Google Gemini. Review its privacy and API terms before approving uploads. No content is sent during local comparison or in `--offline` mode.

## Safety

- Findings require human review; selection is explicit.
- Only regular source files identified by Knip and Markdown files identified as unreferenced can be removed.
- Files are staged in a temporary project copy; the source tree stays unchanged until apply is approved.
- Files are backed up and journaled before deletion.
- Apply checks the staged project fingerprint and target hashes; undo checks backups and stops on conflicts.
- Unsupported paths and symlinks are blocked.
- Undo never overwrites a file recreated or changed after cleanup.

This project is experimental. Keep normal backups and inspect every preview.
