"""Pluggable normalization adapters for nonstandard 3DGS PLY layouts.

Some exporters deviate from the canonical INRIA layout
(e.g. Houdini writing SH as GS_SPH_R/G/B_* instead of f_rest_*). Rather than
baking any one vendor's quirks into the core path, each mapping lives here as
a small adapter that rewrites a source PLY into canonical form. The core
converter then only ever hands splat-transform a canonical file.

The reference Excavator export is *already* canonical (verified), so
this path is unused for it — it exists for other sources.

To add an adapter: subclass Adapter, implement `matches` and `column_map`,
and append it to ADAPTERS.
"""

from __future__ import annotations

import re
from pathlib import Path

from ply_schema import (PLY_TYPES, REST_COUNT_FOR_DEGREE, PlyError, PlySchema,
                        parse_header)


class Adapter:
    """Maps one nonstandard layout onto the canonical one."""

    name = "base"
    description = ""

    def matches(self, schema: PlySchema) -> bool:
        raise NotImplementedError

    def column_map(self, schema: PlySchema) -> dict[str, str]:
        """Returns {canonical_name: source_name} for properties that must be
        renamed. Properties not mentioned are copied through unchanged."""
        raise NotImplementedError


class HoudiniSphAdapter(Adapter):
    """Houdini-style `GS_SPH_R_n` / `GS_SPH_G_n` / `GS_SPH_B_n` SH storage.

    The canonical layout interleaves SH by coefficient-major order:
        f_rest_0..(K-1)   = coeff 0..K-1 for R
        f_rest_K..(2K-1)  = coeff 0..K-1 for G
        f_rest_2K..(3K-1) = coeff 0..K-1 for B
    i.e. channel-major blocks of K coefficients each, which is what the INRIA
    reference implementation writes and what splat-transform expects.
    """

    name = "houdini-sph"
    description = "GS_SPH_R/G/B_* -> canonical f_rest_* (channel-major)"

    _pat = re.compile(r"^GS_SPH_(?P<ch>[RGB])_?(?P<i>\d+)$", re.IGNORECASE)

    def _groups(self, schema: PlySchema) -> dict[str, list[tuple[int, str]]]:
        out: dict[str, list[tuple[int, str]]] = {"R": [], "G": [], "B": []}
        for name in schema.property_names:
            m = self._pat.match(name)
            if m:
                out[m.group("ch").upper()].append((int(m.group("i")), name))
        for ch in out:
            out[ch].sort()
        return out

    def matches(self, schema: PlySchema) -> bool:
        g = self._groups(schema)
        return all(g[ch] for ch in ("R", "G", "B"))

    def column_map(self, schema: PlySchema) -> dict[str, str]:
        g = self._groups(schema)
        per_channel = {ch: len(v) for ch, v in g.items()}
        if len(set(per_channel.values())) != 1:
            raise PlyError(
                f"{schema.path.name}: GS_SPH channels have unequal coefficient "
                f"counts {per_channel} — cannot map to f_rest_*"
            )
        k = per_channel["R"]
        total = 3 * k
        if total not in REST_COUNT_FOR_DEGREE.values():
            raise PlyError(
                f"{schema.path.name}: {total} SH coefficients ({k} per channel) does "
                f"not correspond to any SH degree (expected 9/24/45)"
            )
        mapping: dict[str, str] = {}
        for ci, ch in enumerate(("R", "G", "B")):
            for j, (_, src) in enumerate(g[ch]):
                mapping[f"f_rest_{ci * k + j}"] = src
        return mapping


class DcColorAdapter(Adapter):
    """Exports storing base colour as `red`/`green`/`blue` (uchar 0-255) or
    `colour_*` rather than `f_dc_*`.

    Only handles the *rename*; a uchar->float SH0 conversion is applied during
    rewrite because the value domains differ (see `_needs_sh0_encode`).
    """

    name = "dc-color"
    description = "red/green/blue -> f_dc_* (with SH0 encoding when 8-bit)"

    _candidates = (("red", "green", "blue"), ("r", "g", "b"),
                   ("colour_0", "colour_1", "colour_2"),
                   ("color_0", "color_1", "color_2"))

    def _pick(self, schema: PlySchema) -> tuple[str, str, str] | None:
        names = set(schema.property_names)
        if {"f_dc_0", "f_dc_1", "f_dc_2"}.issubset(names):
            return None
        for trio in self._candidates:
            if set(trio).issubset(names):
                return trio
        return None

    def matches(self, schema: PlySchema) -> bool:
        return self._pick(schema) is not None

    def column_map(self, schema: PlySchema) -> dict[str, str]:
        trio = self._pick(schema)
        if trio is None:
            return {}
        return {f"f_dc_{i}": src for i, src in enumerate(trio)}


ADAPTERS: list[Adapter] = [HoudiniSphAdapter, DcColorAdapter]

SH0_C0 = 0.28209479177387814  # Y_0^0; converts linear colour <-> SH DC term


def find_adapter(schema: PlySchema, requested: str | None = None) -> Adapter | None:
    """Select an adapter by name, or auto-detect when `requested` is 'auto'/None."""
    if requested and requested != "auto":
        for a in ADAPTERS:
            if a.name == requested:
                return a
        raise PlyError(
            f"unknown normalization adapter {requested!r}; available: "
            + ", ".join(a.name for a in ADAPTERS)
        )
    for a in ADAPTERS:
        if a.matches(schema):
            return a
    return None


def _needs_sh0_encode(schema: PlySchema, mapping: dict[str, str]) -> bool:
    """True when the mapped colour source is 8-bit and must be converted from
    [0,255] linear colour into the SH DC domain."""
    src = mapping.get("f_dc_0")
    if not src:
        return False
    for p in schema.vertex.properties:
        if p.name == src:
            return p.type in ("uchar", "uint8")
    return False


def normalize_file(src: Path, dst: Path, adapter: Adapter,
                   drop: tuple[str, ...] = ()) -> PlySchema:
    """Rewrite `src` into canonical layout at `dst`. Returns the new schema.

    Reads the source with numpy via a structured dtype so only the needed
    columns are touched, and writes a binary_little_endian float32 PLY.
    """
    import numpy as np

    schema = parse_header(src)
    if not schema.is_binary or schema.fmt == "binary_big_endian":
        raise PlyError(
            f"{src.name}: normalization supports binary_little_endian input only "
            f"(got {schema.fmt})"
        )
    if schema.vertex.has_list:
        raise PlyError(f"{src.name}: cannot normalize a vertex element with list properties")

    mapping = adapter.column_map(schema)
    props = schema.vertex.properties

    offsets, running = {}, 0
    for p in props:
        offsets[p.name] = running
        running += p.size

    def column(name: str) -> "np.ndarray":
        p = next(q for q in props if q.name == name)
        dt = np.dtype({"names": [name],
                       "formats": [np.dtype(PLY_TYPES[p.type][0])],
                       "offsets": [offsets[name]],
                       "itemsize": schema.stride})
        mm = np.memmap(src, dtype=dt, mode="r", offset=schema.header_bytes,
                       shape=(schema.splat_count,))
        return np.asarray(mm[name], dtype=np.float32)

    # Build the canonical output column order.
    inverse = {v: k for k, v in mapping.items()}
    consumed = set(mapping.values())
    out_names: list[str] = []
    for p in props:
        if p.name in drop or p.name in consumed:
            continue
        out_names.append(p.name)
    # Mapped canonical names go in sorted, deterministic order.
    def _key(n: str):
        m = re.match(r"^(f_dc|f_rest)_(\d+)$", n)
        return (0, m.group(1), int(m.group(2))) if m else (1, n, 0)

    out_names.extend(sorted(mapping.keys(), key=_key))
    seen, ordered = set, []
    for n in out_names:
        if n not in seen:
            seen.add(n)
            ordered.append(n)
    out_names = ordered

    encode_sh0 = _needs_sh0_encode(schema, mapping)

    columns = []
    for name in out_names:
        src_name = mapping.get(name, name)
        col = column(src_name)
        if encode_sh0 and name.startswith("f_dc_"):
            # linear 8-bit colour -> SH DC term
            col = ((col / 255.0) - 0.5) / SH0_C0
        columns.append(col.astype(np.float32, copy=False))

    dst.parent.mkdir(parents=True, exist_ok=True)
    header = ["ply", "format binary_little_endian 1.0",
              f"comment normalized by chronosplat convert.py adapter={adapter.name}",
              f"element vertex {schema.splat_count}"]
    header += [f"property float {n}" for n in out_names]
    header.append("end_header")
    header_blob = ("\n".join(header) + "\n").encode("ascii")

    table = np.empty((schema.splat_count, len(columns)), dtype=np.float32)
    for i, col in enumerate(columns):
        table[:, i] = col

    with dst.open("wb") as fh:
        fh.write(header_blob)
        table.tofile(fh)

    return parse_header(dst)
