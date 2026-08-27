# Security policy

## Supported versions

Security fixes are applied to the latest release and the default branch. Container releases are
published from immutable `v*` Git tags only after the quality and production dependency gates pass.

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities or exposed credentials. Use GitHub's
private vulnerability reporting feature for this repository. Include the affected component,
reproduction steps, impact, and any suggested mitigation.

## Automated controls

- Production npm dependencies are audited on every push and pull request.
- Pull requests receive dependency-diff review with a high-severity failure threshold.
- Runtime images are scanned with Trivy; fixable critical vulnerabilities block CI.
- Release images include BuildKit provenance and an SBOM and are published to GHCR.
- Dependabot groups weekly npm and GitHub Actions updates.
- Secrets are supplied through GitHub Actions secrets and are never embedded in release images.
