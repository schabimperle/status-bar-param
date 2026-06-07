#!/usr/bin/env bash
# Configure passwordless SSH to localhost so a VS Code Remote-SSH window can
# connect to `ssh-remote+sbp-localhost`. Used by the remote smoke test (the
# `remote` CI job and local Linux runs). Idempotent.
#
# Set SBP_SSH_PORT to use a non-default port (e.g. when 22 is already taken
# locally); the `sbp-localhost` ssh-config alias points Remote-SSH at it.
set -euo pipefail

# this mutates host SSH state (packages, sshd, password, ~/.ssh keys/config):
# fine on an ephemeral CI runner, surprising on a dev machine. Require opt-in.
if [ "${CI:-}" != "true" ] && [ "${SBP_ALLOW_SSH_SETUP:-}" != "1" ]; then
    echo "refusing to modify host SSH state outside CI; set SBP_ALLOW_SSH_SETUP=1 to override" >&2
    exit 1
fi

me="$(id -un)"
port="${SBP_SSH_PORT:-22}"
alias_host='sbp-localhost'

# 1. ensure an SSH server is installed
if ! command -v sshd >/dev/null 2>&1 && [ ! -x /usr/sbin/sshd ]; then
    sudo apt-get update -y
    sudo apt-get install -y openssh-server
fi
sshd_bin="$(command -v sshd || echo /usr/sbin/sshd)"

# 2. sshd with UsePAM refuses pubkey login for accounts with a locked/empty
# password (typical for container/CI users). If so, set one so PAM's account
# stage passes — key auth is what we actually use. A normal account ("P") is
# left untouched.
if [ "$(sudo passwd -S "$me" 2>/dev/null | awk '{print $2}')" != "P" ]; then
    echo "$me:sbp-remote-test-$(date +%s)" | sudo chpasswd
fi

# 3. host keys + a daemon on the chosen port (ignored if one already listens)
sudo mkdir -p /run/sshd
sudo ssh-keygen -A
sudo "$sshd_bin" -p "$port" 2>/dev/null || true

# 4. passwordless key auth to localhost
mkdir -p ~/.ssh && chmod 700 ~/.ssh
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519
grep -qF "$(cat ~/.ssh/id_ed25519.pub)" ~/.ssh/authorized_keys 2>/dev/null \
    || cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# 5. ssh-config alias so Remote-SSH (and plain ssh) reach the right host/port
# without host-key prompts
touch ~/.ssh/config && chmod 600 ~/.ssh/config
if ! grep -q "^Host ${alias_host}\$" ~/.ssh/config; then
    cat >> ~/.ssh/config <<EOF
Host ${alias_host}
    HostName localhost
    Port ${port}
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking no
    UserKnownHostsFile /dev/null
EOF
fi

# 6. verify the connection works non-interactively
ssh -o BatchMode=yes "${alias_host}" 'echo ssh-localhost-ok'
