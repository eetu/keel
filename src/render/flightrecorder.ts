import { dedent, file, merge, script, type Tree } from "./tree";

/**
 * Boot diagnostics written where they can be read without booting.
 *
 * The journal is volatile here, which is right for an SD card and useless for
 * debugging a board that will not come up. The ESP is the one filesystem on the
 * card that any machine can mount — it is FAT, so pulling the card and putting it
 * in a laptop is enough, with no Linux tooling and no loop mounts.
 *
 * The summary — bootc status, the failed-units list, greenboot's state, both
 * selftest runs, and warnings from this boot's journal — is written on every
 * boot, and is a few KB.
 * The full journal is written after it, appended to the same file, only when the
 * boot is bad: a failed unit exists, or a selftest invocation exited non-zero. A
 * healthy boot never pays for it; a crash-looping board still leaves the complete
 * record the summary alone would not.
 *
 * Two files, and the second is the one that matters. `keel-boot.log` is this
 * boot; `keel-boot.prev.log` is the one before it, rotated at start. A board that
 * boots, fails, and gets power-cycled would otherwise overwrite the only evidence
 * of what went wrong with the record of it going wrong again.
 *
 * A clock fires this, not boot success — a timer at `OnBootSec=`, with the
 * service carrying no `[Install]` of its own. The boot that must be recorded is
 * precisely the boot that does not finish: a required unit fails, greenboot's
 * healthcheck sits there retrying, `multi-user.target` is never reached, and
 * anything ordered after either of them never runs. Two minutes is chosen against
 * both ends — late enough that a healthy boot has settled and its journal is
 * worth a write, early enough that a wedged board is recorded well before anyone
 * power-cycles it. Firing once per boot is what keeps the SD write budget to the
 * one summary; `RemainAfterExit` holds the unit active afterwards, so a second
 * trigger would coalesce rather than rotate this boot's log away.
 *
 * Greenboot's verdict is therefore asked for rather than waited on, and the
 * absence of a verdict is itself the finding: a healthcheck still activating at
 * two minutes is a boot that is not going to complete.
 *
 * Nothing here helps if the failure is before systemd — for that the console is
 * the only witness, which is why first boot wants a monitor attached. UART is
 * enabled by config.txt (`image/pi-uboot.sh`), so a serial adapter on GPIO
 * 14/15 would capture that console too.
 */
export function renderFlightRecorder(): Tree {
  return merge(
    file(
      "/usr/lib/systemd/system/keel-flightrecorder.timer",
      dedent(`
        [Unit]
        Description=Record this boot to the ESP once the boot has had time to settle

        [Timer]
        OnBootSec=2min
        # One shot per boot, so there is no wakeup budget to save by batching it
        # with other timers — and a log whose timestamp is where it was promised
        # is worth more here than a coalesced wakeup.
        AccuracySec=1s

        [Install]
        WantedBy=timers.target
      `),
    ),
    file(
      "/usr/lib/systemd/system/keel-flightrecorder.service",
      dedent(`
        [Unit]
        Description=Write this boot's journal to the ESP for offline debugging
        # The ESP is all this needs, and /boot/efi is mounted before
        # local-fs.target. Ordering it after anything later would tie the record
        # of a bad boot to that boot going well.
        After=local-fs.target
        # Nothing gates this unit on a path under /boot/efi. A unit condition is
        # evaluated by PID 1 in init_t, and init_t holds getattr on the ESP's
        # dosfs_t but neither read nor write — so it would answer for a
        # filesystem it cannot open, and the answer would be yes. The script
        # asks instead, from the domain below.

        [Service]
        Type=oneshot
        RemainAfterExit=yes
        # That domain. A context= mount option cannot be set on a remount or a
        # bind, so relabelling the ESP is not available and the process moves
        # instead. Entering unconfined_t needs an entrypoint label, hence
        # /usr/bin (bin_t) rather than /usr/lib/keel (lib_t).
        SELinuxContext=system_u:system_r:unconfined_t:s0
        ExecStart=/usr/bin/keel-flightrecorder
      `),
    ),
    script(
      "/usr/bin/keel-flightrecorder",
      dedent(`
        #!/bin/sh
        set -eu

        esp=/boot/efi
        [ -d "$esp" ] || exit 0

        # Layouts differ on whether the ESP is mounted writable, so probe, open a
        # window only if one is needed, and put it back — a card left writable is
        # one whose bootloader an ordinary process can rewrite.
        opened=""
        if ! touch "$esp/.keel-writable" 2>/dev/null; then
            mount -o remount,rw "$esp" || mount -o remount,rw /boot
            opened=1
        fi
        rm -f "$esp/.keel-writable"

        close_esp() {
            if [ -n "$opened" ]; then
                sync
                mount -o remount,ro "$esp" 2>/dev/null || mount -o remount,ro /boot || true
            fi
        }
        trap close_esp EXIT

        # Rotate first: the previous boot's log is the interesting one when a
        # board is looping. An if, not \`test && mv\`, which under set -e would end
        # the script on the first boot, when there is nothing to rotate.
        if [ -f "$esp/keel-boot.log" ]; then
            mv -f "$esp/keel-boot.log" "$esp/keel-boot.prev.log"
        fi

        # Set inside the block below and read after it: a \`{ }\` group is not a
        # subshell, so the assignments survive to decide whether the full journal
        # gets appended.
        bad=0

        {
            echo "=== keel boot log: $(date -Is)"
            echo "=== bootc status"
            bootc status 2>&1 || echo "(bootc status failed)"
            echo
            echo "=== failed units"
            # \`x=$(cmd) || true\` is the set -e-safe way to capture output from a
            # command allowed to fail; the bare \`||\` on its own protects the
            # assignment without needing an if/else.
            failed=$(systemctl list-units --state=failed --no-legend --plain 2>&1) || true
            printf '%s\\n' "$failed"
            [ -n "$failed" ] && bad=1
            echo
            echo "=== greenboot"
            # Not waited on — this runs on a clock, so \`activating\` here is the
            # signal, and it is the one an ordering dependency would have cost.
            systemctl status greenboot-healthcheck.service --no-pager -n 20 2>&1 || true
            echo
            echo "=== selftest"
            if /usr/lib/keel/selftest; then :; else bad=1; fi
            echo
            echo "=== selftest, advisory"
            if /usr/lib/keel/selftest --advisory; then :; else bad=1; fi
            echo
            echo "=== journal, this boot, warnings and above"
            journalctl -b -p warning --no-pager 2>&1 || true
        } > "$esp/keel-boot.log" 2>&1

        # The full journal is the expensive write this file exists to avoid on a
        # boot that has nothing wrong with it. It only earns its place once
        # something above already said the boot was bad.
        if [ "$bad" = 1 ]; then
            {
                echo
                echo "=== journal, this boot, everything"
                journalctl -b --no-pager 2>&1 || true
            } >> "$esp/keel-boot.log" 2>&1
        fi

        # FAT has no ownership to fix, but the card may be pulled without a clean
        # shutdown, and an unflushed log is an empty one. close_esp syncs too, on
        # the way back to read-only.
        sync
      `),
    ),
  );
}
