#!/usr/bin/env python3
"""Chronosplat — choose where a sequence's frames are served from.

Sets `baseUrl` in a sequence's manifest.json:

  empty  (default)  frames resolve relative to the manifest, i.e. published
                    with the site from the same origin. No CORS needed.
  a URL             frames are fetched from object storage (R2, S3, a CDN).
                    The manifest itself still ships with the site.

Only the `.sog` frames move. manifest.json stays in the repository either way,
so it remains version-controlled and Save Scene keeps working.

  py tools/set_host.py capyFall --url https://data.example.com/capyFall/
  py tools/set_host.py capyFall --local
  py tools/set_host.py --list

After changing this, rebuild the index so the size budget reflects it:

  py tools/index_sequences.py --data ./data
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, manifest: dict) -> None:
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="chronosplat set-host",
        description="Set where a sequence's frames are served from.")
    ap.add_argument("sequence", nargs="?", help="folder name under data/")
    ap.add_argument("--data", default="./data", metavar="<dir>")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--url", metavar="<url>",
                   help="serve frames from this base URL (trailing / optional)")
    g.add_argument("--local", action="store_true",
                   help="clear baseUrl; publish frames with the site")
    ap.add_argument("--list", action="store_true",
                    help="show where every sequence is served from")
    args = ap.parse_args()

    root = Path(args.data)
    if not root.is_dir():
        print(f"error: {root} is not a directory", file=sys.stderr)
        return 2

    if args.list or not args.sequence:
        print(f"\n  {'sequence':<20} {'frames served from':<12}")
        for d in sorted(p for p in root.iterdir() if p.is_dir()):
            mf = d / "manifest.json"
            if not mf.is_file():
                continue
            base = load(mf).get("baseUrl") or ""
            print(f"  {d.name:<20} {base or 'published with the site'}")
        print()
        return 0

    seq_dir = root / args.sequence
    manifest_path = seq_dir / "manifest.json"
    if not manifest_path.is_file():
        print(f"error: {manifest_path} not found", file=sys.stderr)
        return 2

    if not args.url and not args.local:
        print(f"  {args.sequence}: "
              f"{load(manifest_path).get('baseUrl') or 'published with the site'}")
        return 0

    manifest = load(manifest_path)
    if args.local:
        manifest["baseUrl"] = ""
        where = "published with the site"
    else:
        # A base URL without a trailing slash would make the browser resolve
        # frame names against its parent directory, silently 404ing every frame.
        url = args.url if args.url.endswith("/") else args.url + "/"
        manifest["baseUrl"] = url
        where = url

    save(manifest_path, manifest)
    print(f"  {args.sequence}: frames now served from {where}")

    if not args.local:
        n = len(manifest.get("frames") or [])
        print(f"\n  Upload the {n} .sog files in {seq_dir} to that location,")
        print(f"  and make sure the bucket allows cross-origin GET with Range.")
    print("\n  Then: py tools/index_sequences.py --data ./data")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
