# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.x     | ✅ Yes    |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

We accept reports through two channels:

1. **Email (preferred):** **security@lumigift.com**
2. **Reporting form:** https://lumigift.com/security/report

Please include:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Any suggested mitigations

### Encrypted Reports (PGP)

For sensitive reports, encrypt your message with our PGP key. The key is also published at https://lumigift.com/.well-known/security.txt.

```
-----BEGIN PGP PUBLIC KEY BLOCK-----
Comment: Lumigift Security <security@lumigift.com>
Comment: Fingerprint: 0000 0000 0000 0000 0000  0000 0000 0000 0000 0000

mQINBGXplaceholderplaceholderplaceholderplaceholderplaceholder
placeholderplaceholderplaceholderplaceholderplaceholderplaceholder
placeholderplaceholderplaceholderplaceholderplaceholderplaceholder
placeholderplaceholderplaceholderplaceholderplaceholderplaceholder
=PLACEHOLDER
-----END PGP PUBLIC KEY BLOCK-----
```

> **Note:** The block above is a placeholder. Replace it with the real exported
> public key (`gpg --armor --export security@lumigift.com`) before public launch.

### Response SLA

| Stage | Target |
| ----- | ------ |
| Acknowledge receipt of report | within **24 hours** |
| Triage and severity assessment | within **5 business days** |
| Patch released | within **90 days** of acknowledgement |

We will keep you informed of progress throughout the process and coordinate
public disclosure with you once a fix is available.

### GitHub Security Advisories

GitHub security advisories are enabled on this repository. Maintainers may use
them to coordinate fixes and publish advisories for confirmed vulnerabilities.

## Scope

In scope:

- Smart contract vulnerabilities (fund loss, unauthorized claims)
- Authentication bypass
- API injection or data exposure
- Dependency vulnerabilities with known exploits

Out of scope:

- Social engineering
- Denial of service via resource exhaustion
- Issues requiring physical access to a device

## Smart Contract Assurance

The Soroban escrow contract (`contracts/escrow`) handles real-money USDC transactions and is subject to additional assurance activities:

- **Third-party audit**: The contract has been reviewed by an independent Soroban security firm (focus: reentrancy, auth bypass, TTL edge cases, integer overflow). All Critical/High findings have been resolved. The full report, including the remediation commit reference, is published in [`contracts/escrow/AUDIT_REPORT.md`](contracts/escrow/AUDIT_REPORT.md).
- **Fuzz testing**: Escrow state transitions are continuously fuzzed (amounts, timestamps, addresses) on a weekly CI schedule with a minimum 24h run. Results and fixed panics are documented in [`contracts/escrow/FUZZ_REPORT.md`](contracts/escrow/FUZZ_REPORT.md).
- **Upgrade governance**: Mainnet upgrades require admin authorization and are gated by multi-sig/time-lock controls. The operational process is documented in [`contracts/escrow/UPGRADE_RUNBOOK.md`](contracts/escrow/UPGRADE_RUNBOOK.md).

## Automated Vulnerability Scanning & Gates

All commits and pull requests targeting protected branches (`main`, `develop`) undergo continuous security scans:

- **npm**: Automated dependency audit & Trivy vulnerability scans
- **Cargo**: Automated Rust contract security audit (`cargo-audit`)
- **Docker**: Container vulnerability and CIS benchmark scans (`trivy`, `dockle`)
- **Terraform**: Infrastructure as Code misconfiguration scans (`trivy config`)

### Security Exceptions Policy

Critical/High vulnerabilities fail protected branches automatically. Temporary exceptions require designated owners and strict expiration dates tracked in [`.security-exceptions.json`](.security-exceptions.json). Expired exceptions immediately block builds. See [docs/ops/vulnerability-scanning.md](docs/ops/vulnerability-scanning.md) for details.

