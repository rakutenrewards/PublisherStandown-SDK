# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes       |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security vulnerabilities by emailing the Rakuten Rewards engineering team:

**rewards-security@rakuten.com**

Include the following in your report:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if available)
- Any suggested mitigations

You will receive an acknowledgement within 2 business days and a resolution timeline within 7 business days.

## Scope

This SDK is a zero-dependency TypeScript library that runs inside browser extensions. The primary security considerations are:

- **Supply-chain integrity:** All releases are published with `npm publish --provenance`, producing a signed attestation that links the published package to the source commit and CI build.
- **Secret handling:** Registry credentials are managed as CI secrets and never logged or exposed in build output.
- **No runtime network access:** The SDK itself makes no outbound network requests; it only inspects URLs already present in the browser's navigation history.

## Out of scope

- Vulnerabilities in the browser extension that consumes this SDK (report those to the owning team)
- GitHub Actions misconfigurations unrelated to this repository
