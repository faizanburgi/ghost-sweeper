# Security and execution boundaries

## Analysis

Ghost Sweeper starts Knip as a child process in the selected project. Knip plugins may dynamically load project configuration files, so scan only repositories you trust. Interactive scans ask before running; non-interactive scans require `--allow-config-execution`.

For Markdown, Ghost Sweeper follows local links starting from recognized project guides and reports Markdown files that are not reachable from them. It protects common repository guides (`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `AGENTS.md`, other recognized instruction/governance files) and Markdown under `.github/`. The scanner does not understand every documentation site configuration, external link, generated navigation list, or standalone guide. These findings are marked uncertain and are excluded from bulk selection; inspect the displayed reason and select each one manually if you decide it can be removed.

## Staging and apply

The staged project copy is created in the operating system's temporary directory with private permissions where supported. It excludes `.git` and `node_modules`, preserves project symlinks as links, and is removed when the interactive review exits. The copy is not a security sandbox. Large files and additional workspace data may make staging slow or consume substantial temporary disk space.

Before apply, Ghost Sweeper compares the project's file paths, types, modes, and content hashes with the staged snapshot, then rechecks each selected file. It fails closed on changed targets, unsafe paths, symlink traversal, and non-Git projects. Original bytes and a recovery journal are written to the external session store before deletion.

## Verification commands

Only existing `test`, `build`, `typecheck`, and `lint` npm scripts are offered. Ghost Sweeper displays the exact command and requires separate approval for each run. Scripts execute in the staged copy with the current shell environment and a 120-second timeout. Project code can still access the network, credentials, and files outside that directory. Ghost Sweeper does not install dependencies; commands that need `node_modules` may fail because that directory is excluded from the copy.

Never approve scripts from a project you do not trust. Verification commands may have external side effects that Ghost Sweeper cannot undo.

## Network and telemetry

Ghost Sweeper does not upload project source or send telemetry. Knip and user-approved verification scripts run locally, but those tools may have their own network behavior.
