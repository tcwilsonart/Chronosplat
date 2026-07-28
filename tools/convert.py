#!/usr/bin/env python3
"""Chronosplat converter — source-agnostic 3DGS PLY sequence -> per-frame SOG.

Wraps @playcanvas/splat-transform per frame and owns everything it does not:
source-schema detection, preflight consistency validation, optional
normalization, frame decimation, strict output naming, and manifest generation.



Nothing here hardcodes a frame count, fps, splat count, or SH degree. Every one
of those is detected from the input and written to manifest.json.

Verified against splat-transform v3.1.7 (`--help`, 2026-07-27). The flags this
wrapper maps onto are documented in QUALITY_PRESETS and build_command.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from glob import glob
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Windows consoles default to a legacy codepage that mangles the box/dash
# characters used in the reports. Force UTF-8 where the stream supports it.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # pragma: no cover - non-tty streams
        pass

from normalize import find_adapter, normalize_file  # noqa: E402
from ply_schema import (PlyError, PlySchema, compute_bounds, frame_number,  # noqa: E402
                        parse_header)

MANIFEST_VERSION = 3

# --quality maps onto splat-transform's SOG knobs. As of v3.1.7 the ONLY
# encode-quality control exposed for SOG is `-i/--sh-iterations` (iterations of
# the SH palette k-means; more = better SH fidelity, slower). SOG's positional
# and scale/rotation quantization is fixed by the format spec and is NOT
# tunable from the CLI -- so the "quantization" half of the --quality
# description is a documented no-op.
QUALITY_PRESETS = {
    "low":    {"sh_iterations": 4},
    "medium": {"sh_iterations": 10},   # splat-transform's own default
    "high":   {"sh_iterations": 20},
}

# Heuristic bytes-per-splat for --dry-run size estimation, by retained SH
# degree. SOG stores fixed-width per-splat channels as lossless WebP, so size
# tracks splat count almost linearly. Range reflects WebP's content-dependent
# compression.
#
# Calibrated 2026-07-27 against the reference dataset (471,456 splats,
# splat-transform v3.1.7, --quality high):
#     degree 0 -> 6,073,710 B = 12.88 B/splat
#     degree 1 -> 7,517,844 B = 15.95 B/splat
# The degree-1 delta (+3.07 B/splat) decomposes as 2 B/splat of shN_labels
# plus a ~510 KB shN_centroids palette. That palette is a FIXED cost per frame
# (64k entries x bands x 3), not a per-splat one, so this model over-estimates
# for very small splat counts and under-estimates slightly for very large ones.
# It is a labelled estimate only — the authoritative number is always the
# post-conversion summary.
EST_BYTES_PER_SPLAT = {
    0: (10.5, 15.5),
    1: (13.0, 19.0),
    2: (14.5, 21.5),
    3: (16.5, 24.5),
}

GITHUB_PAGES_SOFT_LIMIT = 1_000_000_000   # ~1 GB published-site ceiling
GITHUB_FILE_LIMIT = 100_000_000           # 100 MB per-file push limit


class ConvertError(Exception):
    """Fatal, user-facing conversion error."""


# --------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------

@dataclass
class Frame:
    path: Path
    source_index: int
    schema: PlySchema


def discover(input_arg: str) -> list[Path]:
    """Resolve --input (a directory or a glob) to a PLY file list."""
    p = Path(input_arg)
    if p.is_dir():
        files = sorted(p.glob("*.ply"))
    else:
        files = [Path(f) for f in glob(input_arg, recursive=True)]
        files = [f for f in files if f.suffix.lower() == ".ply"]
    if not files:
        raise ConvertError(f"no .ply files matched --input {input_arg!r}")
    return files


def build_frames(files: list[Path]) -> list[Frame]:
    """Parse headers and sort numerically by parsed frame number.

    Never lexical-sorts unpadded names.
    """
    frames: list[Frame] = []
    unnumbered: list[Path] = []
    for f in files:
        n = frame_number(f)
        if n is None:
            unnumbered.append(f)
            continue
        frames.append(Frame(path=f, source_index=n, schema=parse_header(f)))

    if unnumbered and frames:
        raise ConvertError(
            "some inputs have no frame number in their filename, others do; "
            "refusing to guess an ordering. First offender: "
            f"{unnumbered[0].name}"
        )
    if unnumbered:
        # No file carries a number: fall back to a stable lexical order and say so.
        print("  ! no frame numbers found in filenames; falling back to "
              "lexical order", file=sys.stderr)
        for i, f in enumerate(sorted(unnumbered), start=1):
            frames.append(Frame(path=f, source_index=i, schema=parse_header(f)))

    frames.sort(key=lambda fr: fr.source_index)

    dupes = {}
    for fr in frames:
        dupes.setdefault(fr.source_index, []).append(fr.path.name)
    collided = {k: v for k, v in dupes.items() if len(v) > 1}
    if collided:
        k, names = next(iter(collided.items()))
        raise ConvertError(
            f"two or more inputs parse to the same frame number {k}: "
            f"{', '.join(names)} — check --input for an over-broad glob"
        )
    return frames


# --------------------------------------------------------------------------
# preflight
# --------------------------------------------------------------------------

def preflight(frames: list[Frame]) -> None:
    """Verify every frame shares one schema, property list, and splat count.

    Aborts naming the first mismatching file and both differing values. This
    guards the real failure mode of an over-broad --input glob spanning two
    sequence versions, which would otherwise yield a silently corrupt output
    that pops between models mid-playback.
    """
    ref = frames[0]
    ref_key = ref.schema.schema_key()
    ref_count = ref.schema.splat_count

    for fr in frames[1:]:
        if fr.schema.splat_count != ref_count:
            raise ConvertError(
                "PREFLIGHT FAILED — splat count differs across frames.\n"
                f"  {ref.path}\n      {ref_count:,} splats\n"
                f"  {fr.path}\n      {fr.schema.splat_count:,} splats\n"
                "  These are not frames of one sequence. An --input glob spanning two\n"
                "  sequence versions produces a corrupt result; narrow it and re-run."
            )
        if fr.schema.schema_key() != ref_key:
            ref_names = ref.schema.property_names
            got_names = fr.schema.property_names
            if ref_names != got_names:
                only_ref = [n for n in ref_names if n not in set(got_names)]
                only_got = [n for n in got_names if n not in set(ref_names)]
                detail = (f"      only in first:  {only_ref or '(none)'}\n"
                          f"      only in this:   {only_got or '(none)'}")
            else:
                detail = (f"      first: format={ref.schema.fmt}, "
                          f"types={[p.type for p in ref.schema.vertex.properties]}\n"
                          f"      this:  format={fr.schema.fmt}, "
                          f"types={[p.type for p in fr.schema.vertex.properties]}")
            raise ConvertError(
                "PREFLIGHT FAILED — PLY schema differs across frames.\n"
                f"  {ref.path}\n  {fr.path}\n{detail}"
            )

    # Non-contiguous frame numbers are suspicious (usually an incomplete
    # export) but not fatal.
    indices = [fr.source_index for fr in frames]
    expected = list(range(indices[0], indices[0] + len(indices)))
    if indices != expected:
        missing = sorted(set(range(indices[0], indices[-1] + 1)) - set(indices))
        preview = ", ".join(str(m) for m in missing[:12])
        if len(missing) > 12:
            preview += f", ... (+{len(missing) - 12} more)"
        print(f"  ! WARNING: source frame numbers are non-contiguous; missing: "
              f"{preview}\n    Gaps usually mean an incomplete export. Continuing.",
              file=sys.stderr)

    for issue in ref.schema.describe_issues():
        print(f"  ! WARNING: {issue}", file=sys.stderr)


# --------------------------------------------------------------------------
# decimation / fps
# --------------------------------------------------------------------------

@dataclass
class Temporal:
    frame_step: int
    source_fps: float
    playback_fps: float
    duration_seconds: float
    speed_changed: bool


def resolve_temporal(args, kept_count: int) -> Temporal:
    if args.frame_step is not None and args.target_fps is not None:
        raise ConvertError("--frame-step and --target-fps are mutually exclusive")

    source_fps = float(args.source_fps)
    if source_fps <= 0:
        raise ConvertError("--source-fps must be > 0")

    if args.target_fps is not None:
        if args.target_fps <= 0:
            raise ConvertError("--target-fps must be > 0")
        step = max(1, round(source_fps / float(args.target_fps)))
    else:
        step = int(args.frame_step) if args.frame_step is not None else 1
    if step < 1:
        raise ConvertError("--frame-step must be >= 1")

    # Duration-preserving default: fewer frames played proportionally slower
    # keeps the original wall-clock length.
    if args.playback_fps is not None:
        playback_fps = float(args.playback_fps)
        if playback_fps <= 0:
            raise ConvertError("--playback-fps must be > 0")
    else:
        playback_fps = source_fps / step

    duration = kept_count / playback_fps if playback_fps else 0.0
    # Flag the speed-changing combination so it is intentional, not a surprise.
    speed_changed = step > 1 and abs(playback_fps - source_fps / step) > 1e-6
    return Temporal(frame_step=step, source_fps=source_fps,
                    playback_fps=playback_fps, duration_seconds=round(duration, 4),
                    speed_changed=speed_changed)


# --------------------------------------------------------------------------
# splat-transform invocation
# --------------------------------------------------------------------------

def find_splat_transform() -> list[str]:
    """Locate the splat-transform CLI. Prefers the repo-local install so the
    pinned version is used rather than whatever is on PATH."""
    here = Path(__file__).resolve().parent.parent
    local = here / "node_modules" / "@playcanvas" / "splat-transform" / "bin" / "cli.mjs"
    if local.exists():
        node = shutil.which("node")
        if not node:
            raise ConvertError("node not found on PATH (required to run splat-transform)")
        return [node, str(local)]
    exe = shutil.which("splat-transform")
    if exe:
        return [exe]
    raise ConvertError(
        "splat-transform not found. Install it with:\n"
        "  npm install            (from the repo root, uses the pinned version)\n"
        "or globally:\n"
        "  npm install -g @playcanvas/splat-transform"
    )


def parse_advanced(raw: str | None) -> list[str]:
    """Parse --quality-advanced "k=v,k2=v2" into raw CLI tokens.

    Keys are passed through verbatim (with a leading -- added when absent), so
    power users can reach any verified splat-transform flag. Bare keys become
    valueless flags.
    """
    if not raw:
        return []
    out: list[str] = []
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        if "=" in item:
            k, v = item.split("=", 1)
            k = k.strip()
            out.append(k if k.startswith("-") else f"--{k}")
            out.append(v.strip())
        else:
            out.append(item if item.startswith("-") else f"--{item}")
    return out


def alpha_to_logit(alpha: float) -> float:
    """Convert a display alpha (0..1) to the PLY `opacity` column's domain.

    3DGS stores opacity pre-sigmoid, so a threshold expressed as alpha must be
    mapped through the inverse sigmoid before it can be compared against the
    raw column that splat-transform filters on.
    """
    import math
    a = min(max(float(alpha), 1e-6), 1 - 1e-6)
    return math.log(a / (1 - a))


def build_command(cli: list[str], src: Path, dst: Path, *, sh_degree: int,
                  source_sh_degree: int, sh_iterations: int, gpu: str | None,
                  max_workers: int, overwrite: bool, advanced: list[str],
                  min_alpha: float | None = None,
                  filter_floaters: bool = False) -> list[str]:
    """Assemble one splat-transform invocation.

    Grammar (v3.1.7): `splat-transform [GLOBAL] input [ACTIONS] output`.
    -H/--filter-harmonics is an ACTION, so it must follow the input file;
    everything else here is a GLOBAL and must precede it.
    """
    cmd = list(cli)
    cmd += ["--quiet", "--no-tty"]
    if overwrite:
        cmd += ["--overwrite"]
    cmd += ["--sh-iterations", str(sh_iterations)]
    cmd += ["--max-workers", str(max_workers)]
    if gpu:
        cmd += ["--gpu", gpu]
    cmd += advanced

    cmd += [str(src)]
    # Only emit the action when it actually reduces; -H at the source degree is
    # a no-op and omitting it keeps the command minimal.
    if sh_degree < source_sh_degree:
        cmd += ["--filter-harmonics", str(sh_degree)]
    if min_alpha is not None:
        # `opacity` is stored pre-sigmoid, so the threshold is compared in
        # logit space, not as an alpha.
        cmd += ["--filter-value", f"opacity,gt,{alpha_to_logit(min_alpha):.6f}"]
    if filter_floaters:
        cmd += ["--filter-floaters"]
    cmd += [str(dst)]
    return cmd


@dataclass
class Result:
    out_index: int
    source_index: int
    file: str
    splats: int
    bytes: int
    bounds: tuple[list[float], list[float]] | None
    seconds: float


def convert_one(cli, frame: Frame, out_index: int, out_dir: Path, args,
                sh_degree: int, sh_iterations: int, gpu, st_workers: int,
                normalize_adapter, want_bounds: bool) -> Result:
    dst = out_dir / f"frame_{out_index:04d}.sog"
    started = time.time()

    src = frame.path
    schema = frame.schema
    tmpdir = None
    try:
        if normalize_adapter is not None:
            tmpdir = tempfile.mkdtemp(prefix="chronosplat_norm_")
            norm_path = Path(tmpdir) / f"{src.stem}.canonical.ply"
            schema = normalize_file(src, norm_path, normalize_adapter,
                                    drop=("nx", "ny", "nz"))
            src = norm_path

        bounds = compute_bounds(schema) if want_bounds else None

        cmd = build_command(cli, src, dst, sh_degree=sh_degree,
                            source_sh_degree=schema.sh_degree,
                            sh_iterations=sh_iterations, gpu=gpu,
                            max_workers=st_workers, overwrite=True,
                            advanced=parse_advanced(args.quality_advanced),
                            min_alpha=args.min_alpha,
                            filter_floaters=args.filter_floaters)
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip()
            raise ConvertError(
                f"splat-transform failed on {frame.path.name} "
                f"(exit {proc.returncode})\n  command: {' '.join(cmd)}\n  {tail}"
            )
        if not dst.exists():
            raise ConvertError(
                f"splat-transform reported success but produced no output for "
                f"{frame.path.name} (expected {dst})"
            )
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)

    # Filters remove Gaussians, so the source count is no longer the output
    # count. Read the truth back out of the .sog rather than reporting a stale
    # number in the manifest.
    splats = frame.schema.splat_count
    if args.min_alpha is not None or args.filter_floaters:
        actual = read_sog_splat_count(dst)
        if actual is not None:
            splats = actual

    return Result(out_index=out_index, source_index=frame.source_index,
                  file=dst.name, splats=splats,
                  bytes=dst.stat().st_size, bounds=bounds,
                  seconds=time.time() - started)


def read_sog_splat_count(sog_path: Path) -> int | None:
    """Read the Gaussian count from a .sog bundle's meta.json.

    A .sog is a zip of meta.json plus per-channel WebP images, so this reads
    only the small metadata entry.
    """
    import zipfile
    try:
        with zipfile.ZipFile(sog_path) as z:
            meta = json.loads(z.read("meta.json"))
        count = meta.get("count")
        return int(count) if isinstance(count, (int, float)) else None
    except (OSError, KeyError, ValueError, zipfile.BadZipFile):
        return None


# --------------------------------------------------------------------------
# reporting
# --------------------------------------------------------------------------

def human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024 or unit == "TiB":
            return f"{n:,.1f} {unit}" if unit != "B" else f"{int(n):,} B"
        n /= 1024
    return f"{n:.1f} TiB"


def print_plan(frames, kept, temporal, sh_degree, source_sh_degree, args,
               quality, normalize_adapter, out_dir) -> None:
    ref = frames[0].schema
    lo, hi = EST_BYTES_PER_SPLAT.get(sh_degree, EST_BYTES_PER_SPLAT[3])
    est_lo = ref.splat_count * lo
    est_hi = ref.splat_count * hi

    print("\n=== PLAN ===")
    print(f"  input                : {args.input}")
    print(f"  output               : {out_dir}")
    print(f"  source frames found  : {len(frames)}  "
          f"(indices {frames[0].source_index}..{frames[-1].source_index})")
    print(f"  frames kept          : {len(kept)}")
    print(f"  frame step           : {temporal.frame_step}"
          + ("" if temporal.frame_step == 1 else "  (decimating)"))
    print(f"  source fps           : {temporal.source_fps:g}")
    print(f"  playback fps         : {temporal.playback_fps:g}")
    print(f"  duration             : {temporal.duration_seconds:g} s")
    if temporal.speed_changed:
        ratio = temporal.playback_fps / (temporal.source_fps / temporal.frame_step)
        print(f"  ! playback-fps was set explicitly alongside frame-step "
              f"{temporal.frame_step}:")
        print(f"    the animation will run {ratio:.3g}x "
              f"{'faster' if ratio > 1 else 'slower'} than authored.")
    print(f"  splats / frame       : {ref.splat_count:,}  (constant, preflight-verified)")
    print(f"  source SH degree     : {source_sh_degree}"
          f"  ({ref.rest_count} f_rest_* properties)"
          if ref.sh_present else "  source SH degree     : none (DC colour only)")
    print(f"  retained SH degree   : {sh_degree}"
          + ("  (reduced as a size lever)" if sh_degree < source_sh_degree else ""))
    print(f"  quality              : {quality}  "
          f"(--sh-iterations {QUALITY_PRESETS[quality]['sh_iterations']})")
    print(f"  layout               : {'canonical INRIA' if ref.is_canonical else 'NONSTANDARD'}"
          + (f"  -> normalize via '{normalize_adapter.name}'" if normalize_adapter else ""))
    print(f"  source total         : {human(sum(f.schema.file_size for f in kept))}")
    print(f"\n  ESTIMATED output     : {human(est_lo)} .. {human(est_hi)} per frame")
    print(f"                         {human(est_lo * len(kept))} .. "
          f"{human(est_hi * len(kept))} total")
    print("  (heuristic only — the authoritative number is the post-conversion summary)")
    if est_hi * len(kept) > GITHUB_PAGES_SOFT_LIMIT:
        print(f"  ! the high end of this estimate exceeds the ~1 GB GitHub Pages "
              f"ceiling.\n    Consider --frame-step or --sh-degree to reduce.")


def print_summary(results: list[Result], frames_total: int, temporal, out_dir,
                  elapsed: float) -> None:
    sizes = sorted(r.bytes for r in results)
    total = sum(sizes)
    print("\n=== SUMMARY ===")
    print(f"  frames converted     : {len(results)} kept of {frames_total} source")
    print(f"  frame step           : {temporal.frame_step}")
    print(f"  playback fps         : {temporal.playback_fps:g}  "
          f"({temporal.duration_seconds:g} s)")
    print(f"  output dir           : {out_dir}")
    print(f"  per-frame size       : min {human(sizes[0])} / "
          f"mean {human(total / len(sizes))} / max {human(sizes[-1])}")
    print(f"  TOTAL this sequence  : {human(total)}  ({total:,} bytes)")
    print(f"  wall time            : {elapsed:.1f} s "
          f"({elapsed / len(results):.2f} s/frame)")

    if sizes[-1] > GITHUB_FILE_LIMIT:
        print(f"  ! WARNING: largest frame ({human(sizes[-1])}) exceeds GitHub's "
              f"100 MB per-file push limit.")


def print_library_budget(index: dict) -> None:
    """Report the GitHub Pages budget across the WHOLE library.

    The ~1 GB Pages ceiling applies to the published site, not to any one
    sequence. Checking only the sequence just converted would cheerfully report
    "OK" while the library as a whole is already over — so the check lives here,
    after the index is rebuilt and every sequence's size is known.

    Sequences with a non-empty baseUrl are served from object storage, not from
    the repository. They are listed but excluded from the ceiling, because
    counting them would report a limit the deploy will never actually hit.
    """
    seqs = index.get("sequences") or []
    if not seqs:
        return

    published = [s for s in seqs if not s.get("baseUrl")]
    external = [s for s in seqs if s.get("baseUrl")]
    total = sum(int(s.get("bytes") or 0) for s in published)

    print(f"\n  library ({len(seqs)} sequence{'s' if len(seqs) != 1 else ''}):")
    for s in seqs:
        where = "  -> object storage" if s.get("baseUrl") else ""
        print(f"      {s['id']:<20} {human(s.get('bytes') or 0):>12}  "
              f"{s.get('frameCount', '?')} frames{where}")
    if external:
        ext_total = sum(int(s.get("bytes") or 0) for s in external)
        print(f"      {'PUBLISHED WITH SITE':<20} {human(total):>12}")
        print(f"      {'OFF-SITE':<20} {human(ext_total):>12}  "
              f"(not counted against Pages)")
    else:
        print(f"      {'TOTAL':<20} {human(total):>12}")

    if total > GITHUB_PAGES_SOFT_LIMIT:
        over = total - GITHUB_PAGES_SOFT_LIMIT
        print(f"\n  ! WARNING: the published site totals {human(total)} — {human(over)} OVER "
              f"the ~1 GB\n"
              f"    GitHub Pages published-site ceiling. The deploy workflow will "
              f"fail this build.\n"
              f"    Reduce with --frame-step or --sh-degree, drop a sequence, or "
              f"move one\n    to object storage with tools/set_host.py.")
    else:
        headroom = GITHUB_PAGES_SOFT_LIMIT - total
        pct = total / GITHUB_PAGES_SOFT_LIMIT * 100
        note = "" if pct < 80 else "   <- getting tight"
        print(f"\n  GitHub Pages         : {human(headroom)} headroom "
              f"({pct:.0f}% of the ~1 GB ceiling used){note}")


# --------------------------------------------------------------------------
# manifest
# --------------------------------------------------------------------------

def build_manifest(args, frames, kept, results, temporal, sh_degree,
                   source_sh_degree, quality, normalized) -> dict:
    ref = kept[0].schema

    mins = [b for r in results if r.bounds for b in [r.bounds[0]]]
    maxs = [b for r in results if r.bounds for b in [r.bounds[1]]]
    bounds = None
    if mins and maxs:
        bounds = {
            "min": [round(min(m[i] for m in mins), 6) for i in range(3)],
            "max": [round(max(m[i] for m in maxs), 6) for i in range(3)],
        }

    manifest = {
        "version": MANIFEST_VERSION,
        "project": args.project,
        "source": {
            "exporter": args.exporter,
            "shPresent": ref.sh_present,
            "sourceShDegree": source_sh_degree,
            "sourceFrameCount": len(frames),
            "sourceFps": temporal.source_fps,
        },
        "encode": {
            "format": "sog",
            "shDegree": sh_degree,
            "quality": quality,
            "normalized": normalized,
        },
        # How the PLAYER should present this sequence. Orientation belongs
        # here, not in player config: it is a property of the export. Two
        # sequences from the same studio pipeline can disagree (the reference
        # `excavator` needs the flip; `bogdanFly` does not).
        "display": {
            "flipX": args.flip_x == "on",
            **({"background": args.background} if args.background else {}),
        },
        "temporal": {
            "frameStep": temporal.frame_step,
            "playbackFps": temporal.playback_fps,
            "durationSeconds": temporal.duration_seconds,
        },
        "frameCount": len(results),
        "baseUrl": args.base_url,
    }

    # camera/bounds go ABOVE frames[]: frames is hundreds of lines long, and
    # these are the fields a human actually opens the manifest to edit.
    if bounds:
        manifest["bounds"] = bounds
        manifest["camera"] = derive_camera(bounds, flip_x=args.flip_x == "on")

    manifest["frames"] = [
        {"index": r.out_index, "sourceIndex": r.source_index,
         "file": r.file, "splats": r.splats, "bytes": r.bytes}
        for r in results
    ]
    # NOTE: no "audio" block is written. audio support ships dormant — the player
    # must behave identically without it. Add the block by hand when a track
    # exists; no converter change is needed.
    return manifest


def derive_camera(bounds: dict, flip_x: bool = True) -> dict:
    """A sane default framing from the sequence bounds.

    Places the camera on a 3/4 view at a distance that fits the bounding
    sphere in a 50 deg vertical FOV, looking at the centre.

    SPACES MATTER HERE. `bounds` is in SOURCE (PLY) space — it describes the
    data. The player, however, may rotate the mesh 180 deg about X for display
    (display.flipX). A camera derived from source-space bounds would therefore
    aim at where the model *was*, not where it is drawn — which for an
    asymmetric model puts it entirely out of frame.

    So `manifest.camera` is written in DISPLAY space: exactly the coordinates
    the player uses, and exactly what a "save camera" round-trip produces.
    """
    import math

    lo, hi = list(bounds["min"]), list(bounds["max"])
    if flip_x:
        # 180 deg about X maps (x, y, z) -> (x, -y, -z); min/max swap on the
        # negated axes.
        lo[1], hi[1] = -hi[1], -lo[1]
        lo[2], hi[2] = -hi[2], -lo[2]
    center = [(lo[i] + hi[i]) / 2 for i in range(3)]
    size = [hi[i] - lo[i] for i in range(3)]
    radius = max(1e-6, math.sqrt(sum(s * s for s in size)) / 2)

    fov = 50.0
    dist = radius / math.sin(math.radians(fov) / 2) * 1.15  # 15% margin
    # 3/4 view: azimuth 35 deg, elevation 20 deg, Y-up.
    az, el = math.radians(35.0), math.radians(20.0)
    offset = [dist * math.cos(el) * math.sin(az),
              dist * math.sin(el),
              dist * math.cos(el) * math.cos(az)]
    return {
        "position": [round(center[i] + offset[i], 4) for i in range(3)],
        "target": [round(c, 4) for c in center],
        "up": [0, 1, 0],
        "fov": fov,
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="chronosplat",
        description="Chronosplat converter — turn a 3DGS PLY sequence (any "
                    "exporter) into per-frame SOG plus manifest.json.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""run as `py tools/convert.py` (Windows) or `python3 tools/convert.py`.

examples:
  # keep everything, auto SH degree, high quality
  py tools/convert.py --input ./seq --output ./data --source-fps 24

  # halve the frame count, preserving wall-clock duration
  py tools/convert.py --input ./seq --output ./data --source-fps 24 --frame-step 2

  # drop SH entirely as a size lever
  py tools/convert.py --input ./seq --output ./data --source-fps 24 --sh-degree 0

  # plan only, convert nothing
  py tools/convert.py --input ./seq --output ./data --source-fps 24 --dry-run
""")

    g = p.add_argument_group("input / range")
    g.add_argument("--input", required=True, metavar="<dir|glob>",
                   help="source PLY frames, any 3DGS exporter")
    g.add_argument("--output", required=True, metavar="<dir>",
                   help="SOG output directory")
    g.add_argument("--start", type=int, metavar="<int>",
                   help="first source frame to include (default: first found)")
    g.add_argument("--end", type=int, metavar="<int>",
                   help="last source frame to include (default: last found)")

    g = p.add_argument_group("quality / compression")
    g.add_argument("--sh-degree", default="auto", metavar="<0|1|2|3|auto>",
                   help="SH bands to retain; auto keeps the source degree. "
                        "Clamped to the source's actual degree.")
    g.add_argument("--quality", default="high", choices=tuple(QUALITY_PRESETS),
                   help="named SOG encode preset (default: high)")
    g.add_argument("--quality-advanced", metavar='"<k=v,...>"',
                   help="raw pass-through of splat-transform flags for power users")

    g = p.add_argument_group("temporal / fps")
    g.add_argument("--source-fps", type=float, default=24.0, metavar="<float>",
                   help="authored fps of the input sequence (default: 24)")
    g.add_argument("--playback-fps", type=float, metavar="<float>",
                   help="fps written to the manifest "
                        "(default: source-fps / frame-step, duration-preserving)")
    g.add_argument("--frame-step", type=int, metavar="<int>",
                   help="keep every Nth source frame (default: 1)")
    g.add_argument("--target-fps", type=float, metavar="<float>",
                   help="derive frame-step from source-fps/target-fps; "
                        "mutually exclusive with --frame-step")

    g = p.add_argument_group("source handling")
    g.add_argument("--normalize", nargs="?", const="auto", default=None,
                   metavar="<adapter>",
                   help="normalize a nonstandard PLY layout before encode "
                        "(default adapter: auto-detect)")
    g.add_argument("--background", default=None, metavar="<css-colour>",
                   help="viewer background for this sequence, e.g. '#0b0d10' "
                        "or 'black'. Recorded in manifest.display.background; "
                        "the player's colour picker writes the same field.")
    g.add_argument("--min-alpha", type=float, default=None, metavar="<0..1>",
                   help="drop splats whose opacity is below this alpha "
                        "(0..1). A real size lever on soft/hazy captures. "
                        "NOTE: this changes the splat count, so frames may "
                        "differ from one another.")
    g.add_argument("--filter-floaters", action="store_true",
                   help="drop splats that contribute to no solid voxel "
                        "(splat-transform --filter-floaters). Removes haze "
                        "around a capture; GPU-only.")
    g.add_argument("--flip-x", choices=("on", "off"), default="on",
                   help="record whether the player should rotate this sequence "
                        "180 deg about X to bring it Y-up (default: on, the "
                        "INRIA/COLMAP convention). Orientation varies BY "
                        "EXPORT, not by tool — if the result renders upside "
                        "down, use 'off'. Toggle live with the player's Flip "
                        "button to find the right value.")

    g = p.add_argument_group("manifest metadata")
    g.add_argument("--project", default=None, metavar="<name>",
                   help="project name for the manifest (default: input dir name)")
    g.add_argument("--exporter", default="unknown", metavar="<str>",
                   help="provenance string recorded in manifest.source.exporter")
    g.add_argument("--base-url", default="", metavar="<url>",
                   help='manifest baseUrl; "" (default) resolves frames relative '
                        "to the manifest — correct for same-origin hosting")

    g = p.add_argument_group("execution")
    g.add_argument("--workers", type=int, default=None, metavar="<int>",
                   help="parallel per-frame conversions (default: adaptive)")
    backend = g.add_mutually_exclusive_group()
    backend.add_argument("--gpu", nargs="?", const="0", default=None, metavar="<n>",
                         help="use GPU adapter n for SOG encode (default adapter 0)")
    backend.add_argument("--cpu", action="store_true",
                         help="force CPU SOG encode")
    g.add_argument("--dry-run", action="store_true",
                   help="print the plan and estimated size; convert nothing")
    g.add_argument("--force", action="store_true",
                   help="overwrite existing outputs")
    g.add_argument("--no-bounds", action="store_true",
                   help="skip bounds/camera derivation (faster; omits those "
                        "manifest fields)")
    g.add_argument("--no-index", action="store_true",
                   help="do not rebuild the parent library index.json "
                        "(see tools/index_sequences.py)")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)

    try:
        return run(args)
    except ConvertError as e:
        print(f"\nERROR: {e}\n", file=sys.stderr)
        return 2
    except PlyError as e:
        print(f"\nERROR (PLY): {e}\n", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130


def run(args) -> int:
    out_dir = Path(args.output)
    if not args.project:
        # Name the project after the source directory rather than leaving it null.
        probe = Path(args.input)
        base = probe if probe.is_dir() else probe.parent
        args.project = base.resolve().name or "untitled"
    print(f"chronosplat — scanning {args.input}")

    files = discover(args.input)
    frames = build_frames(files)
    print(f"  discovered {len(frames)} PLY frames")

    print("  preflight: verifying schema + splat-count consistency...")
    preflight(frames)
    print("  preflight: OK — all frames share one schema and splat count")

    # --start/--end filter on SOURCE frame numbers.
    if args.start is not None:
        frames = [f for f in frames if f.source_index >= args.start]
    if args.end is not None:
        frames = [f for f in frames if f.source_index <= args.end]
    if not frames:
        raise ConvertError("--start/--end excluded every frame")

    ref = frames[0].schema

    # --- normalization -------------------------------------------------
    normalize_adapter = None
    if args.normalize is not None:
        normalize_adapter = find_adapter(ref, args.normalize)
        if normalize_adapter is None:
            raise ConvertError(
                "--normalize was requested but no adapter matches this layout. "
                f"Properties: {ref.property_names[:24]}..."
            )
    elif not ref.is_canonical:
        auto = find_adapter(ref, "auto")
        if auto is None:
            raise ConvertError(
                "source layout is nonstandard and no normalization adapter "
                f"matches it.\n  Properties: {ref.property_names}\n"
                "  Add an adapter in tools/normalize.py, or pre-convert the "
                "source to the canonical INRIA layout."
            )
        normalize_adapter = auto
        print(f"  ! nonstandard layout detected; auto-enabling --normalize "
              f"'{auto.name}' ({auto.description})")

    # --- SH degree resolution ------------------------------------------
    source_sh_degree = ref.sh_degree
    if args.sh_degree == "auto":
        sh_degree = source_sh_degree
    else:
        try:
            requested = int(args.sh_degree)
        except ValueError:
            raise ConvertError(f"--sh-degree must be 0|1|2|3|auto, got {args.sh_degree!r}")
        if requested not in (0, 1, 2, 3):
            raise ConvertError(f"--sh-degree must be 0|1|2|3|auto, got {requested}")
        if requested > source_sh_degree:
            print(f"  ! WARNING: --sh-degree {requested} exceeds the source's "
                  f"degree {source_sh_degree}; clamping to {source_sh_degree}",
                  file=sys.stderr)
        sh_degree = min(requested, source_sh_degree)

    # --- decimation ----------------------------------------------------
    step_probe = resolve_temporal(args, kept_count=1)
    kept = frames[::step_probe.frame_step]
    temporal = resolve_temporal(args, kept_count=len(kept))

    print_plan(frames, kept, temporal, sh_degree, source_sh_degree, args,
               args.quality, normalize_adapter, out_dir)

    if args.dry_run:
        print("\n--dry-run: nothing was converted.\n")
        return 0

    # --- execute -------------------------------------------------------
    out_dir.mkdir(parents=True, exist_ok=True)
    existing = sorted(out_dir.glob("frame_*.sog"))
    if existing and not args.force:
        # Ask when a human is present; fall back to requiring --force when
        # stdin is not a terminal (CI, pipes, drag-and-drop wrappers), so an
        # unattended run can never hang waiting on input.
        prompt = (f"  {out_dir} already contains {len(existing)} frame_*.sog "
                  f"file(s).\n  Overwrite? [Y/n] ")
        if sys.stdin is not None and sys.stdin.isatty():
            try:
                answer = input(prompt).strip().lower()
            except EOFError:
                answer = "n"
            if answer not in ("", "y", "yes"):
                print("  aborted.")
                return 1
        else:
            raise ConvertError(
                f"{out_dir} already contains {len(existing)} frame_*.sog file(s), "
                "and stdin is not a terminal so I cannot ask. Pass --force to "
                "overwrite."
            )

    cli = find_splat_transform()
    gpu = "cpu" if args.cpu else (args.gpu if args.gpu is not None else None)

    cpu_count = os.cpu_count() or 4
    if args.workers is not None:
        workers = max(1, args.workers)
    elif gpu == "cpu" or gpu is None:
        workers = max(1, min(4, cpu_count // 2))
    else:
        # A single GPU is the bottleneck; a couple of concurrent encodes keeps
        # it fed without thrashing VRAM.
        workers = 2
    st_workers = max(1, min(8, cpu_count // workers))

    quality_cfg = QUALITY_PRESETS[args.quality]
    print(f"\n  converting {len(kept)} frames — {workers} parallel "
          f"({st_workers} encode threads each), "
          f"backend {'CPU' if gpu == 'cpu' else f'GPU {gpu}' if gpu else 'default'}")

    results: list[Result] = []
    started = time.time()
    done = 0

    def task(pair):
        out_index, frame = pair
        return convert_one(cli, frame, out_index, out_dir, args, sh_degree,
                           quality_cfg["sh_iterations"], gpu, st_workers,
                           normalize_adapter,
                           want_bounds=not args.no_bounds)

    pairs = list(enumerate(kept, start=1))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for res in pool.map(task, pairs):
            results.append(res)
            done += 1
            pct = done / len(pairs) * 100
            print(f"    [{done:>4}/{len(pairs)}] {pct:5.1f}%  {res.file}  "
                  f"{human(res.bytes)}  ({res.seconds:.1f}s)", flush=True)

    results.sort(key=lambda r: r.out_index)
    elapsed = time.time() - started

    # Remove frames left over from a PREVIOUS, longer run. Output indices are
    # re-sequenced 1..M, so converting a shorter range into an existing folder
    # otherwise leaves orphans: they are absent from the manifest (so the
    # player ignores them) but still get committed and still count against the
    # GitHub Pages budget. Scoped strictly to frame_*.sog in the output dir.
    kept_names = {r.file for r in results}
    orphans = [p for p in sorted(out_dir.glob("frame_*.sog"))
               if p.name not in kept_names]
    if orphans:
        freed = sum(p.stat().st_size for p in orphans)
        for p in orphans:
            p.unlink()
        print(f"\n  removed {len(orphans)} stale frame(s) from a previous run "
              f"({human(freed)} reclaimed): "
              f"{orphans[0].name}"
              + (f" .. {orphans[-1].name}" if len(orphans) > 1 else ""))

    manifest = build_manifest(args, frames, kept, results, temporal, sh_degree,
                              source_sh_degree, args.quality,
                              normalized=normalize_adapter is not None)
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    # Rebuild the parent library index so a new sequence shows up in the
    # player's dropdown without a second command. Only meaningful when the
    # output is a sequence subfolder of a library (data/<name>/), which is the
    # documented layout; harmless otherwise.
    library_index = None
    if not args.no_index:
        try:
            import index_sequences
            library_index = index_sequences.write(out_dir.parent, quiet=True)
        except Exception as e:  # never fail a good conversion over the index
            print(f"  ! could not rebuild library index: {e}", file=sys.stderr)

    print_summary(results, len(frames), temporal, out_dir, elapsed)
    source_total = sum(f.schema.file_size for f in kept)
    out_total = sum(r.bytes for r in results)
    print(f"  compression ratio    : {source_total / out_total:.1f}x vs source PLY")
    print(f"  manifest             : {manifest_path}")
    if not args.no_index:
        index_path = out_dir.parent / "index.json"
        if index_path.exists():
            try:
                n = len(json.loads(index_path.read_text(encoding="utf-8"))["sequences"])
                print(f"  library index        : {index_path}  "
                      f"({n} sequence{'s' if n != 1 else ''})")
            except (OSError, KeyError, json.JSONDecodeError):
                pass
    if "camera" not in manifest:
        print("  ! no bounds/camera derived (--no-bounds, or bounds unreadable); "
              "the player will fall back to config.js defaults.")

    if library_index:
        print_library_budget(library_index)
    print
    return 0


if __name__ == "__main__":
    args_ = sys.argv[1:]
    sys.exit(main(args_))
