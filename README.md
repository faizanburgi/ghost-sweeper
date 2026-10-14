# Ghost Sweeper 👻

Review potentially unused files and remove only the candidates you explicitly approve. Ghost Sweeper uses [Knip](https://knip.dev/) for analysis; it does not claim static analysis proves that code is dead.

## Current status

This is an early implementation. The first release supports review and removal of unused source files only. Unused exports, types, and dependencies are displayed as findings but are not automatically changed. Verification commands are not implemented yet. Analysis is experimental for basic JavaScript/TypeScript and React/Vite projects; other Knip-supported frameworks may work, but have not been validated here.

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

Run scans in a trusted project. Knip plugins may load and execute project tool configuration files. Interactive runs ask for confirmation; non-interactive runs require `--allow-config-execution`. Cleanup sessions keep original file contents in a local recovery store outside the project. Verification scripts are project code and can have side effects; Ghost Sweeper does not run them automatically.

## Safety

- Findings require human review; selection is explicit.
- Only regular source files identified by Knip as unused can be removed.
- Files are backed up and journaled before deletion.
- Apply and undo check content hashes and stop on conflicts.
- Unsupported paths and symlinks are blocked.
- Undo never overwrites a file recreated or changed after cleanup.

This project is experimental. Keep normal backups and inspect every preview.
