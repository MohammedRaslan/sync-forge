# Security policy

## Scope: a local-only tool

Syncforge is built to run **on your own machine, bound to `127.0.0.1`, for users who are already trusted** with the databases it connects to. It has no login, no user accounts and no permissions, and job expressions run as code in the engine's process.

It is **not intended for production, shared servers, hosted services or any internet-facing use**, and its code is not meant to be reused as a pattern for such applications. The full model is described in the [README's Security model](README.md#security-model).

## What counts as a vulnerability

Please report problems that break the guarantees Syncforge does make, for example:

- Saved credentials (passwords, connection strings, keys) leaking through the API, logs, run history, exported scripts or git.
- SQL or query injection through table, field or file names, or through values.
- A source database being written to.
- Path traversal outside the workspace (job ids, connection ids, uploaded CSV file names).
- The engine listening on, or being reachable from, more than loopback with the default settings.

Things that follow from the documented design are not vulnerabilities: no authentication, expressions being able to run code, or what someone can do once they can reach a Syncforge instance that was exposed on purpose.

## Reporting

Please report privately rather than in a public issue: use [**Report a vulnerability**](https://github.com/MohammedRaslan/sync-forge/security/advisories/new) under the repository's **Security** tab. Include the version (commit), steps to reproduce and what you expected to happen.

## Supported versions

Only the latest commit on `master` is supported. Fixes are not backported.
