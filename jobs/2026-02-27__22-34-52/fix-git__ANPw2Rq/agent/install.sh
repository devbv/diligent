#!/bin/bash
set -e

# Copy pre-built binary from mounted logs dir
cp /logs/agent/diligent-linux-x64 /installed-agent/diligent
chmod +x /installed-agent/diligent

# Install ripgrep (required by diligent's glob/grep tools)
apt-get update && apt-get install -y ripgrep

# Verify
/installed-agent/diligent --version
rg --version