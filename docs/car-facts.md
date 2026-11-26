# Car facts (task S4)

Read-only commands only: nothing on the head unit is changed. Run them over SSH as root, car parked, ignition on.
Paste each output under its line. Leave out anything that identifies the car (VIN, keys, Wi-Fi names).

Date checked:

| # | Question | Command | Answer |
|---|---|---|---|
| 1 | Firmware version | `cat /etc/os-release; cat /etc/version 2>/dev/null` | |
| 2 | Node versions | `ls /usr/bin/node*; /usr/bin/node --version` | |
| 3 | Store installed, with renderer and uplink | `ls /var/opt/ \| grep -E 'mgu-(deploy\|updater\|render\|uplink)'` | |
| 4 | Uplink online | `cat /run/mgu-uplink/status.json` | |
| 5 | Sound group exists | `getent group mgu_alsa video audio` | |
| 6 | Who uses that group | `grep -rl mgu_alsa /etc/systemd /var/opt/*/current 2>/dev/null \| head` | |
| 7 | CarLife sound input exists | `aplay -L 2>/dev/null \| grep -i -A1 carlife; ls /etc/asound* /usr/share/alsa 2>/dev/null` | |
| 8 | Audio manager interfaces in the catalog | `grep -c -E 'org.genivi.am.commandinterface.CommandControl\|org.genivi.am.routinginterface.RoutingControlObserver' /etc/oap/someip/someip-interfaces.json` | |
| 9 | Internet uids already used by tools (we plan 13150: it must not be listed) | `ls /var/opt/mgu-uplink/uids.d/ 2>/dev/null; cat /var/opt/mgu-uplink/uids.d/* 2>/dev/null` | |

Also copy the catalog to the computer (it stays out of git: `reference/` is ignored):

```sh
scp root@<unit>:/etc/oap/someip/someip-interfaces.json reference/
```

If line 5 shows no `mgu_alsa`, or line 7 shows no CarLife device: stop, the sound path must be re-planned (WORKPLAN.md, risk 2).
