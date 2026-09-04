#!/usr/bin/env bash
# Retired: this script predated coordinated MiniCLOB -> Hybrid cutover. It
# assumed globally fixed order ids, used an obsolete createMarket signature,
# loaded a credential implicitly, and exercised MiniCLOB after graduation
# without proving the operator handoff. Keeping those writes callable would be
# more dangerous than failing explicitly.
set -euo pipefail

printf '%s\n' \
  'arc-e2e-graduated-book.sh is retired.' \
  'Use scripts/preseed-demo-markets.sh --dry-run for deployment preflight.' \
  'Run coordinated live acceptance only through the backend/indexer/operator workflow.' >&2
exit 2
