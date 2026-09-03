import { ADMIN_GROUP, ADMIN_USER } from "../config/keel";
import { REQUIRED_BINARIES } from "../config/versions";
import { dedent, file, merge, script, type Tree } from "./tree";

/**
 * A configuration check the selftest runs. Declared beside the thing it is a
 * claim about and collected by `renderAll`, so an assertion and the file it
 * judges cannot drift apart.
 */
export type Validation = {
  label: string;
  /** Shell command; a non-zero exit means the configuration is bad. */
  command: string;
};

export const SELFTEST_PATH = "/usr/lib/keel/selftest";
export const GREENBOOT_HOOK_PATH = "/usr/lib/greenboot/check/required.d/50-keel-selftest.sh";
export const GREENBOOT_ADVISORY_PATH = "/usr/lib/greenboot/check/wanted.d/50-keel-advisory.sh";

/**
 * One self-test, four environments.
 *
 * The same script runs in a container (`image/test.sh`), in a QEMU boot, on the
 * device via greenboot at every boot, and by hand over ssh. That is the point: a
 * check that only exists in CI does not run on the board that actually has to
 * boot the image.
 *
 * `--static` skips everything needing a running system, so the identical
 * assertions can be made against an image that was never booted.
 *
 * Deliberately no `set -e`: this is a test harness, and it reports every failure
 * rather than the first one. POSIX sh, because greenboot runs it early.
 */
function selftest(
  requiredUnits: readonly string[],
  validations: readonly Validation[],
  advisories: readonly Validation[],
): Tree {
  const binaries = REQUIRED_BINARIES.join(" ");
  const units = requiredUnits.join(" ");

  // Each generated line carries the template's own indentation, because the
  // interpolation point sits at column zero — a multi-line block spliced into an
  // indented template gives its first line a different indent from the rest.
  const checkBlock = (items: readonly Validation[], indent: string): string =>
    items
      .map(({ label, command }) =>
        [
          `${indent}if ${command} >/dev/null 2>&1; then`,
          `${indent}    ok "${label}"`,
          `${indent}else`,
          `${indent}    fail "${label} rejected by: ${command}"`,
          `${indent}fi`,
        ].join("\n"),
      )
      .join("\n\n");

  const advisoryChecks = checkBlock(advisories, "          ");

  const validationChecks = validations
    .map(({ label, command }) =>
      [
        `      if ${command} >/dev/null 2>&1; then`,
        `          ok "${label}"`,
        `      else`,
        `          fail "${label} rejected by: ${command}"`,
        `      fi`,
      ].join("\n"),
    )
    .join("\n\n");

  return script(
    SELFTEST_PATH,
    dedent(`
      #!/bin/sh
      set -u

      # required  — the contract. A failure is a failed boot and, after retries,
      #             a rollback. Keep it precise.
      # static    — the subset that needs no running system.
      # advisory  — observations worth logging that must never trigger a
      #             rollback on their own.
      mode=required
      case "\${1:-}" in
          --static) mode=static ;;
          --advisory) mode=advisory ;;
      esac

      rc=0
      fail() { printf 'FAIL %s\\n' "$1"; rc=1; }
      ok() { printf 'ok   %s\\n' "$1"; }

      if [ "$mode" = advisory ]; then
          # zram needs a kernel device a container cannot be given, so the
          # condition is containerisation itself rather than a flag — on real
          # hardware a missing zram device is a genuine finding.
          if systemd-detect-virt --container --quiet; then
              ok "zram swap (skipped: container)"
          elif swapon --show=NAME --noheadings 2>/dev/null | grep -q zram; then
              ok "zram swap"
          else
              fail "zram swap absent"
          fi

          # A built disk image is a fixed size, so a card is only as large as
          # keel-growfs made it on first boot. Advisory rather than required: a
          # small root is a waste of a card, not a reason to refuse the image.
          # Measured at /sysroot, not /. On a bootc system / is a composefs with
          # no block device behind it, so asking about / reports the overlay and
          # says nothing about the card.
          if systemd-detect-virt --container --quiet; then
              ok "root filesystem size (skipped: container)"
          else
              root_src=$(findmnt --noheadings --output SOURCE /sysroot)
              part_bytes=$(lsblk --bytes --noheadings --output SIZE "$root_src" | head -1)
              fs_bytes=$(df --block-size=1 --output=size /sysroot | tail -1)
              if [ -n "$part_bytes" ] && [ "$fs_bytes" -ge "$(( part_bytes / 100 * 90 ))" ]; then
                  ok "root filesystem fills its partition"
              else
                  fail "root filesystem is $fs_bytes of $part_bytes bytes — did keel-growfs run?"
              fi
          fi

          # The identity from keel.conf on the ESP: a name, an account sshd will
          # admit, and at least one address range the packet filter admits.
          # Membership rather than mere existence, because the group is what
          # sshd and sudo match on — an admin account outside it can no more log
          # in than one that does not exist, and this advisory is what says so
          # while the card that fixes it is still in reach.
          # Advisory, because a card that was never given a keel.conf boots to
          # exactly this state and it is an image nobody has configured yet, not
          # an image to roll back. In a container there is no ESP and no loaded
          # ruleset to ask.
          if systemd-detect-virt --container --quiet; then
              ok "keel.conf applied (skipped: container)"
          else
              applied=1
              case "$(cat /etc/hostname 2>/dev/null)" in
                  ""|localhost|localhost.localdomain) applied=0 ;;
              esac
              id -nG ${ADMIN_USER} 2>/dev/null | tr ' ' '\\n' | grep -qx ${ADMIN_GROUP} || applied=0
              nft list set inet keel lan4 2>/dev/null | grep -q elements || applied=0
              if [ "$applied" = 1 ]; then
                  ok "keel.conf applied"
              else
                  fail "keel.conf not applied: no hostname, no ${ADMIN_USER} in ${ADMIN_GROUP}, or an empty lan4 set"
              fi
          fi

${advisoryChecks}

          # Advisory on purpose. A blanket "nothing failed" is too broad to be a
          # rollback trigger: one flaky unit would un-deploy a working image.
          failed=$(systemctl list-units --state=failed --no-legend --plain | awk '{ print $1 }')
          if [ -z "$failed" ]; then
              ok "no failed units"
          else
              fail "failed units: $(echo "$failed" | tr '\\n' ' ')"
          fi

          exit $rc
      fi

      # --- binaries the image must carry -------------------------------------
      for binary in ${binaries}; do
          if command -v "$binary" >/dev/null 2>&1; then
              ok "binary $binary"
          else
              fail "binary $binary missing"
          fi
      done

      # --- configuration parses ----------------------------------------------
      # Host keys are generated at first boot, so an unbooted image has none and
      # sshd refuses to run at all. A throwaway key checks the config by itself.
      sshd_ok=1
      if [ -f /etc/ssh/ssh_host_ed25519_key ]; then
          sshd -t -f /etc/ssh/sshd_config 2>/dev/null || sshd_ok=0
      else
          tmpkey=$(mktemp -u)
          ssh-keygen -q -t ed25519 -N '' -f "$tmpkey" 2>/dev/null || sshd_ok=0
          sshd -t -f /etc/ssh/sshd_config -h "$tmpkey" 2>/dev/null || sshd_ok=0
          rm -f "$tmpkey" "$tmpkey.pub"
      fi
      if [ "$sshd_ok" = 1 ]; then
          ok "sshd config"
      else
          fail "sshd config rejected by sshd -t"
      fi

      # A malformed drop-in makes sudo refuse *everything*, which on this host
      # means every device resource stops working and the way in to fix it is the
      # same sudo that just broke.
      if visudo -cf /etc/sudoers.d/keel-admin >/dev/null 2>&1; then
          ok "sudoers drop-in"
      else
          fail "sudoers drop-in rejected by visudo -c"
      fi

      if nft --check --file /usr/lib/keel/nftables/keel.nft >/dev/null 2>&1; then
          ok "nftables ruleset parses"
      else
          fail "nftables ruleset rejected by nft --check"
      fi

${validationChecks}

      if [ "$mode" = static ]; then
          exit $rc
      fi

      # --- runtime ------------------------------------------------------------
      # greenboot orders itself before boot-complete.target but not after these
      # units, so on a cold boot it can run while they are still starting. An
      # instantaneous check would fail a healthy image, three times, and roll it
      # back. One shared deadline, not one per unit: a genuinely broken service
      # should not multiply the wait by however many are listed.
      deadline=$(( $(date +%s) + 60 ))
      for unit in ${units}; do
          while ! systemctl is-active --quiet "$unit"; do
              if [ "$(date +%s)" -ge "$deadline" ]; then
                  break
              fi
              sleep 1
          done
      done

      for unit in ${units}; do
          # A quadlet-backed unit is materialised by a generator into
          # /run/systemd/generator, and podman cannot run one inside a container.
          # Detected by where the unit came from rather than by name, so the same
          # check stays strict on hardware and honest in the container tier.
          if systemd-detect-virt --container --quiet; then
              fragment=$(systemctl show --property=FragmentPath --value "$unit" 2>/dev/null)
              case "$fragment" in
                  /run/systemd/generator/*)
                      ok "unit $unit (skipped: quadlet in a container)"
                      continue
                      ;;
              esac
          fi
          if systemctl is-active --quiet "$unit"; then
              ok "unit $unit"
          else
              fail "unit $unit is $(systemctl is-active "$unit" 2>&1)"
          fi
      done

      # Parsing the ruleset is not the same claim as the ruleset being loaded.
      if nft list table inet keel >/dev/null 2>&1; then
          ok "nftables table loaded"
      else
          fail "nftables table inet keel not loaded"
      fi

      # Secrets are the silent failure mode: a service whose environment is empty
      # starts anyway and then misbehaves, so an undecrypted blob is a failed boot.
      # A blob present with no identity to open it is the same failure, one step
      # earlier, and worth naming separately.
      if ls /etc/secrets/*.age >/dev/null 2>&1 && [ ! -s /etc/keel/age.key ]; then
          fail "secret blobs present but /etc/keel/age.key is missing"
      fi
      for blob in /etc/secrets/*.age; do
          if [ ! -e "$blob" ]; then
              continue
          fi
          plain="\${blob%.age}"
          if [ -s "$plain" ]; then
              ok "secret $(basename "$plain")"
          else
              fail "secret $(basename "$plain") not decrypted"
          fi
      done

      exit $rc
    `),
  );
}

/**
 * Order greenboot after the units it is about to judge. Belt and braces with the
 * selftest's own wait: this removes the race in the common case, and the wait
 * covers a service that is slow to become ready rather than slow to be started.
 */
function greenbootOrdering(requiredUnits: readonly string[]): Tree {
  return file(
    "/usr/lib/systemd/system/greenboot-healthcheck.service.d/50-keel-after.conf",
    dedent(`
      [Unit]
      After=${requiredUnits.join(" ")}
    `),
  );
}

/**
 * greenboot runs every script in `required.d`; a nonzero exit marks the boot
 * failed. After `GREENBOOT_MAX_BOOT_ATTEMPTS` tries (3 by default) it rolls the
 * system back to the previous image — so a bad version bump un-deploys itself
 * with nobody watching.
 *
 * In `/usr/lib` rather than `/etc`, because this check is image content like the
 * distro's own checks, not local configuration.
 *
 * `greenboot-healthcheck.service` runs *before* `boot-complete.target`, which is
 * what lets a service order itself after a verdict rather than a guess.
 */
function greenbootHooks(): Tree {
  return merge(
    script(
      GREENBOOT_HOOK_PATH,
      dedent(`
        #!/bin/sh
        exec ${SELFTEST_PATH}
      `),
    ),
    // wanted.d: greenboot logs a failure here and carries on. The advisory
    // checks are the ones too broad to justify un-deploying a working image.
    script(
      GREENBOOT_ADVISORY_PATH,
      dedent(`
        #!/bin/sh
        exec ${SELFTEST_PATH} --advisory
      `),
    ),
  );
}

export function renderSelftest(
  requiredUnits: readonly string[],
  validations: readonly Validation[] = [],
  advisories: readonly Validation[] = [],
): Tree {
  return merge(
    selftest(requiredUnits, validations, advisories),
    greenbootHooks(),
    greenbootOrdering(requiredUnits),
  );
}
