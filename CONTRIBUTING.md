# Contributing to tuiline

Thanks for taking a look. Bug reports, fixes, features, themes and docs are all welcome — open a
pull request, or an issue if you'd like to talk something through first.

## Setting up

You need Node.js 26.4 or newer and Go 1.26+. With [mise](https://mise.jdx.dev), `mise install` in the repo
picks up the version from `mise.toml`.

```sh
git clone https://github.com/kuokuo123/tuiline.git
cd tuiline
npm install
npm run build:line
npm run dev
```

`npm run dev` launches the LINE client. Sign in through the QR flow described in
[README.md](README.md). The original Telegram client is available with `npm run dev:telegram`.

The legacy Telegram client uses the same saved configuration as its upstream client. To keep them apart,
give the dev copy its own directories:

```sh
export XDG_CONFIG_HOME=~/tuiline-dev/config XDG_DATA_HOME=~/tuiline-dev/data
export XDG_STATE_HOME=~/tuiline-dev/state XDG_CACHE_HOME=~/tuiline-dev/cache
npm run dev:telegram
```

LINE login diagnostics are written to `./tuiline-login.log`. Legacy Telegram logs remain at
`$XDG_STATE_HOME/tuigram/tuigram.log` (or wherever `TUILINE_LOG` / legacy `TUIGRAM_LOG` points).

## Finding your way around

`line-tui/` contains the LINE interface and `backend/` its Go backend. The legacy Telegram
client lives in `src/`, which has no imports: the directory tree is the wiring. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before your first change — it's short, and it
explains how files become modules and which layer does what.

## Checks

CI runs all four on every pull request:

```sh
npm run fmt:check   # Prettier; `npm run fmt` fixes it
npm run lint        # ESLint
npm run types       # tsc over src/, via JSDoc
npm test            # the integration tests
```

## Tests

LINE tests cover helpers, headless UI interactions and the demo backend. Legacy Telegram
integration tests boot the app against a fake Telegram and a headless terminal.
[docs/TESTING.md](docs/TESTING.md) describes those integration tests.

A bug fix should come with a test that fails without it, where the test world can reach the bug.

## Pull requests

- Keep one change per pull request; a fix and an unrelated refactor are easier to review apart.
- For anything a user would notice, add a line under `## [Unreleased]` in
  [CHANGELOG.md](CHANGELOG.md), written for users rather than developers.
- If you change a key, a config option or a file location, update the README's tables too.
- Commit messages are short, lowercase and say what the change does, like `run the tests in ci`.

## Reporting a bug

Open an [issue](https://github.com/kuokuo123/tuiline/issues) with `tuiline --version`, how
you installed it, your OS and terminal, and what you did and saw. The log
(`./tuiline-login.log` for LINE login diagnostics) usually says what went wrong; read it for
anything private before you attach it.

Security problems go through [SECURITY.md](SECURITY.md) instead, not a public issue.

## Licence

By contributing you agree that your work is released under the [MIT License](LICENSE).
