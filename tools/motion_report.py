#!/usr/bin/env python3
"""motion_report — report where a 3DGS PLY sequence actually moves.

Why this exists: the SH check requires orbiting a MOVING part
across at least two well-separated frames. "Well-separated in index" is not the
same as "well-separated in motion" — the reference Excavator sequence is
static for frames 1-13, animates over roughly 14-44, then returns to exactly
frame 1 by frame 59. Comparing frame 1 against frame 59 there compares two
identical frames and proves nothing.

This tool tells you which frames to inspect, and doubles as a sanity check on
whether a sequence is worth its frame count (long static runs are pure hosting
cost in a flipbook player).

Requires numpy. Reads only the x/y/z columns via a strided memory map, but it
does touch every frame, so it is I/O-bound on large sequences — use --step to
sample.

Usage:
  python tools/motion_report.py --input <dir|glob> [--step 1] [--json out.json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

from convert import ConvertError, build_frames, discover  # noqa: E402
from ply_schema import PLY_TYPES  # noqa: E402

MOVED_EPS = 1e-6


def load_xyz(schema):
    import numpy as np

    offsets, running = {}, 0
    for p in schema.vertex.properties:
        offsets[p.name] = running
        running += p.size
    for axis in ("x", "y", "z"):
        if axis not in offsets:
            raise ConvertError(f"{schema.path.name}: missing {axis} property")

    dtype = np.dtype({
        "names": ["x", "y", "z"],
        "formats": [np.dtype(PLY_TYPES[next(q.type for q in schema.vertex.properties
                                            if q.name == a)][0]) for a in ("x", "y", "z")],
        "offsets": [offsets["x"], offsets["y"], offsets["z"]],
        "itemsize": schema.stride,
    })
    mm = np.memmap(schema.path, dtype=dtype, mode="r",
                   offset=schema.header_bytes, shape=(schema.splat_count,))
    return np.stack([mm["x"], mm["y"], mm["z"]], axis=1).astype(np.float64)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="motion-report",
                                 description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, metavar="<dir|glob>")
    ap.add_argument("--step", type=int, default=1,
                    help="sample every Nth frame (default 1 = all)")
    ap.add_argument("--json", metavar="<path>", help="also write the report as JSON")
    args = ap.parse_args(argv)

    try:
        import numpy as np  # noqa: F401
    except ImportError:
        print("ERROR: motion_report requires numpy (pip install numpy)", file=sys.stderr)
        return 2

    try:
        frames = build_frames(discover(args.input))
    except ConvertError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2

    sampled = frames[:: max(1, args.step)]
    print(f"motion-report — {len(frames)} frames, sampling {len(sampled)}\n")

    import numpy as np

    ref = load_xyz(sampled[0].schema)
    prev = ref
    rows = []
    print(f"{'src':>5}  {'moved% vs f1':>12}  {'max vs f1':>10}  {'max vs prev':>11}")
    print("  " + "-" * 44)
    for fr in sampled:
        cur = ref if fr is sampled[0] else load_xyz(fr.schema)
        d_ref = np.linalg.norm(cur - ref, axis=1)
        d_prev = np.linalg.norm(cur - prev, axis=1)
        row = {
            "sourceIndex": fr.source_index,
            "movedFractionVsFirst": float((d_ref > MOVED_EPS).mean()),
            "maxDeltaVsFirst": float(d_ref.max()),
            "maxDeltaVsPrev": float(d_prev.max()),
        }
        rows.append(row)
        print(f"{fr.source_index:>5}  {row['movedFractionVsFirst'] * 100:11.2f}%  "
              f"{row['maxDeltaVsFirst']:10.4f}  {row['maxDeltaVsPrev']:11.4f}")
        prev = cur

    moving = [r["sourceIndex"] for r in rows if r["maxDeltaVsFirst"] > MOVED_EPS]
    static_head = [r["sourceIndex"] for r in rows if r["maxDeltaVsFirst"] <= MOVED_EPS]

    print("\nsummary")
    if moving:
        print(f"  frames with motion : {min(moving)}..{max(moving)} "
              f"({len(moving)} of {len(rows)} sampled)")
        # Rank by displacement so the reviewer has concrete frames to open.
        ranked = sorted(rows, key=lambda r: -r["maxDeltaVsFirst"])[:3]
        print("  most-displaced     : " +
              ", ".join(f"{r['sourceIndex']} (max {r['maxDeltaVsFirst']:.3f})"
                        for r in ranked))
        print(f"\n  For the SH check, orbit a moving part across frame "
              f"{rows[0]['sourceIndex']} and frame {ranked[0]['sourceIndex']}.")
    else:
        print("  NO MOTION DETECTED across the sampled frames.")
        print("  Either the sequence is static, or --step skipped the moving range.")

    if static_head:
        runs, start, prev_i = [], None, None
        for i in static_head:
            if start is None:
                start = prev_i = i
                continue
            if i == prev_i + max(1, args.step):
                prev_i = i
            else:
                runs.append((start, prev_i))
                start = prev_i = i
        if start is not None:
            runs.append((start, prev_i))
        long_runs = [(a, b) for a, b in runs if b > a]
        if long_runs:
            total = sum(b - a + 1 for a, b in long_runs)
            print(f"\n  ! {total} sampled frames are identical to frame "
                  f"{rows[0]['sourceIndex']}: " +
                  ", ".join(f"{a}..{b}" for a, b in long_runs))
            print("    In a flipbook player these cost full per-frame storage for no\n"
                  "    visible change. Consider trimming with --start/--end.")

    if args.json:
        Path(args.json).write_text(json.dumps({"frames": rows}, indent=2), encoding="utf-8")
        print(f"\n  wrote {args.json}")
    print
    return 0


if __name__ == "__main__":
    sys.exit(main())
