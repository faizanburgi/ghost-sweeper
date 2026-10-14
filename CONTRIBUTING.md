# Contributing

Thanks for helping improve Ghost Sweeper. The most useful contributions are reproducible analyzer fixtures, safety fixes, and clear reports of findings that were incorrectly classified.

## Development setup

- Node.js 22.12 or newer
- npm

```sh
npm install
npm run typecheck
npm test
npm run build
```

## Pull requests

- Keep analysis results attributable to Knip; do not imply static analysis proves code is unused.
- Add a fixture or regression test for analyzer or cleanup behavior changes.
- For filesystem changes, cover interruption and conflict behavior.
- Do not add network calls, telemetry, or automatic project-script execution.
- Describe platform coverage and any limitations in the pull request.

## Reporting false positives

Share the framework/tool versions, relevant entry-point configuration, the normalized finding, and the smallest safe fixture that reproduces it. Remove secrets and private project contents before sharing logs.
