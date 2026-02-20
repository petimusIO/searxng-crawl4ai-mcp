#!/bin/sh
set -euo pipefail
CFG="./searxng-settings.yml"

if [ ! -e "$CFG" ]; then
  echo "ERROR: $CFG does not exist. Create a regular file named 'searxng-settings.yml' in the repo root."
  exit 2
fi

if [ -d "$CFG" ]; then
  echo "ERROR: $CFG is a directory (must be a regular file)."
  echo "Remove the directory and place the settings YAML file at ./searxng-settings.yml"
  exit 2
fi

if [ ! -s "$CFG" ]; then
  echo "ERROR: $CFG is empty. Fill it with the SearXNG settings YAML (see searxng-settings.yml in repo)."
  exit 2
fi

echo "OK: $CFG exists and looks valid."