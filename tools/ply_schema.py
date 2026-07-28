"""PLY header parsing and 3DGS schema detection.

Reads only the header (a few hundred bytes) for discovery and preflight, so
scanning a multi-gigabyte sequence costs almost nothing. Bulk point data is
only touched when bounds are requested.

Nothing here assumes a splat count, an SH degree, or a vendor layout; every
such value is *detected* and returned.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

# PLY scalar type -> (struct char, byte size). Both the canonical and the
# legacy/aliased spellings appear in the wild.
PLY_TYPES = {
    "char": ("b", 1), "int8": ("b", 1),
    "uchar": ("B", 1), "uint8": ("B", 1),
    "short": ("h", 2), "int16": ("h", 2),
    "ushort": ("H", 2), "uint16": ("H", 2),
    "int": ("i", 4), "int32": ("i", 4),
    "uint": ("I", 4), "uint32": ("I", 4),
    "float": ("f", 4), "float32": ("f", 4),
    "double": ("d", 8), "float64": ("d", 8),
}

# Number of f_rest_* coefficients implied by each SH degree: 3 * ((d+1)^2 - 1).
SH_REST_COUNTS = {0: 0, 9: 1, 24: 2, 45: 3}
REST_COUNT_FOR_DEGREE = {0: 0, 1: 9, 2: 24, 3: 45}

# Placeholder attributes that carry no information in a 3DGS export but do
# occupy stride. The reference dataset ships all-zero normals.
DROPPABLE = ("nx", "ny", "nz")


class PlyError(Exception):
    """Raised for malformed or unreadable PLY input."""


@dataclass
class Property:
    name: str
    type: str
    is_list: bool = False
    count_type: str | None = None

    @property
    def size(self) -> int:
        if self.is_list:
            raise PlyError(f"list property {self.name!r} has no fixed size")
        return PLY_TYPES[self.type][1]


@dataclass
class Element:
    name: str
    count: int
    properties: list[Property] = field(default_factory=list)

    @property
    def has_list(self) -> bool:
        return any(p.is_list for p in self.properties)

    @property
    def stride(self) -> int:
        return sum(p.size for p in self.properties)


@dataclass
class PlySchema:
    """Everything detected from one PLY header."""

    path: Path
    fmt: str                      # ascii | binary_little_endian | binary_big_endian
    header_bytes: int
    elements: list[Element]
    file_size: int

    # --- derived splat properties -------------------------------------
    @property
    def vertex(self) -> Element:
        for el in self.elements:
            if el.name == "vertex":
                return el
        raise PlyError(f"{self.path.name}: no 'vertex' element in header")

    @property
    def splat_count(self) -> int:
        return self.vertex.count

    @property
    def property_names(self) -> list[str]:
        return [p.name for p in self.vertex.properties]

    @property
    def stride(self) -> int:
        return self.vertex.stride

    @property
    def is_binary(self) -> bool:
        return self.fmt.startswith("binary")

    @property
    def rest_count(self) -> int:
        return sum(1 for n in self.property_names if n.startswith("f_rest_"))

    @property
    def sh_present(self) -> bool:
        return self.rest_count > 0 or bool(self.nonstandard_sh)

    @property
    def sh_degree(self) -> int:
        """SH degree inferred from the f_rest_* count. Non-canonical counts
        round *down* to the largest fully-populated degree rather than
        guessing, and are surfaced as a warning by `describe_issues`."""
        n = self.rest_count
        if n in SH_REST_COUNTS:
            return SH_REST_COUNTS[n]
        for count, deg in sorted(SH_REST_COUNTS.items(), reverse=True):
            if n >= count:
                return deg
        return 0

    @property
    def nonstandard_sh(self) -> list[str]:
        """SH-looking attributes that are not canonical `f_rest_*`.

        e.g. some Houdini exports write GS_SPH_R/G/B_*. Presence here means the
        file needs `--normalize` before encode.
        """
        pat = re.compile(r"^(GS_SPH_[RGB]|sph_|sh_)", re.IGNORECASE)
        return [n for n in self.property_names
                if pat.match(n) and not n.startswith("f_rest_")]

    @property
    def is_canonical(self) -> bool:
        """True when the layout is the standard INRIA one splat-transform reads
        directly, so no normalization pass is needed."""
        required = {"x", "y", "z", "opacity",
                    "scale_0", "scale_1", "scale_2",
                    "rot_0", "rot_1", "rot_2", "rot_3",
                    "f_dc_0", "f_dc_1", "f_dc_2"}
        names = set(self.property_names)
        if not required.issubset(names):
            return False
        if self.nonstandard_sh:
            return False
        # f_rest_* must be contiguous from 0 if present at all.
        if self.rest_count and not all(
            f"f_rest_{i}" in names for i in range(self.rest_count)
        ):
            return False
        return True

    def schema_key(self) -> tuple:
        """Identity used by the preflight check. Two frames of the same
        sequence must agree on every element of this tuple."""
        return (
            self.fmt,
            tuple((p.name, p.type, p.is_list) for p in self.vertex.properties),
        )

    def describe_issues(self) -> list[str]:
        """Non-fatal observations worth warning about."""
        issues = []
        if self.rest_count and self.rest_count not in SH_REST_COUNTS:
            issues.append(
                f"{self.path.name}: {self.rest_count} f_rest_* properties is not a "
                f"canonical SH count (0/9/24/45); treating as degree {self.sh_degree}"
            )
        if self.vertex.has_list:
            issues.append(f"{self.path.name}: vertex element contains a list property")
        expected = self.header_bytes + self.stride * self.splat_count
        if self.is_binary and not self.vertex.has_list and expected != self.file_size:
            issues.append(
                f"{self.path.name}: size mismatch — header implies {expected:,} bytes "
                f"but file is {self.file_size:,} bytes (truncated or extra elements?)"
            )
        return issues


def parse_header(path: Path, max_header: int = 1 << 20) -> PlySchema:
    """Parse a PLY header, reading only as far as `end_header`."""
    path = Path(path)
    with path.open("rb") as fh:
        blob = fh.read(max_header)
        file_size = path.stat().st_size

    if not blob.startswith(b"ply"):
        raise PlyError(f"{path.name}: not a PLY file (missing magic)")

    marker = blob.find(b"end_header")
    if marker < 0:
        raise PlyError(f"{path.name}: no end_header within {max_header} bytes")
    line_end = blob.find(b"\n", marker)
    if line_end < 0:
        raise PlyError(f"{path.name}: truncated end_header line")
    header_bytes = line_end + 1
    text = blob[:header_bytes].decode("ascii", errors="replace")

    fmt = None
    elements: list[Element] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("comment") or line.startswith("obj_info"):
            continue
        parts = line.split()
        head = parts[0]

        if head == "ply" or head == "end_header":
            continue
        if head == "format":
            if len(parts) < 2:
                raise PlyError(f"{path.name}: malformed format line: {line!r}")
            fmt = parts[1]
        elif head == "element":
            if len(parts) < 3:
                raise PlyError(f"{path.name}: malformed element line: {line!r}")
            elements.append(Element(name=parts[1], count=int(parts[2])))
        elif head == "property":
            if not elements:
                raise PlyError(f"{path.name}: property before any element: {line!r}")
            if parts[1] == "list":
                if len(parts) < 5:
                    raise PlyError(f"{path.name}: malformed list property: {line!r}")
                elements[-1].properties.append(
                    Property(name=parts[4], type=parts[3], is_list=True,
                             count_type=parts[2])
                )
            else:
                if len(parts) < 3:
                    raise PlyError(f"{path.name}: malformed property: {line!r}")
                if parts[1] not in PLY_TYPES:
                    raise PlyError(f"{path.name}: unknown property type {parts[1]!r}")
                elements[-1].properties.append(Property(name=parts[2], type=parts[1]))

    if fmt is None:
        raise PlyError(f"{path.name}: header has no format line")
    if fmt not in ("ascii", "binary_little_endian", "binary_big_endian"):
        raise PlyError(f"{path.name}: unsupported PLY format {fmt!r}")
    if not elements:
        raise PlyError(f"{path.name}: header declares no elements")

    schema = PlySchema(path=path, fmt=fmt, header_bytes=header_bytes,
                       elements=elements, file_size=file_size)
    schema.vertex  # raises if absent, so callers get the error at parse time
    return schema


def compute_bounds(schema: PlySchema) -> tuple[list[float], list[float]] | None:
    """Exact xyz min/max for one frame.

    Returns None rather than raising when bounds cannot be read cheaply
    (ascii PLY, list properties, or numpy unavailable) — bounds are an
    optional manifest nicety, never a hard requirement.
    """
    try:
        import numpy as np
    except ImportError:
        return None

    if not schema.is_binary or schema.vertex.has_list or schema.splat_count == 0:
        return None
    if schema.fmt == "binary_big_endian":
        return None

    names = schema.property_names
    try:
        idx = [names.index(a) for a in ("x", "y", "z")]
    except ValueError:
        return None

    props = schema.vertex.properties
    offsets = []
    running = 0
    for p in props:
        offsets.append(running)
        running += p.size

    # A structured dtype over the exact stride lets numpy read only x/y/z
    # columns from the memory map, never materializing the full frame.
    fields = {
        "x": (np.dtype(PLY_TYPES[props[idx[0]].type][0]), offsets[idx[0]]),
        "y": (np.dtype(PLY_TYPES[props[idx[1]].type][0]), offsets[idx[1]]),
        "z": (np.dtype(PLY_TYPES[props[idx[2]].type][0]), offsets[idx[2]]),
    }
    dtype = np.dtype({
        "names": list(fields),
        "formats": [f[0] for f in fields.values()],
        "offsets": [f[1] for f in fields.values()],
        "itemsize": schema.stride,
    })

    arr = np.memmap(schema.path, dtype=dtype, mode="r",
                    offset=schema.header_bytes, shape=(schema.splat_count,))
    try:
        mins, maxs = [], []
        for axis in ("x", "y", "z"):
            col = np.asarray(arr[axis], dtype=np.float64)
            col = col[np.isfinite(col)]
            if col.size == 0:
                return None
            mins.append(float(col.min()))
            maxs.append(float(col.max()))
        return mins, maxs
    finally:
        del arr


FRAME_NUM_RE = re.compile(r"(\d+)")


def frame_number(path: Path) -> int | None:
    """Extract a frame number from a filename.

    Uses the LAST digit run in the stem, so `excavator.anim.0042.ply` and
    `shot2_frame_0042.ply` both yield 42. Sorting is always numeric — never
    lexical.
    """
    matches = FRAME_NUM_RE.findall(Path(path).stem)
    return int(matches[-1]) if matches else None
