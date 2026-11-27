# Secrets: how they are kept out of git

Every commit and every push is scanned with [kingfisher](https://github.com/mongodb/kingfisher) (installed locally,
`brew install kingfisher`), by two git hooks in `tools/git-hooks/`:

| Hook | Scans | Blocks |
|---|---|---|
| `pre-commit` | the staged changes | the commit |
| `pre-push` | a fresh clone of every branch, whole history (only what is in git: git-ignored local files are never scanned there and never pushed) | the push |

Both run kingfisher with `--no-validate` (a finding is never sent to any service to test it) and `--redact` (no
secret's value is ever printed). If kingfisher is missing or fails, they refuse: a scan that did not run never lets
anything by.

**Install after cloning:** `make hooks` (it sets `git config core.hooksPath tools/git-hooks`). **Test the hooks:**
`make test-hooks` (a scratch repository: a clean commit passes, a private key is blocked at commit and at push, the
assessed test keys pass).

## When a hook blocks

Assess every finding:

- **A real secret** (a token, a password, a key that protects anything real): it must not be committed. Unstage it,
  move it to a git-ignored place (`reference/` for anything from the car or an account), and commit again. If it is
  already in a commit that is not pushed, rewrite that commit before pushing. If it was ever pushed: revoke or
  rotate it first, then clean the history.
- **Not a secret** (a test fixture, an example in third-party code): add a row to the table below with the reason,
  then add its fingerprints to `tools/kingfisher-baseline.yaml` (below). Nothing goes into the baseline without a row
  here.

## Assessed findings (in the baseline)

| File | Rule | Assessment |
|---|---|---|
| `tests/fixtures/tidal/TEST-ONLY-server.key` | private key | The key of a test certificate for `tidal.test` (a name reserved for testing, RFC 2606, that cannot exist on the internet), signed by a CA made only for the tests (`TEST-ONLY-ca.pem`, "cmocan-tidal TEST-ONLY ca"). Nothing outside `tests/netx.test.js` trusts it. Used by the fake TLS server. **Not a secret.** |
| `tests/fixtures/tidal/TEST-ONLY-rogue-server.key` | private key | The same for the "rogue" test server, signed by a second test-only CA, so the test can check that a server signed by an unknown CA is refused. **Not a secret.** |

## Findings outside git (never committed, never pushed)

Seen when kingfisher scans the folder itself (not by the hooks, which scan only what is in git):

| File | Why it is safe |
|---|---|
| `reference/live-check/session.json` | **A real TIDAL login** (access and refresh tokens), for live checks against TIDAL. Git-ignored (`reference/`), mode 0600, in no commit on any branch (checked 2026-11-27). Must stay that way |
| `native/tidal-player/build/ffmpeg-*.tar.gz` (`tests/ref/fate/url`) | FFmpeg's own test data: example URLs with a user and password. Third-party, in the git-ignored build folder |

## Regenerating the baseline

Fingerprints depend on the content, and kingfisher keys them by the scanned path, so the baseline is a template:
`@REPO@` is filled in by `tools/git-hooks/kingfisher-scan` with the path it scans. To add an assessed finding, scan
a clone with `--manage-baseline` and copy its entries (path, fingerprint, rule), both the working-tree one (under
`local://@REPO@`) and the git one (under `local://@REPO@/.git`, which staged scans also use), into the template.

History: 2026-11-27, first full scan of every branch already on GitHub (pushed before these hooks existed): the two
test keys above were the only findings in git.
