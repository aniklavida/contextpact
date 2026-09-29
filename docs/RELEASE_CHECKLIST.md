# v1.0 release checklist

Evidence dates refer to the state of `develop` at commit `8f50ff8`. Items that
require hardware, a vendor application, or a publication step are left unticked
with the reason stated rather than assumed.

## Product

- [x] Every v1 requirement in `SPEC.md` is implemented and tested. All twelve
      v1 scope items map to suites in [tests/](../tests), 218 tests across 22 files,
      all passing via `npm test`: workspace init and the four scopes
      ([workspace.test.ts](../tests/workspace.test.ts),
      [agent.test.ts](../tests/agent.test.ts)); the eight Markdown context types
      ([markdown.test.ts](../tests/markdown.test.ts),
      [mcp.test.ts](../tests/mcp.test.ts)); lifecycle states, approval gate,
      supersession and audit trail ([lifecycle.test.ts](../tests/lifecycle.test.ts));
      agents, sessions, tasks, leases, policies and versions
      ([agent.test.ts](../tests/agent.test.ts),
      [task-lease.test.ts](../tests/task-lease.test.ts)); FTS5 search and
      deterministic packs with provenance ([retrieval.test.ts](../tests/retrieval.test.ts));
      task claims and stale takeover
      ([task-lease.test.ts](../tests/task-lease.test.ts)); evidence-bearing
      handoffs ([handoff.test.ts](../tests/handoff.test.ts)); CLI and MCP over one
      core ([parity.test.ts](../tests/parity.test.ts),
      [cli.test.ts](../tests/cli.test.ts), [mcp.test.ts](../tests/mcp.test.ts));
      guided host configuration ([connect.test.ts](../tests/connect.test.ts));
      Obsidian-compatible external edits
      ([obsidian.test.ts](../tests/obsidian.test.ts)); import/export, backup,
      reindex, migrations and diagnostics
      ([export-import.test.ts](../tests/export-import.test.ts),
      [backup-restore.test.ts](../tests/backup-restore.test.ts),
      [reconciliation.test.ts](../tests/reconciliation.test.ts),
      [migration.test.ts](../tests/migration.test.ts),
      [doctor.test.ts](../tests/doctor.test.ts)); proof workflows
      ([proof-demos.test.ts](../tests/proof-demos.test.ts)).
- [x] Deferred features are not advertised as supported. Team and remote sync
      is listed under "Planned for v1.0 and not yet advertised as supported" in
      [README.md](../README.md) and marked not yet implemented in
      [SPEC.md](SPEC.md) and [ARCHITECTURE.md](ARCHITECTURE.md). All four host
      adapters are labelled experimental with host evidence status "planned" in
      [README.md](../README.md). Enforced in CI by the `public-safety` job.
- [x] Coding and research workflows pass from clean workspaces (verified unattended on macOS via [demos/coding-demo.mjs](../demos/coding-demo.mjs) and [demos/research-demo.mjs](../demos/research-demo.mjs); automated in tests/proof-demos.test.ts).

## Compatibility

- [x] macOS, Linux and Windows clean installs pass. The `clean-install` job
      packs the tarball, installs it into a directory outside the repository
      checkout, and exercises the installed binary with `init` and `status` on
      `ubuntu-latest`, `macos-latest` and `windows-latest`. All three passed in
      Validate run 36017916456. The `pretest` fix in this branch changes only the
      test/build script order and does not affect packaging, so that result
      still stands; it is expected to be re-confirmed on this branch's own run.
- [ ] Claude Code, Codex and Cursor integrations have recorded evidence. **Needs
      a real vendor application.** The adapters are implemented and tested, but
      [connect.test.ts](../tests/connect.test.ts) exercises them against _fixture_
      config files it writes into a temporary directory, not against an installed
      Claude Code, Codex or Cursor. Recording real evidence needs a machine with
      those applications actually installed and connected.
- [x] Generic MCP configuration is verified against the protocol contract. The
      generic block is generated and validated against the protocol contract in
      [connect.test.ts](../tests/connect.test.ts), and `connect --check` starts a
      real MCP server subprocess and completes a real tool call. Independently
      confirmed from the packed tarball installed outside a checkout: `initialize`
      negotiated protocol version `2025-06-18`, `tools/list` returned 14 tools, and
      `tools/call` for `context_search` and `context_status` returned correct
      results.

## Reliability and safety

- [x] Concurrency, lease expiry, stale takeover and conflict tests pass.
      [task-lease.test.ts](../tests/task-lease.test.ts) (29 tests) covers
      claim/renew/release, refusal of claims against an active or expired lease,
      scope-overlap conflicts, and audited stale takeover that requires a reason.
      Concurrency is proven with real OS processes via `child_process`, not mocks:
      two processes claiming different tasks both succeed, and two processes
      claiming the same task produce exactly one winner. Leases are also covered in
      [handoff.test.ts](../tests/handoff.test.ts) and [agent.test.ts](../tests/agent.test.ts).
- [x] Migration, backup, restore, reindex and corruption-recovery tests pass.
      [migration.test.ts](../tests/migration.test.ts) migrates a real v1 database
      forward with no data loss; [backup-restore.test.ts](../tests/backup-restore.test.ts)
      covers dual-store backup and restore and rejects incomplete snapshots;
      [reconciliation.test.ts](../tests/reconciliation.test.ts) covers reindex,
      corrupt-database rebuild, stale-version conflicts and duplicate-ID
      ambiguity; [doctor.test.ts](../tests/doctor.test.ts) covers six damaged
      workspace kinds and a healthy baseline.
- [x] Context provenance, approval and supersession tests pass.
      [lifecycle.test.ts](../tests/lifecycle.test.ts) covers the approval gate
      including refusal of self-approval and of the default agent profile, legal
      and illegal state transitions, superseded decisions staying readable but
      absent from default packs, and an audit row naming actor and previous
      version for every state change. [retrieval.test.ts](../tests/retrieval.test.ts)
      proves packs carry provenance, are byte-for-byte identical across separate
      processes, and are independent of insertion order.
- [ ] Threat model and security review are current. **Needs a human security
      reviewer.** [THREAT_MODEL.md](THREAT_MODEL.md) exists, is exercised by
      [pack-injection.test.ts](../tests/pack-injection.test.ts) and
      [retrieval.test.ts](../tests/retrieval.test.ts), and is honest about its
      residual risks. But it self-declares as "Version: 0 (pre-v1 draft)" and no
      independent security review has been performed, so this cannot be ticked by
      the author's own test run.
- [x] No secrets or machine-specific paths exist in tracked files. Verified by
      `git grep` over tracked files for absolute per-user home directory paths
      in the macOS, Linux and Windows forms (no matches) and for credential
      patterns including AWS access key IDs, GitHub personal access tokens,
      `sk-` provider keys and private-key headers (no matches; the only hits are
      prose and token-budgeting source). Enforced continuously by the
      `public-safety` job in CI.

## Documentation and package

- [x] README examples match the released behaviour (verified against implemented CLI entrypoint and MCP tools).
- [x] CLI and MCP references are complete (documented in [docs/CLI_REFERENCE.md](CLI_REFERENCE.md) and [docs/MCP_REFERENCE.md](MCP_REFERENCE.md); automated drift test in [tests/drift.test.ts](../tests/drift.test.ts)).
- [x] Troubleshooting, privacy and migration guides are complete (documented in [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md), [docs/PRIVACY.md](PRIVACY.md), and [docs/MIGRATION.md](MIGRATION.md)).
- [x] Package contents and provenance are verified. The tarball was built with
      `npm pack`, its full contents listed and its SHA-256 recorded and re-verified
      against the packed file, and `npm pack --dry-run` runs in CI on every push.
      The final tarball is 90 files, limited to the declared `files` allowlist
      (`dist`, `README.md`, `LICENSE`) plus `package.json`, with
      `sha256:f04f4cbe5f70f303598a75bebe6c4bba017873d70c0d3125e22f1a211c929d79`.
- [x] Changelog and version agree (verified in [CHANGELOG.md](../CHANGELOG.md) Unreleased section against package.json 0.0.0).

## Publication

- [x] Fresh package install succeeds without repository checkout. Verified on
      macOS by packing the tarball, installing it with `npm install` into a clean
      project directory under an isolated `HOME`, with no repository checkout
      present: 100 packages installed, 0 vulnerabilities. The installed `contextpact`
      binary reported `0.0.0`, printed the full command surface, ran `init` (loading
      the native `better-sqlite3` binding), and completed a `propose` -> `approve`
      lifecycle and FTS5 `search`, with `doctor` reporting the resulting workspace
      healthy (0 errors, 0 warnings). The installed `contextpact mcp` server
      separately negotiated the MCP handshake, answered `tools/list`, and served
      real `tools/call` requests for `context_search` and `context_status` against
      the same workspace, confirming both transports work from the packed artifact
      alone.
- [ ] Demo is recorded. **Needs a real screen recording.** The coding and
      research demos execute unattended and are asserted by
      [proof-demos.test.ts](../tests/proof-demos.test.ts), but a recorded demo is a
      video artefact and cannot be produced or verified from a test run.
- [ ] Tag, GitHub release and npm publication use the same version. **Blocked
      on a publication decision.** Deliberately not performed: tagging, pushing to
      `main`/`develop`, `npm publish` and `gh release create` are all out of scope
      for this branch, and the version is still `0.0.0`.
- [ ] Post-release install and smoke test pass. **Depends on publication.**
      Cannot run before a release exists to install from the registry.
