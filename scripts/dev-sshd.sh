#!/bin/sh
# Throwaway SSH server on 127.0.0.1:2222 for trying AhsanDB's SSH tunnel locally.
# Runs as your user (no root), uses its own keys in ./.dev-sshd, never touches ~/.ssh. Ctrl+C stops it.
set -e
dir="$(cd "$(dirname "$0")/.." && pwd)/.dev-sshd"
mkdir -p "$dir"
[ -f "$dir/host_key" ] || ssh-keygen -q -t ed25519 -N '' -f "$dir/host_key"
[ -f "$dir/client_key" ] || ssh-keygen -q -t ed25519 -N '' -f "$dir/client_key"
cp "$dir/client_key.pub" "$dir/authorized_keys"
cat > "$dir/sshd_config" <<CFG
Port 2222
ListenAddress 127.0.0.1
HostKey $dir/host_key
AuthorizedKeysFile $dir/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
PidFile $dir/sshd.pid
AllowTcpForwarding yes
CFG
echo "SSH tunnel settings for AhsanDB:"
echo "  SSH host: 127.0.0.1   Port: 2222   SSH user: $(whoami)"
echo "  Authentication: SSH key   Private key file: $dir/client_key"
echo "  Database host (as seen from the SSH server): localhost"
exec /usr/sbin/sshd -D -e -f "$dir/sshd_config"
