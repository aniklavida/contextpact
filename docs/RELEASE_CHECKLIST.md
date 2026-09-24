# v1.0 release checklist

## Product

- [ ] Every v1 requirement in `SPEC.md` is implemented and tested.
- [ ] Deferred features are not advertised as supported.
- [x] Coding and research workflows pass from clean workspaces (verified unattended on macOS via [demos/coding-demo.mjs](../demos/coding-demo.mjs) and [demos/research-demo.mjs](../demos/research-demo.mjs); automated in tests/proof-demos.test.ts).

## Compatibility

- [ ] macOS, Linux and Windows clean installs pass.
- [ ] Claude Code, Codex and Cursor integrations have recorded evidence.
- [ ] Generic MCP configuration is verified against the protocol contract.

## Reliability and safety

- [ ] Concurrency, lease expiry, stale takeover and conflict tests pass.
- [ ] Migration, backup, restore, reindex and corruption-recovery tests pass.
- [ ] Context provenance, approval and supersession tests pass.
- [ ] Threat model and security review are current.
- [ ] No secrets or machine-specific paths exist in tracked files.

## Documentation and package

- [x] README examples match the released behaviour (verified against implemented CLI entrypoint and MCP tools).
- [x] CLI and MCP references are complete (documented in [docs/CLI_REFERENCE.md](CLI_REFERENCE.md) and [docs/MCP_REFERENCE.md](MCP_REFERENCE.md); automated drift test in [tests/drift.test.ts](../tests/drift.test.ts)).
- [x] Troubleshooting, privacy and migration guides are complete (documented in [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md), [docs/PRIVACY.md](PRIVACY.md), and [docs/MIGRATION.md](MIGRATION.md)).
- [ ] Package contents and provenance are verified.
- [x] Changelog and version agree (verified in [CHANGELOG.md](../CHANGELOG.md) Unreleased section against package.json 0.0.0).

## Publication

- [ ] Fresh package install succeeds without repository checkout.
- [ ] Demo is recorded.
- [ ] Tag, GitHub release and npm publication use the same version.
- [ ] Post-release install and smoke test pass.
