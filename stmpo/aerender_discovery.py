from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import Iterable, List, Optional


def _dedupe_existing(paths: Iterable[Path]) -> List[Path]:
    seen = set()
    out: List[Path] = []
    for p in paths:
        try:
            rp = p.expanduser()
        except Exception:
            rp = p
        rp = Path(str(rp))
        if not rp:
            continue
        key = str(rp)
        if sys.platform == "win32":
            key = key.lower()
        if key in seen:
            continue
        if rp.exists():
            seen.add(key)
            out.append(rp)
    return out


def discover_aerender_candidates(after_effects_dir: Optional[str] = None) -> List[Path]:
    """
    Return a list of plausible aerender paths in priority order.
    This does not log; it only discovers.
    """
    candidates: List[Path] = []

    # 1) Explicit env vars
    for k in ("AERENDER_PATH", "AE_AERENDER_PATH"):
        v = os.environ.get(k)
        if v:
            candidates.append(Path(v))

    # 2) PATH
    for exe in ("aerender", "aerender.exe"):
        w = shutil.which(exe)
        if w:
            candidates.append(Path(w))

    # 3) User-specified install root
    if after_effects_dir:
        base = Path(after_effects_dir).expanduser()
        # Windows install layout
        candidates.append(base / "Support Files" / "aerender.exe")
        candidates.append(base / "Support Files" / "aerender")
        # macOS folder layout (aerender at top level)
        candidates.append(base / "aerender")

    # 4) OS defaults
    if sys.platform == "win32":
        roots = []
        for env in ("ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"):
            v = os.environ.get(env)
            if v:
                roots.append(Path(v))
        if not roots:
            roots = [Path(r"C:\Program Files"), Path(r"C:\Program Files (x86)")]

        # Typical: C:\Program Files\Adobe\Adobe After Effects 2024\Support Files\aerender.exe
        for r in roots:
            adobe = r / "Adobe"
            if not adobe.exists():
                continue
            candidates.extend(adobe.glob("Adobe After Effects */Support Files/aerender.exe"))
            # Some installs don't include "Adobe " prefix
            candidates.extend(adobe.glob("After Effects */Support Files/aerender.exe"))

    elif sys.platform == "darwin":
        apps = Path("/Applications")
        if apps.exists():
            # Typical: /Applications/Adobe After Effects 2024/aerender
            candidates.extend(apps.glob("Adobe After Effects */aerender"))
            # Beta / other naming
            candidates.extend(apps.glob("After Effects */aerender"))

    # Linux is not supported by AE; we still allow AERENDER_PATH or PATH.
    return _dedupe_existing(candidates)


def resolve_aerender_path(
    aerender_path: Optional[str],
    after_effects_dir: Optional[str],
    logger,
) -> str:
    """
    Resolve aerender path from CLI/env/auto-discovery. Raises SystemExit on failure.
    """
    if aerender_path and str(aerender_path).strip() and str(aerender_path).strip().upper() not in ("NONE", "__NONE__", "NULL"):
        p = Path(os.path.expandvars(os.path.expanduser(str(aerender_path).strip())))
        if p.exists():
            logger.info(f"Using aerender executable: {p}")
            return str(p)

    cands = discover_aerender_candidates(after_effects_dir=after_effects_dir)
    for c in cands:
        if c.exists():
            logger.info(f"Auto-located aerender: {c}")
            return str(c)

    msg = (
        "Could not locate the After Effects aerender executable.\n"
        "Provide --aerender_path, set AERENDER_PATH, or ensure aerender is discoverable.\n"
        "Notes:\n"
        "  • Windows default: C:\\Program Files\\Adobe\\Adobe After Effects 20XX\\Support Files\\aerender.exe\n"
        "  • macOS default: /Applications/Adobe After Effects 20XX/aerender\n"
    )
    logger.critical(msg)
    raise SystemExit(1)
