/**
 * The SELinux state the image's services need and the image cannot carry.
 *
 * Two facts live in the policy store under /var/lib/selinux, which on bootc is
 * machine-local and scrubbed from the image: a port label and a boolean. Neither
 * can be applied at build time, so both are applied on the machine, on every
 * boot, by the tools that apply them — and each is converged rather than set,
 * because a policy commit is seconds of CPU on a Pi and this runs at every boot.
 *
 * **unbound's port.** The policy only lets unbound bind ports labelled
 * `dns_port_t` — 53 and 853 are, 5335 is not, and the failure is `can't bind
 * socket: Permission denied` on the host that is the LAN's resolver.
 *
 * **CIFS in a container.** container-selinux lets `container_t` touch `cifs_t`
 * only under `virt_use_samba`, which is off by default. Without it a share
 * mounts fine and every file in it answers a container with `Permission denied`
 * — a music server with an empty library, a deploy that looked clean.
 *
 * There is no `ConditionPathExists=` on either tool, and its absence is the
 * point. A condition on the very tool the unit exists to run turns a broken
 * image into a skipped unit: nothing fails, nothing is logged, and the first
 * evidence is a service that cannot bind or cannot read. A condition may gate a
 * step the system does not need; it may never gate the step that makes the
 * system work. `ConditionSecurity` is the legitimate case of the same shape —
 * with SELinux off there is nothing to label and nothing to allow.
 */

import { UNBOUND } from "../config/keel";
import { dedent, file, merge, script, type Tree } from "./tree";

export const SELINUX_UNIT = "keel-selinux.service";

export function renderSelinux(): Tree {
  return merge(
    file(
      `/usr/lib/systemd/system/${SELINUX_UNIT}`,
      dedent(`
        [Unit]
        Description=Converge the SELinux port label and boolean the image's services need
        Before=unbound.service
        ConditionSecurity=selinux

        [Service]
        Type=oneshot
        RemainAfterExit=yes
        ExecStart=/usr/lib/keel/converge-selinux

        [Install]
        WantedBy=multi-user.target
      `),
    ),
    script(
      "/usr/lib/keel/converge-selinux",
      dedent(`
        #!/bin/sh
        set -eu

        port=${UNBOUND.port}

        # Every write below commits the whole policy, which is half a minute of
        # CPU on a Pi 4 — and unbound, and so the LAN's resolver, waits on this
        # unit. So each fact is asked for before it is written, and a boot that
        # changes nothing costs a few reads.

        # 53 is labelled out of the box, so there is nothing to do and semanage
        # would refuse anyway.
        if [ "$port" != "53" ]; then
            for proto in udp tcp; do
                # The store's own record of local port labels, read directly:
                # asking semanage to list them loads the whole policy into
                # python first, eight seconds per question on a Pi 4. A store
                # without the file has no local labels yet, and falls through.
                grep -qsE "^portcon $proto $port " /etc/selinux/targeted/active/ports.local && continue
                # Convergence in two verbs, because semanage has no single
                # idempotent one: -a is an error on a port already in local
                # policy, -m an error on a port that is not there yet. The add's
                # complaint is the expected case and is swallowed; the modify's is
                # not, so a policy store that genuinely cannot be written fails
                # the unit where it can be seen.
                semanage port -a -t dns_port_t -p "$proto" "$port" 2>/dev/null ||
                    semanage port -m -t dns_port_t -p "$proto" "$port"
            done
        fi

        [ "$(getsebool virt_use_samba)" = "virt_use_samba --> on" ] ||
            setsebool -P virt_use_samba on
      `),
    ),
  );
}
