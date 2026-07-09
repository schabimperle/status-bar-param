#!/usr/bin/env bash
#
# Stand-in for a real cross-compile driver, used by the recorded demo tasks: they
# pass the selected `target` parameter as this script's first argument, and the GIF
# shows that value arriving here.
set -euo pipefail

echo "Building for ${1:-native}"
