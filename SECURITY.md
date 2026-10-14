# Security policy

Please report security issues privately to the repository maintainer before opening a public issue. Include the affected version, reproduction steps, and impact. Do not include secrets or private project contents in a report unless the maintainer has provided a secure channel.

Ghost Sweeper is local-first. It does not upload source code or send telemetry. Knip plugins may load project configuration while scanning, and approved project commands can have effects outside the temporary directory. Treat both as trusted-code execution boundaries.

Cleanup backups contain original source file bytes. They are stored in the user's local application state directory with restrictive permissions where supported. Users should protect that directory and retain independent backups.
