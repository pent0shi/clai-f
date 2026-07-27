# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
|---------|--------------------|
| 3.x     | :white_check_mark: |
| 2.x     | :x:                |
| 1.x     | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please report them responsibly through one of the following channels:

### Preferred: GitHub Private Vulnerability Reporting

Use [GitHub's private vulnerability reporting](https://github.com/pentoshi007/clai/security/advisories/new) to submit a report directly. This ensures the report stays confidential until a fix is available.

### Alternative: Email

If you prefer email, contact **[pentoshi007](https://github.com/pentoshi007)** directly via GitHub. Please include the word **"SECURITY"** in the subject line.

## What to Include

To help us triage and respond quickly, please include:

- **Description** of the vulnerability
- **Type** of issue (e.g., command injection, path traversal, credential exposure, dependency vulnerability)
- **Affected component** (e.g., tool execution, provider key handling, scope enforcement)
- **Steps to reproduce** or a proof-of-concept
- **Impact** assessment — what an attacker could achieve
- **Suggested fix** (if you have one)

## Response Timeline

| Stage | Target |
|-------|--------|
| Acknowledgment | Within **48 hours** |
| Initial assessment | Within **5 business days** |
| Fix & disclosure | Within **90 days** (coordinated disclosure) |

We follow [coordinated vulnerability disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure) practices. We will work with you to understand and validate the issue, develop a fix, and coordinate public disclosure.

## Security-Related Design Decisions

clai includes several security-conscious features:

- **Safety gate classification** — every tool action is classified as `safe`, `confirm`, or `block`; destructive operations always require confirmation
- **Engagement scope enforcement** — authorized/excluded targets, allowed phases, rate and concurrency ceilings, redirect and DNS-rebinding escape detection
- **No credential storage in plaintext** — API keys are stored via the system keyring when available

## Recognition

We appreciate the security research community's efforts in helping keep clai and its users safe. Contributors who responsibly report valid security issues will be acknowledged in our release notes (unless they prefer to remain anonymous).

---

Thank you for helping keep **clai** and its users safe.
