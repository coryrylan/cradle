#!/usr/bin/env bash

if mise exec -- bun run format:fix && mise exec -- bun run ci; then
  echo "all checks pass"
else
  exit 2
fi
