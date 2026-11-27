# Installing TIDAL in the car

Two components go on the head unit through the MGU Store ("Store", robertnisipeanu/mgu-store):

| Component | What it is | Runs as |
|---|---|---|
| `cmocan-tidal`, "TIDAL service" (a **tool**) | the service: the TIDAL login, the library, the player (`tidal-player`, an x86-64 program) | root; its internet as uid 13150 through mgu-uplink; the player as nobody (group `mgu_alsa`) |
| `cmocan_tidal`, "TIDAL" (an **app**) | the tile and the screens | its own app user; it talks only to the service's socket, so it needs no internet of its own |

The app **requires** the service and a renderer (`mgu-render`, or any renderer already installed), and the service
requires `mgu-deploy` and `mgu-uplink`: installing the app installs whatever of these is missing first. Both are
for iDrive 7 only (`mguHmi: ["ID7"]`).

Before the first install the car needs the Store itself (mgu-store's `mgu-install.js first-install`, which also puts
on `mgu-render` and `mgu-uplink`), and the uplink online (the phone's hotspot or tethering) for the login and music.

## Why this layout: the Store's catalog, in a release

The Store reads a repository in one of three layouts (mgu-store `docs/PUBLISHING.md`). This repository uses the
**catalog** layout, published as a GitHub release named `catalog`, and the same folder serves the USB stick:

| | Catalog release (used) | Repo tree (`mgu-repo.json`) | Plain release assets |
|---|---|---|---|
| The tool with its prebuilt player | yes: the tool kit is an asset | only with `tidal-player` (1.6 MB) **committed to git**, inside `native/cmocan-tidal/` | no: every asset is read as an app |
| The app without BMW's SDK | the package ships no `node_modules/oap-sdk`; the head unit generates it from a stock BMW app (its donor) at install | built on the head unit by `kit/tools/build.py` with the donor's SDK | as the catalog |
| Private repository | yes: each artifact at its asset's API address, downloaded with the car's token | yes (the whole repository's tarball, with the token) | yes |
| The app requires the tool and a renderer | yes (`requires` in `catalog.json`) | yes | no |
| Downloads checked | size and sha256 from `catalog.json` | no hash | size only |
| USB stick | the same folder, as it is | a copy of the checkout | the packages only, without the requirements |

The repo tree is what idrive7-apps and aurelmarius' apps use, and it would build the app on the head unit (fitted to
that unit's interface catalog by `build.py`), but it needs the player binary in git. That is the owner's decision;
until then there is no `mgu-repo.json` here (a repo tree without the tool could list the app but never install it).
What the off-unit build loses: `build.py` fits the app's SOME/IP manifest to the unit's own interface catalog only
when it builds on the unit; the Store's deploy tool still takes out interfaces the unit lacks altogether. The
interfaces this app uses are checked against the car's catalog in task D9.

**No BMW SDK anywhere (rule R10).** `make dist` gives `build.py` two placeholder files of ours in place of the SDK
and takes `node_modules/` out of the package again (`tools/dist_app.py`). The app's `javascript/app.js` is our
`main.js` as it is; the kit asks for `require('oap-sdk')` by name, and the deploy tool generates that module on the
head unit (mgu-store `deploy/README.md`, "Packages built elsewhere"). `make dist` runs that very step of mgu-store
(`tools/oap_link.js`) with mgu-store's made-up test donor to show it works on our package.

## 1. Build the packages (on the Mac)

```sh
make dist
```

Everything runs in Docker. It builds the player (`make player`, with its `check-target`), clones mgu-store at a fixed
commit into `build/mgu-store` (only its `deploy/hu`, `tools/oap_pack.js`, `tools/oap_link.js` and
`deploy/mgu-install.js` run, in Docker), and writes **`dist/idrive7-tidal/`**:

| File | What |
|---|---|
| `catalog.json` | the two components: versions, sizes, sha256, requirements, titles, the icon |
| `cmocan-tidal@<v>.tgz` | the tool kit, packed by mgu-store's `deploy/hu artifact` from `native/cmocan-tidal/component.json` (the player included) |
| `cmocan_tidal@<v>.tgz` | the app, an OAP package in npm format (`package/...`), without `node_modules/` |
| `cmocan_tidal.png` | the app's icon for the Store's list |

Then it checks them, and stops on the first failure: `check-target` on the player taken out of the tool kit, a
kingfisher scan of everything in both packages (unpacked), mgu-store's `usb-repo` on a scratch stick, mgu-store's
preparation of the app (above), and `tests/dist.test.js` on Node 8.9.4 and current Node (ids and versions, iDrive 7,
internet, R10, no token, account, TIDAL session or car address, the player byte for byte).

**Versions.** The car updates a component only to a higher version. `make release` (below) does it: every component
whose new package differs from the published one gets the next patch version (builds are byte-identical, so a
different package means a changed component; an unchanged one keeps its version and the car is not asked to
reinstall it). A new service version also raises the app's `requires`, so the app follows. A minor or major version
is raised by hand in `native/cmocan-tidal/component.json` and `service.js`, or `apps/cmocan_tidal/app.json`
(`tests/release.test.js` checks the files agree).

## 2. Publish to the private repository

```sh
gh auth status        # signed in with an account that may write this repository
make release          # on main, clean, level with GitHub
```

`make release` builds, bumps the patch of what changed (above), runs `make test`, commits and pushes the new versions
(both through the secret-scan hooks), then publishes with `tools/publish-catalog.sh`. When nothing changed since the
published release it stops and publishes nothing.

The publishing step makes the release `catalog` the first time (not "latest", not a draft), uploads the two packages
and the icon, then writes and uploads `catalog.json` with each artifact's API address, and removes assets it no
longer names. **Before any upload** it scans exactly what goes up with kingfisher (`tools/scan-dist.sh`: every file,
the packages unpacked), and the release's `catalog.json` again before it goes up: an upload is not a git push, so
the git hooks never see it. The release's tag `catalog` is made by GitHub on the default branch.

## 3. A read-only token for the car

The repository is private, so the car needs a token to read it. Make one that can do nothing but read this one
repository:

1. GitHub, **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Token name**: e.g. `car store, idrive7-tidal`. **Expiration**: up to a year (the car stops seeing updates when
   it expires; make a new one then). **Resource owner**: your account.
3. **Repository access: Only select repositories → `idrive7-tidal`.**
4. **Repository permissions: Contents → Read-only.** (Metadata → Read-only is added by itself.) Nothing else:
   no account permissions, no write.
5. Generate, and copy the token once. Keep it out of this repository and out of `reference/` notes.

Give it to the car in one of two ways (the Store never shows it again, and sends it only to api.github.com):

- **On the phone**: Store → Settings → turn on the phone page and scan its QR code (phone on the car's hotspot) →
  Tokens → paste it.
- **Over SSH** from the computer: `node mgu-install.js token --identity <root's key>` (mgu-store `deploy/README.md`,
  "token"; it asks for the token at a hidden prompt).

(The Store's "Sign in with GitHub" works too, once the GitHub App `mgu-store` is installed on this repository, but it
can read every repository it is installed on; the fine-grained token above reads only this one.)

## 4. Add the source and install

1. Car parked, ignition on, on stable power; the uplink online.
2. Store → **Settings → Add source** → `cosminmocan/idrive7-tidal` → choose **Releases**. The source shows `ok`
   (`auth-needed` means the token is missing or does not reach the repository).
3. Install **TIDAL** (the app). The Store installs the **TIDAL service** first (and `mgu-render` or `mgu-uplink` if
   they are missing), then the app.
4. **Restart the head unit** (Store → **Restart head unit**). A new tool's units start only after a restart (the
   head unit's recmgr reads its list at boot), and until then the Store shows the service as waiting for the next
   start. After the restart the service's socket is there and starts the service on the app's first request.
5. Open TIDAL: the QR code shows; scan it with the phone and approve the login on TIDAL's page.

## 5. Offline: from a USB stick

A stick formatted FAT32 or exFAT. Either:

- **What was published** (the stick then counts as the GitHub source: what it installs updates later from GitHub,
  and the other way round):

  ```sh
  make usb STICK=/Volumes/<stick> FROM=github:cosminmocan/idrive7-tidal
  ```

  It asks for the read-only token at a hidden prompt (mgu-store's `usb-repo` reads the release with it).

- **This checkout's build**, without publishing (`make dist` first):

  ```sh
  make usb STICK=/Volumes/<stick>
  ```

  This writes `mgu-repo/idrive7-tidal/` (the catalog folder as it is, with its requirements). It is a source of its
  own: what it installs is updated only from such a stick, and the GitHub source shows those components as installed
  from elsewhere. To move to the GitHub source later, remove both in the Store and install them from GitHub.

Both run `node mgu-install.js usb-repo` of mgu-store in Docker (no Node on the Mac). In the car: put the stick in,
the Store lists the source `usb:<label>/mgu-repo/idrive7-tidal` (or the copy of the GitHub source); install TIDAL as
in section 4 (the requirements come from the Store's own source when the stick does not have them, which needs the
uplink; `mgu-render` and `mgu-uplink` are normally there since the first install), and restart the head unit.

Package files alone also work (`usb-repo <stick> cmocan-tidal@<v>.tgz cmocan_tidal@<v>.tgz` writes
`mgu-repo/local/`), but that catalog carries no requirements: install the service first, then the app.

## 6. Removal

Store → remove **TIDAL** (the app), then the **TIDAL service** (it can be removed once no app requires it). The
service's removal runs `cleanup.js --remove` first (its socket and half-written files), then the deploy tool removes
`/var/opt/cmocan-tidal` with the state and the login, the units, the recmgr name and the uplink's uid entry (rule
R11). Restart the head unit. Car check K4 (WORKPLAN.md) lists what must be gone.

## What only the car can check

Task K2 (WORKPLAN.md section 8): that the source reads with the fine-grained token; that the Store installs the
service, the app and their requirements in that order and the deploy tool generates `oap-sdk` from the car's own
donor; that the app's tile shows after the restart; that the service starts from its socket and its uid 13150 has
internet through mgu-uplink (and 13150 is free on this car, S4); the QR login, favourites loading, `online`, and
offline within 10 s with the uplink unplugged. The same from a USB stick without internet.
