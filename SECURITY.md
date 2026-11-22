# Security

tuiline holds live messaging sessions and credentials on your machine, so security reports
are taken seriously.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub instead:
[**Report a vulnerability**](https://github.com/kuokuo123/tuiline/security/advisories/new).

Say what an attacker could do, and how to reproduce it. You'll get an answer within a week, and
credit in the advisory and the changelog if you'd like it.

## Supported versions

Fixes go into the latest release only. Update your checkout and follow [INSTALL.md](INSTALL.md).

## What counts

Things like: another local user or process reading the session or credentials, a message or
link from a chat that makes tuiline run something or touch files it shouldn't, the installer
fetching something other than a genuine release, or sensitive data in the log.

The Telegram app key in the npm package is readable by anyone who installs it, as with every
Telegram client that ships one. That's expected, and not a vulnerability.
