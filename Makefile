# cmocan-tidal. Everything runs in Docker; see WORKPLAN.md section 3.
.PHONY: test test-node8 test-node-current e2e player test-player hooks test-hooks release soak dist usb

test: test-node8 test-node-current

test-node8:
	@sh tools/run-tests.sh node8

test-node-current:
	@sh tools/run-tests.sh current

# the end-to-end test (task I1, tests/e2e.test.js): the fake TIDAL, the real service with its client.js child, the
# real player writing WAVs, the app's client and model; in the player's test image (ubuntu:18.04 amd64, Node 8.10),
# unprivileged. Not part of `make test` (there it skips)
e2e:
	@$(MAKE) -s -C native/tidal-player target
	@docker image inspect tidal-player-test:1 >/dev/null 2>&1 || sh native/tidal-player/build.sh image
	@sh tools/e2e/run.sh

# ---- the car app (stream D): the kit's build.py, preview.js and emu.js in Docker (Python 3 + Node 22) ----
# The image is made once from node:22-slim with python3 added. Without oap-sdk/ (BMW's SDK, never in the repository)
# the build is --preview-only: a staged app in dist/cmocan_tidal, no installable package.
.PHONY: app app-preview emu
KIT_IMAGE = cmocan-tidal-kit
KIT_IMAGE_MAKE = printf 'FROM node:22-slim\nRUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*\n' | docker build -q -t $(KIT_IMAGE) - >/dev/null
KIT_RUN = docker run --rm -e PYTHONDONTWRITEBYTECODE=1 -v "$(CURDIR):/w" -w /w $(KIT_IMAGE)
APP_BUILD = if [ -f oap-sdk/index.js ]; then python3 kit/tools/build.py cmocan_tidal; else python3 kit/tools/build.py --preview-only cmocan_tidal; fi

app:
	@$(KIT_IMAGE_MAKE)
	@$(KIT_RUN) sh -c '$(APP_BUILD)'

# preview/cmocan_tidal/main_gfx-*.png: the built app on the kit's stubbed head unit, talking to the fake service
# (tests/fakes/fake_service.js, logged in); preview/screens/screen-*.png: every screen in every state (tools/screens.js)
app-preview:
	@$(KIT_IMAGE_MAKE)
	@$(KIT_RUN) sh -c 'python3 kit/tools/build.py --preview-only cmocan_tidal && rm -rf preview/cmocan_tidal preview/screens \
		&& (node -e "require(\"./tests/fakes/fake_service\").createFakeService({ socketPath: \"/tmp/cmocan-preview.sock\", state: { login: \"logged-in\" } })" & sleep 1; \
		    CMOCAN_TIDAL_SOCK=/tmp/cmocan-preview.sock node kit/tools/preview.js dist/cmocan_tidal preview/cmocan_tidal wait=2 render) \
		&& node tools/screens.js preview/screens >/dev/null && echo "preview/screens: $$(ls preview/screens | wc -l) pictures"'

# the kit's live emulator: http://localhost:8077 (Ctrl-C ends it), the app talking to the fake service (logged in;
# EMU_LOGIN=logged-out for the login screen)
EMU_LOGIN ?= logged-in
emu:
	@$(KIT_IMAGE_MAKE)
	@docker run --rm $$(test -t 0 && echo -it) --name cmocan-tidal-emu -e PYTHONDONTWRITEBYTECODE=1 -e CMOCAN_TIDAL_SOCK=/tmp/cmocan-emu.sock -p 127.0.0.1:8077:8078 -v "$(CURDIR):/w" -w /w $(KIT_IMAGE) sh -c \
		'node -e "require(\"./tests/fakes/fake_service\").createFakeService({ socketPath: \"/tmp/cmocan-emu.sock\", state: { login: \"$(EMU_LOGIN)\" } })" & \
		 exec node kit/tools/emu_forward.js 8078 8077 cmocan_tidal --port 8077'

# the player (stream B): built in Docker, ubuntu:18.04 amd64; see native/tidal-player/README.md
player:
	@$(MAKE) -s -C native/tidal-player target check-target

# the player's own tests (tests/player_*.test.js) against the real binary and its ASan/UBSan build, in
# ubuntu:18.04 amd64 with Node 8.10 (in `make test` they skip: node:8.9.4's glibc is too old for the binary)
test-player:
	@$(MAKE) -s -C native/tidal-player target asan
	@sh native/tidal-player/tools/test-player.sh

# the install packages (task I2, docs/INSTALL.md): dist/idrive7-tidal/ (catalog.json, the tool kit, the app, its
# icon), checked (check-target on the player inside, kingfisher, mgu-store's usb-repo, tests/dist.test.js); mgu-store
# is cloned into build/mgu-store at a fixed commit (MGU_STORE=<a checkout> to use another, tools/dist.sh)
dist: player
	@sh tools/dist.sh

# dist/idrive7-tidal onto a USB stick for the car's Store: make usb STICK=/Volumes/<name>; or the published release:
# make usb STICK=/Volumes/<name> FROM=github:<owner>/<repo> (asks for the read-only token)
usb:
	@sh tools/dist.sh usb "$(STICK)" "$(FROM)"

# the kingfisher secret scan on every commit and push (docs/SECRETS.md); run once after cloning
hooks:
	@git config core.hooksPath tools/git-hooks && echo "hooks installed: pre-commit and pre-push scan with kingfisher (docs/SECRETS.md)"

# the hooks against a scratch repository (needs kingfisher on this computer)
test-hooks:
	@sh tools/test-git-hooks.sh && sh tools/test-scan-dist.sh && sh tools/test-repo-email.sh

# build, bump the patch of what changed, test, commit, push, publish the Store's catalog release (tools/release.sh)
release:
	@sh tools/release.sh

# I3, the long run: 2 hours of the real service, client and player with random faults, detached (tools/e2e/soak.sh);
# the verdict lands in build/soak/report.json. A shorter one: make soak SOAK_SECONDS=600
SOAK_SECONDS ?= 7200
soak: player
	@sh tools/e2e/soak.sh $(SOAK_SECONDS)
