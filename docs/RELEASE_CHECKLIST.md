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

- [ ] README examples match the released behaviour.
- [ ] CLI and MCP references are complete.
- [ ] Troubleshooting, privacy and migration guides are complete.
- [ ] Package contents and provenance are verified.
- [ ] Changelog and version agree.

## Publication

- [ ] Fresh package install succeeds without repository checkout.
- [ ] Demo is recorded.
- [ ] Tag, GitHub release and npm publication use the same version.
- [ ] Post-release install and smoke test pass.
