# cmocan-tidal. Everything runs in Docker; see WORKPLAN.md section 3.
.PHONY: test test-node8 test-node-current e2e player test-player

test: test-node8 test-node-current

test-node8:
	@sh tools/run-tests.sh node8

test-node-current:
	@sh tools/run-tests.sh current

e2e:
	@echo "make e2e: not written yet (task I1)"; exit 1

# the player (stream B): built in Docker, ubuntu:18.04 amd64; see native/tidal-player/README.md
player:
	@$(MAKE) -s -C native/tidal-player target check-target

# the player's own tests (tests/player_*.test.js) against the real binary and its ASan/UBSan build, in
# ubuntu:18.04 amd64 with Node 8.10 (in `make test` they skip: node:8.9.4's glibc is too old for the binary)
test-player:
	@$(MAKE) -s -C native/tidal-player target asan
	@sh native/tidal-player/tools/test-player.sh
