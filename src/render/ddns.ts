/**
 * The records that point at this house rather than at this board.
 *
 * Almost every public name keel writes resolves to the board's LAN address:
 * a phone on the mesh resolves it wherever it is, reaches the LAN through the
 * routing peer, and the route's allowlist decides the rest. A name in
 * `publicHosts` is the exception and the reason `publicProxyIngress` opens 443
 * to the world for it — a device that has *not* joined the mesh yet has to
 * reach the coordinator over the internet, and an RFC1918 address gets it
 * nowhere.
 *
 * So those names carry the WAN address, and the WAN address is not something a
 * deploy can know: it is the ISP's to change, at an hour nobody chose. A record
 * written once is correct until it silently is not, and the failure surfaces at
 * the worst possible moment — away from home, trying to get back in, with the
 * one path in pointing somewhere else.
 *
 * Hence a timer rather than a resource. Pulumi declares which names are
 * WAN-facing (`/etc/keel/ddns.conf`) and hands over the credential; the board
 * keeps their contents true. One owner per record: the LAN-pointing ones are
 * Pulumi's, these are this unit's, and neither writes the other's.
 *
 * **IPv4 is asked of the internet, IPv6 is read from the interface.** They are
 * different questions. Behind NAT the board cannot see its own public v4, so
 * something outside has to say it; its v6 address is its own, and asking an
 * outside service would return whichever source address happened to be used —
 * a temporary one, if the host ever grows them. Reading the interface also
 * makes the record match what the router's pinhole was opened for, which is the
 * pairing that actually has to hold.
 */

import { MESH_INTERFACE } from "./mesh";
import { dedent, file, merge, script, type Tree } from "./tree";

/** Written by the deploy: the zone and which names are WAN-facing. */
export const DDNS_CONFIG_PATH = "/etc/keel/ddns.conf";

/** Sealed by the deploy, decrypted at boot by `keel-secrets`. */
export const DDNS_SECRETS_PATH = "/etc/secrets/ddns.env";

export const DDNS_SCRIPT_PATH = "/usr/lib/keel/ddns";
export const KEEL_DDNS_SERVICE = "keel-ddns.service";
export const KEEL_DDNS_TIMER = "keel-ddns.timer";

/**
 * The deploy layer's file. Written even when no name is WAN-facing, for the same
 * reason every other `/etc/keel` input is: a present-and-empty file and an
 * absent one have to converge alike, and the script treats both as "nothing to
 * do".
 */
export function renderDdnsConfig(zoneId: string, fqdns: readonly string[]): string {
  if (fqdns.length === 0) {
    return "# No vhost in this deployment is WAN-facing, so no record is maintained.\n";
  }
  return [`ZONE_ID=${zoneId}`, `NAMES=${[...fqdns].sort().join(" ")}`, ""].join("\n");
}

function ddnsScript(): Tree {
  return script(
    DDNS_SCRIPT_PATH,
    dedent(`
      #!/usr/bin/env python3
      """Keep the WAN-facing records in ${DDNS_CONFIG_PATH} pointing at this house.

      Quiet when nothing changed: a line is printed only when a record is
      written, so the journal holds the history of the address rather than a
      tick every quarter hour. Exits non-zero when the zone refuses a write,
      which is a credential or a permission problem and wants a person — the
      poller lists the failed unit. A lookup that simply could not reach the
      internet is not that, and leaves the next tick to try again.
      """

      import json
      import re
      import subprocess
      import sys
      import urllib.error
      import urllib.request

      CONFIG = "${DDNS_CONFIG_PATH}"
      API = "https://api.cloudflare.com/client/v4"
      # The overlay's own interface. Its addresses are this board's too, and
      # publishing one would point the world at an address only the mesh can
      # reach — which is the failure this file exists to prevent, inverted.
      MESH = "${MESH_INTERFACE}"
      TTL = 120


      def settings(path):
          found = {}
          try:
              with open(path) as handle:
                  for line in handle:
                      key, _, value = line.strip().partition("=")
                      if key and not key.startswith("#"):
                          found[key] = value
          except FileNotFoundError:
              pass
          return found


      def wan_v4():
          """What the internet sees. Behind NAT the board cannot know this."""
          for url in ("https://api4.ipify.org", "https://ipv4.icanhazip.com"):
              try:
                  with urllib.request.urlopen(url, timeout=15) as answer:
                      text = answer.read().decode().strip()
                  if re.match(r"^[0-9.]+$", text):
                      return text
              except OSError:
                  continue
          return None


      def wan_v6():
          """This board's own global address, read from the interface.

          Excludes the mesh's interface and unique-local addresses: both are
          global in form and reachable only from inside, so either would be a
          AAAA record that answers and then refuses every connection.
          """
          out = subprocess.run(
              ["ip", "-6", "-o", "addr", "show", "scope", "global"],
              capture_output=True,
              text=True,
              check=False,
          ).stdout
          for line in out.splitlines():
              parts = line.split()
              if len(parts) < 4 or parts[1] == MESH:
                  continue
              address = parts[3].split("/")[0]
              # fc00::/7 is unique-local; "deprecated" is an address on its way
              # out, which a record should never be pointed at.
              if address.lower().startswith(("fc", "fd")) or "deprecated" in line:
                  continue
              return address
          return None


      def call(token, path, method="GET", body=None):
          request = urllib.request.Request(
              API + path,
              data=None if body is None else json.dumps(body).encode(),
              headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
              method=method,
          )
          with urllib.request.urlopen(request, timeout=30) as answer:
              return json.loads(answer.read())


      def converge(token, zone, name, kind, address):
          """One record, written only when it does not already say this."""
          found = call(token, "/zones/%s/dns_records?name=%s&type=%s" % (zone, name, kind))
          records = found.get("result") or []
          body = {"type": kind, "name": name, "content": address, "ttl": TTL, "proxied": False,
                  "comment": "keel-ddns"}
          if not records:
              call(token, "/zones/%s/dns_records" % zone, "POST", body)
              print("keel-ddns: created %s %s -> %s" % (kind, name, address))
              return
          record = records[0]
          if record.get("content") == address:
              return
          call(token, "/zones/%s/dns_records/%s" % (zone, record["id"]), "PUT", body)
          print("keel-ddns: %s %s %s -> %s" % (kind, name, record.get("content"), address))


      def main():
          config = settings(CONFIG)
          names = [name for name in config.get("NAMES", "").split(" ") if name]
          zone = config.get("ZONE_ID", "")
          token = settings("${DDNS_SECRETS_PATH}").get("CF_TOKEN", "")
          if not names or not zone:
              return 0
          if not token:
              print("keel-ddns: no CF_TOKEN in ${DDNS_SECRETS_PATH}", file=sys.stderr)
              return 1

          addresses = [("A", wan_v4()), ("AAAA", wan_v6())]
          if all(address is None for _kind, address in addresses):
              print("keel-ddns: could not determine any address; leaving records alone",
                    file=sys.stderr)
              return 0

          for name in names:
              for kind, address in addresses:
                  if address is None:
                      continue
                  try:
                      converge(token, zone, name, kind, address)
                  except urllib.error.HTTPError as error:
                      # The zone's own message, not just the status. A bare 400
                      # says a write was refused and nothing about why — and the
                      # answers differ entirely: a token without edit rights, a
                      # name that is not in this zone, or a second record of the
                      # same type already holding the address being written.
                      # That last one happens on the very first run, while the
                      # deploy is still deleting the LAN-pointing record this
                      # name used to carry.
                      try:
                          detail = json.loads(error.read())
                          reason = "; ".join(
                              item.get("message", "") for item in detail.get("errors") or []
                          )
                      except (ValueError, OSError):
                          reason = ""
                      print("keel-ddns: %s %s refused: HTTP %d %s"
                            % (kind, name, error.code, reason or "(no message)"),
                            file=sys.stderr)
                      return 1
                  except OSError as error:
                      print("keel-ddns: %s %s unreachable: %s" % (kind, name, error),
                            file=sys.stderr)
                      return 0
          return 0


      if __name__ == "__main__":
          sys.exit(main())
    `),
  );
}

function serviceUnit(): Tree {
  return file(
    `/usr/lib/systemd/system/${KEEL_DDNS_SERVICE}`,
    dedent(`
      [Unit]
      Description=Point this house's WAN-facing records at its current address
      After=network-online.target time-sync.target ${"keel-secrets.service"}
      Wants=network-online.target

      [Service]
      Type=oneshot
      # A board with no sealed credential yet still runs and says nothing: the
      # dash is what keeps a first boot from failing on a file the deploy has
      # not written.
      EnvironmentFile=-${DDNS_SECRETS_PATH}
      ExecStart=${DDNS_SCRIPT_PATH}
    `),
  );
}

/**
 * Every quarter hour, and three minutes after a boot.
 *
 * Not `Persistent`: a tick the board slept through has nothing to catch up on,
 * because the next one reads the same address. `After=time-sync.target` is not
 * optional though — every call here is TLS, and a board whose clock is still at
 * the image's build date rejects the zone's certificate.
 */
function timerUnit(): Tree {
  return file(
    `/usr/lib/systemd/system/${KEEL_DDNS_TIMER}`,
    dedent(`
      [Unit]
      Description=Refresh the WAN-facing records every quarter hour
      After=time-sync.target

      [Timer]
      OnBootSec=3min
      OnUnitActiveSec=15min

      [Install]
      WantedBy=timers.target
    `),
  );
}

export function renderDdns(): Tree {
  return merge(ddnsScript(), serviceUnit(), timerUnit());
}
