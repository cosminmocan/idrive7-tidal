# cmocan-tidal. Everything runs in Docker; see WORKPLAN.md section 3.
.PHONY: test test-node8 test-node-current e2e player

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
