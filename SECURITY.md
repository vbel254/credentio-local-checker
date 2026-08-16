# Security Policy

## Scope

Credentio Local Checker is an experimental, loopback-only development tool. It is not designed to run as a public internet service or to process untrusted files on behalf of remote users.

## Safe use

- Keep the server bound to `127.0.0.1`.
- Do not expose it through port forwarding, a reverse proxy, or a public tunnel.
- Process sensitive media only on a computer you trust.
- Review raw C2PA metadata before copying it elsewhere; a manifest may contain information supplied by the file's creator.
- Keep Node.js, Xcode Command Line Tools, and the operating system updated.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature when it is available for the repository. Do not attach confidential media, credentials, private keys, access tokens, or personal information to a public issue.

For ordinary bugs that do not involve sensitive information, open a public GitHub issue with the minimum reproduction details required.
