#!/usr/bin/env python3
"""index_sequences — build data/index.json, the player's sequence library.

A browser cannot list a directory over HTTP, so the multi-sequence dropdown
needs a generated index. This scans a data directory for immediate subfolders
containing a `manifest.json` and writes a summary index beside them:

    data/
      index.json          <- written by this tool
      excavator/
        manifest.json
        frame_0001.sog ...
      bogdanFly/
        manifest.json
        frame_0001.sog ...

`convert.py` runs this automatically after a successful conversion, so in
normal use you never invoke it by hand. Run it directly after moving,
renaming, or deleting a sequence folder.

Usage:
  python tools/index_sequences.py --data ./data [--title "My Library"]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

INDEX_VERSION = 1
INDEX_NAME = "index.json"


def humanize(slug: str) -> str:
    """`bogdanFly` -> `Bogdan Fly`; `capy_fall` -> `Capy Fall`."""
    out, prev_lower = [], False
    for ch in slug.replace("_", " ").replace("-", " "):
        if ch.isupper() and prev_lower:
            out.append(" ")
        out.append(ch)
        prev_lower = ch.islower() or ch.isdigit()
    return " ".join(w[:1].upper() + w[1:] for w in "".join(out).split())


def summarize(seq_dir: Path) -> dict | None:
    """Read one sequence's manifest and reduce it to an index entry."""
    manifest_path = seq_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"  ! skipping {seq_dir.name}: unreadable manifest ({e})", file=sys.stderr)
        return None

    frames = manifest.get("frames") or []
    if not frames:
        print(f"  ! skipping {seq_dir.name}: manifest has no frames", file=sys.stderr)
        return None

    total_bytes = sum(int(f.get("bytes") or 0) for f in frames)
    temporal = manifest.get("temporal") or {}
    source = manifest.get("source") or {}
    encode = manifest.get("encode") or {}

    return {
        "id": seq_dir.name,
        # manifest.project is author-supplied and may be blank; fall back to a
        # readable form of the folder name so the dropdown is never empty.
        "name": manifest.get("project") or humanize(seq_dir.name),
        "manifest": f"{seq_dir.name}/manifest.json",
        # Non-empty baseUrl means the frames are served from another origin
        # (object storage) rather than published with the site. Recorded here
        # so the size budget can tell the two apart.
        "baseUrl": manifest.get("baseUrl") or "",
        "frameCount": len(frames),
        "splats": frames[0].get("splats"),
        "bytes": total_bytes,
        "playbackFps": temporal.get("playbackFps"),
        "durationSeconds": temporal.get("durationSeconds"),
        "shDegree": encode.get("shDegree"),
        "shPresent": source.get("shPresent"),
    }


def build(data_dir: Path, title: str | None = None) -> dict:
    entries = []
    for child in sorted(data_dir.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir():
            continue
        if not (child / "manifest.json").exists():
            continue
        entry = summarize(child)
        if entry:
            entries.append(entry)
    index = {"version": INDEX_VERSION, "sequences": entries}
    if title:
        index["title"] = title
    return index


def write(data_dir: Path, title: str | None = None, quiet: bool = False) -> dict:
    """Build and write index.json. Returns the index."""
    index = build(data_dir, title)
    path = data_dir / INDEX_NAME
    path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    if not quiet:
        n = len(index["sequences"])
        print(f"  index                : {path}  ({n} sequence{'s' if n != 1 else ''})")
        for s in index["sequences"]:
            mib = (s["bytes"] or 0) / 1048576
            print(f"      - {s['id']:<20} {s['frameCount']:>4} frames  "
                  f"{mib:8.1f} MiB  SH {s['shDegree']}")
    return index


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="index-sequences", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="./data", metavar="<dir>",
                    help="library directory to scan (default ./data)")
    ap.add_argument("--title", metavar="<str>", help="optional library title")
    args = ap.parse_args(argv)

    data_dir = Path(args.data)
    if not data_dir.is_dir():
        print(f"ERROR: {data_dir} is not a directory", file=sys.stderr)
        return 2

    index = write(data_dir, args.title)
    if index["sequences"]:
        # Same library-wide Pages budget report the converter prints.
        from convert import print_library_budget
        print_library_budget(index)
    if not index["sequences"]:
        print("\n  ! no sequences found. Each sequence needs its own subfolder\n"
              "    containing a manifest.json, e.g. data/excavator/manifest.json",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
