#!/usr/bin/env bash
set -e

if command -v mise >/dev/null 2>&1; then
  mise install
fi
