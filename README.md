# Ghost Sweeper 👻

Review potentially unused files and remove only the candidates you explicitly approve. Ghost Sweeper uses [Knip](https://knip.dev/) for analysis; it does not claim static analysis proves that code is dead.

## Current status

Ghost Sweeper uses Knip for analysis. The interactive review can select and remove unused JavaScript/TypeScript files only; exports, types, and dependencies are view-only. Destructive apply requires a Git repository. Basic JavaScript/TypeScript and React/Vite are experimental until broader fixture and real-project validation is complete.

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
```

Run scans in a trusted project. Knip plugins may load and execute project tool configuration files. Interactive runs ask for confirmation; non-interactive runs require `--allow-config-execution`.

Before apply, Ghost Sweeper copies the project to a private temporary directory, excluding `.git` and `node_modules`, and removes the selected files in that copy. The preview shows each selected path, line count, and content hash. From the preview, press `v` to review available `test`, `build`, `typecheck`, and `lint` npm scripts. Each script needs its own approval and runs in the temporary copy. Script code may still access network resources, credentials, and files outside the copy; the temporary directory is not a sandbox. Checks may fail when they depend on `node_modules`, which is intentionally excluded. Press `s` to skip checks and continue.

Apply checks the project content and permissions against the staged snapshot, writes the original bytes to the local recovery store, and then removes only the selected files. `ghost-sweeper history` shows session and verification state. `ghost-sweeper undo [session-id]` restores files that remain absent and have valid backups; recreated files are left untouched and reported as conflicts. Recovery details are in [docs/recovery.md](docs/recovery.md), and execution boundaries are in [docs/security.md](docs/security.md).

## Safety

- Findings require human review; selection is explicit.
- Only regular source files identified by Knip as unused can be removed.
- Files are staged in a temporary project copy; the source tree stays unchanged until apply is approved.
- Files are backed up and journaled before deletion.
- Apply checks the staged project fingerprint and target hashes; undo checks backups and stops on conflicts.
- Unsupported paths and symlinks are blocked.
- Undo never overwrites a file recreated or changed after cleanup.

This project is experimental. Keep normal backups and inspect every preview.
