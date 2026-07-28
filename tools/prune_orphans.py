#!/usr/bin/env python3
"""Chronosplat — find (and optionally delete) frame files no manifest lists.

Re-converting a sequence at a coarser --frame-step writes fewer frames than the
previous run left behind. Those leftovers are not referenced by any manifest, so
the converter's size report does not count them and the player never loads them
— but they still sit in data/ and Git would commit them permanently.

convert.py sweeps its own output directory after each run, so sequences
converted since that behaviour existed are already clean. This catches older
ones, and doubles as a pre-commit check.

Reports by default. Pass --delete to actually remove.

  py tools/prune_orphans.py
  py tools/prune_orphans.py --delete
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def orphans_for(seq_dir: Path) -> tuple[list[Path], int]:
    """Frame files present on disk but absent from the manifest's frame list."""
    manifest = seq_dir / "manifest.json"
    if not manifest.is_file():
        return [], 0
    data = json.loads(manifest.read_text(encoding="utf-8"))
    listed = {f["file"] for f in data.get("frames", []) if isinstance(f, dict)}
    if not listed:
        # An empty frame list would make every file look orphaned. Refuse to
        # guess rather than delete a whole sequence.
        print(f"  WARNING: {manifest} lists no frames; skipping.", file=sys.stderr)
        return [], 0
    found = sorted(p for p in seq_dir.glob("frame_*.sog") if p.name not in listed)
    return found, sum(p.stat().st_size for p in found)


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="chronosplat prune-orphans",
        description="Remove frame files that no manifest references.")
    ap.add_argument("--data", default="./data", metavar="<dir>",
                    help="library root (default: ./data)")
    ap.add_argument("--delete", action="store_true",
                    help="actually delete; without this, only reports")
    args = ap.parse_args()

    root = Path(args.data)
    if not root.is_dir():
        print(f"error: {root} is not a directory", file=sys.stderr)
        return 2

    total_bytes = 0
    total_files = 0
    for seq_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        found, nbytes = orphans_for(seq_dir)
        if not found:
            continue
        total_files += len(found)
        total_bytes += nbytes
        print(f"  {seq_dir.name:<16} {len(found):>4} orphaned  "
              f"{nbytes / 1024 / 1024:>8.1f} MiB   "
              f"{found[0].name} .. {found[-1].name}")
        if args.delete:
            for p in found:
                p.unlink()

    if not total_files:
        print("  no orphaned frames — data/ matches the manifests.")
        return 0

    verb = "deleted" if args.delete else "would free"
    print(f"\n  {verb}: {total_files} files, {total_bytes / 1024 / 1024:.1f} MiB")
    if not args.delete:
        print("  re-run with --delete to remove them.")
    else:
        print("  run tools/index_sequences.py to refresh data/index.json.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
