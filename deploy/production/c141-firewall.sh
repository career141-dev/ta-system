#!/usr/bin/env bash
# Keep the database ports off the internet.
#
# Docker publishes container ports through its own NAT rules, which pass before
# ufw ever sees them — so "ufw default deny" did not cover the Convex backend
# (3210/3211), its dashboard (6791) or Qdrant (6333/6334): all answered on the
# public IP (found 21 Sep). DOCKER-USER is the chain Docker leaves for this.
# Traffic arriving on the public interface for these ports is dropped; the
# same ports on 127.0.0.1 (Caddy, SSH tunnels) and between containers are
# untouched. Idempotent; run at boot by c141-firewall.service.
set -euo pipefail

IFACE="${IFACE:-eth0}"
PORTS=(3210 3211 6791 6333 6334)

for tool in iptables ip6tables; do
  "$tool" -S DOCKER-USER >/dev/null 2>&1 || "$tool" -N DOCKER-USER
  for p in "${PORTS[@]}"; do
    rule=(-i "$IFACE" -p tcp -m conntrack --ctorigdstport "$p" -j DROP)
    "$tool" -C DOCKER-USER "${rule[@]}" 2>/dev/null || "$tool" -I DOCKER-USER "${rule[@]}"
  done
done
echo "Blocked on $IFACE: ${PORTS[*]}"
