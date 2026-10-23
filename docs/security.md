# Security and execution boundaries

## Analysis

Ghost Sweeper starts Knip as a child process in the selected project. Knip plugins may dynamically load project configuration files, so scan only repositories you trust. Interactive scans ask before running; non-interactive scans require `--allow-config-execution`.

For Markdown, Ghost Sweeper follows local links from recognized guides, reports unreachable Markdown files as uncertain, and locally compares document pairs with TF-IDF similarity. Comparison groups are suggestions, not proof that a document is unused or that two documents should be merged. It protects common repository guides (`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `AGENTS.md`, other recognized instruction/governance files) and Markdown under `.github/` from replacement and deletion. Protected documents can still be read-only comparison sources.

Markdown comparison stays local. Gemini is called only after a user opens a group and approves upload of the exact listed files, or supplies `--allow-cloud-upload` in non-interactive mode with an explicit group ID. `--offline` disables Gemini. The API key comes from `GEMINI_API_KEY` or a hidden prompt; Ghost Sweeper does not store it and removes it from Knip and verification child-process environments. It sends only the opened group, not the whole repository. Review Google API terms before approving. Gemini drafts are untrusted: every cited path, line range, and excerpt is checked against the uploaded text, and conflicts block apply until resolved by the user.

## Staging and apply

The staged project copy is created in the operating system's temporary directory with private permissions where supported. It excludes `.git` and `node_modules`, preserves project symlinks as links, and is removed when the interactive review exits. The copy is not a security sandbox. Large files and additional workspace data may make staging slow or consume substantial temporary disk space.

Before apply, Ghost Sweeper compares the project's file paths, types, modes, and content hashes with the staged snapshot, then rechecks each selected file. It fails closed on changed targets, unsafe paths, symlink traversal, and non-Git projects. Original bytes and a recovery journal are written to the external session store before deletion or Markdown replacement.

## Verification commands

Only existing `test`, `build`, `typecheck`, and `lint` npm scripts are offered. Ghost Sweeper displays the exact command and requires separate approval for each run. Scripts execute in the staged copy with the shell environment (excluding `GEMINI_API_KEY`) and a 120-second timeout. Project code can still access the network, other credentials, and files outside that directory. Ghost Sweeper does not install dependencies; commands that need `node_modules` may fail because that directory is excluded from the copy.

Never approve scripts from a project you do not trust. Verification commands may have external side effects that Ghost Sweeper cannot undo.

## Network and telemetry

Ghost Sweeper sends no source and no telemetry unless the user explicitly approves a selected Markdown group for Gemini. Knip and user-approved verification scripts otherwise run locally, but those tools may have their own network behavior.
