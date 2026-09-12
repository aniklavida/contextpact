# Security policy

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories. Do not open a public issue for an unpatched vulnerability.

## Current status

ContextPact has not published a stable release. Only a future supported v1 release line will receive security fixes.

## Data warning

Local context is plaintext by default and must not contain passwords, tokens or other secrets. MCP clients may send retrieved context to the model provider configured by the user.

The local policy system is designed to prevent accidental cross-scope access. It is not a sandbox against a hostile local process with filesystem access.
