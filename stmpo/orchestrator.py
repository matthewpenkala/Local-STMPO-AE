from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover
    psutil = None  # type: ignore


# -----------------------------
# Types
# -----------------------------

@dataclass
class ChildProc:
    popen: subprocess.Popen
    frame_range: Tuple[int, int]
    affinity: Optional[List[int]]
    psutil_proc: Optional[object]  # psutil.Process when available
    start_time: float


# -----------------------------
# Helpers: output patterns
# -----------------------------

def looks_like_sequence(path_str: str) -> bool:
    """Heuristic: True if output path looks like an image-sequence pattern."""
    return (
        re.search(r"\[[#0]+\]", path_str) is not None  # AE: [#####] or [00000]
        or re.search(r"#{3,}", path_str) is not None   # #### style
        or re.search(r"%0?\d*d", path_str) is not None # printf style, e.g. %04d
    )


def build_output_matcher(output_spec: str):
    """
    Builds a predicate Path->bool that returns True only for files that are render outputs.

    Supports:
      - AE style: prefix_[#####].png or prefix_[00000].png
      - hash: prefix_####.png
      - printf: prefix_%04d.png
      - single file: exact filename match
    """
    base = Path(output_spec).name

    # AE: prefix_[#####]suffix
    m = re.match(r"(.*)\[([#0]+)\](.*)", base)
    if m:
        prefix, token, suffix = m.group(1), m.group(2), m.group(3)
        digits = len(token)
        rx = re.compile(rf"^{re.escape(prefix)}\d{{{digits}}}{re.escape(suffix)}$", re.IGNORECASE)
        return lambda p: bool(rx.match(p.name))

    # Hash: prefix####suffix
    m = re.match(r"(.*?)(#{3,})(\.[^.]*)?$", base)
    if m:
        prefix, hashes, ext = m.group(1), m.group(2), m.group(3) or ""
        digits = len(hashes)
        rx = re.compile(rf"^{re.escape(prefix)}\d{{{digits}}}{re.escape(ext)}$", re.IGNORECASE)
        return lambda p: bool(rx.match(p.name))

    # printf: prefix%04dsuffix
    m = re.match(r"(.*)%0?(\d*)d(.*)", base)
    if m:
        prefix, digits_s, suffix = m.group(1), m.group(2), m.group(3)
        digits = int(digits_s) if digits_s else 1
        rx = re.compile(rf"^{re.escape(prefix)}\d{{{digits}}}{re.escape(suffix)}$", re.IGNORECASE)
        return lambda p: bool(rx.match(p.name))

    # Single file
    return lambda p: p.name.lower() == base.lower()


# -----------------------------
# Helpers: logging & env
# -----------------------------

def setup_logging(log_file: Optional[str]) -> logging.Logger:
    logger = logging.getLogger("stmpo")
    logger.setLevel(logging.INFO)
    logger.propagate = False

    # Clear handlers if re-run in same interpreter
    for h in list(logger.handlers):
        logger.removeHandler(h)

    formatter = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    handler: logging.Handler
    if log_file:
        handler = logging.FileHandler(log_file, encoding="utf-8")
    else:
        handler = logging.StreamHandler(sys.stdout)

    handler.setFormatter(formatter)
    logger.addHandler(handler)
    return logger


def find_ffmpeg() -> Optional[str]:
    """Return an ffmpeg executable path if available, else None.

    Order:
      1) $FFMPEG environment var (explicit path)
      2) ffmpeg on PATH
    """
    env = os.environ.get("FFMPEG")
    if env:
        p = Path(env).expanduser()
        if p.exists():
            return str(p)
    return shutil.which("ffmpeg")


def _ffconcat_escape_path(p: Path) -> str:
    # concat demuxer list syntax uses single quotes; escape single quotes if present.
    s = str(p)
    return s.replace("'", "'\\''")


def ffmpeg_concat_segments(
    *,
    ffmpeg_path: str,
    segments: List[Path],
    output_file: Path,
    work_dir: Path,
    log: logging.Logger,
    allow_reencode: bool = True,
) -> bool:
    """Concatenate segment movies using ffmpeg.

    - First attempts stream copy (fast, no quality loss)
    - If stream-copy fails and allow_reencode=True, retries with a sensible re-encode
      based on output extension.
    """

    if not segments:
        log.error("ffmpeg_concat_segments: no segments provided")
        return False

    work_dir.mkdir(parents=True, exist_ok=True)
    list_file = work_dir / "concat_list.txt"
    try:
        with open(list_file, "w", encoding="utf-8") as f:
            f.write("ffconcat version 1.0\n")
            for seg in segments:
                f.write(f"file '{_ffconcat_escape_path(seg)}'\n")
    except Exception as e:
        log.error("Failed to write ffmpeg concat list: %s", e)
        return False

    def _run(cmd: List[str]) -> Tuple[bool, str]:
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(work_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            out = proc.stdout or ""
            ok = proc.returncode == 0
            if not ok:
                log.warning("ffmpeg failed (rc=%s). Output:\n%s", proc.returncode, out)
            else:
                log.info("ffmpeg ok. Output:\n%s", out)
            return ok, out
        except Exception as e:
            log.error("ffmpeg invocation error: %s", e)
            return False, str(e)

    # 1) stream copy
    copy_cmd = [
        ffmpeg_path,
        "-hide_banner",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_file),
        "-map",
        "0",
        "-c",
        "copy",
    ]
    # Faststart helps for mov/mp4.
    if output_file.suffix.lower() in (".mov", ".mp4"):
        copy_cmd += ["-movflags", "+faststart"]
    copy_cmd += [str(output_file)]

    log.info("ffmpeg concat (stream-copy): %s", " ".join(copy_cmd))
    ok, _ = _run(copy_cmd)
    if ok:
        return True

    if not allow_reencode:
        return False

    # 2) re-encode fallback
    ext = output_file.suffix.lower()
    if ext == ".mov":
        # Reasonable ProRes HQ fallback.
        vcodec = ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]
        # Try to copy audio first; if that fails we'll re-encode audio too.
        acodec_primary = ["-c:a", "copy"]
        acodec_fallback = ["-c:a", "pcm_s16le"]
    elif ext == ".mp4":
        vcodec = ["-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p"]
        acodec_primary = ["-c:a", "copy"]
        acodec_fallback = ["-c:a", "aac", "-b:a", "320k"]
    else:
        # Generic safe defaults.
        vcodec = ["-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p"]
        acodec_primary = ["-c:a", "copy"]
        acodec_fallback = ["-c:a", "aac", "-b:a", "320k"]

    reenc_cmd = [
        ffmpeg_path,
        "-hide_banner",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_file),
        "-map",
        "0",
    ] + vcodec + acodec_primary
    if output_file.suffix.lower() in (".mov", ".mp4"):
        reenc_cmd += ["-movflags", "+faststart"]
    reenc_cmd += [str(output_file)]

    log.info("ffmpeg concat (re-encode): %s", " ".join(reenc_cmd))
    ok, _ = _run(reenc_cmd)
    if ok:
        return True

    # 3) re-encode audio too
    reenc_cmd2 = [
        ffmpeg_path,
        "-hide_banner",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(list_file),
        "-map",
        "0",
    ] + vcodec + acodec_fallback
    if output_file.suffix.lower() in (".mov", ".mp4"):
        reenc_cmd2 += ["-movflags", "+faststart"]
    reenc_cmd2 += [str(output_file)]

    log.info("ffmpeg concat (re-encode v+a): %s", " ".join(reenc_cmd2))
    ok, _ = _run(reenc_cmd2)
    return ok


def _popen_kwargs_for_child() -> dict:
    """Platform-specific kwargs so we can reliably terminate aerender and its child processes."""
    if os.name == "nt":
        # CREATE_NEW_PROCESS_GROUP lets us deliver CTRL_BREAK_EVENT / terminate without killing the parent process.
        # It's defined only on Windows.
        return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}
    # POSIX: start a new session so we can kill the whole process group (aerender can spawn helpers).
    return {"start_new_session": True}


def _terminate_process_tree(proc: subprocess.Popen | None, logger: logging.Logger, grace_sec: float = 5.0) -> None:
    """Best-effort graceful terminate, then hard-kill (including process group on POSIX)."""
    if not proc:
        return
    if proc.poll() is not None:
        return

    # Graceful
    try:
        if os.name != "nt":
            try:
                os.killpg(proc.pid, signal.SIGTERM)
                logger.info("Sent SIGTERM to process group pgid=%s.", proc.pid)
            except Exception:
                proc.terminate()
        else:
            proc.terminate()
    except Exception:
        logger.exception("Failed to send graceful termination to child.")
        return

    t0 = time.time()
    while time.time() - t0 < grace_sec:
        if proc.poll() is not None:
            return
        time.sleep(0.2)

    # Hard kill
    try:
        if os.name != "nt":
            try:
                os.killpg(proc.pid, signal.SIGKILL)
                logger.warning("Sent SIGKILL to process group pgid=%s.", proc.pid)
            except Exception:
                proc.kill()
        else:
            # Try to kill the whole tree on Windows.
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            except Exception:
                proc.kill()
    except Exception:
        logger.exception("Failed to hard-kill child.")


def load_env_overrides(env_file: Optional[str]) -> Dict[str, str]:
    if not env_file:
        return {}
    p = Path(env_file)
    if not p.exists():
        return {}
    with p.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return {str(k): str(v) for k, v in data.items()}


def stream_reader(pid: int, stream, out_q: queue.Queue, tag: str):
    """Read lines from child stream and push to queue for the main loop to log."""
    try:
        for line in iter(stream.readline, ""):
            if not line:
                break
            out_q.put((pid, tag, line.rstrip("\n")))
    finally:
        try:
            stream.close()
        except Exception:
            pass


# -----------------------------
# Helpers: chunking / splitting
# -----------------------------

def split_ranges(start: int, end: int, parts: int) -> List[Tuple[int, int]]:
    total = end - start + 1
    if parts <= 0:
        parts = 1
    if parts > total:
        parts = total

    base = total // parts
    rem = total % parts

    ranges: List[Tuple[int, int]] = []
    cur = start
    for i in range(parts):
        span = base + (1 if i < rem else 0)
        s = cur
        e = cur + span - 1
        ranges.append((s, e))
        cur = e + 1
    return ranges


# -----------------------------
# Helpers: project staging
# -----------------------------

def _is_unc_path(p: str) -> bool:
    # Windows UNC (\\server\share\...)
    return p.startswith("\\\\") or p.startswith("//")


def stage_project_to_local(project_path: str, local_scratch_dir: Path, logger: logging.Logger) -> str:
    """
    Best-effort copy of the .aep/.aepx into local scratch.
    This can reduce hangs when opening projects from SMB/NAS locations.
    """
    try:
        src = Path(project_path)
        if not src.exists():
            return project_path

        # Heuristic: stage if UNC / network-looking, or if explicitly requested elsewhere
        needs_stage = _is_unc_path(str(project_path))
        if not needs_stage:
            # still stage if the path is on a different device and scratch is enabled
            # (cheap and safe for debug)
            needs_stage = True

        if not needs_stage:
            return project_path

        staging_dir = local_scratch_dir / "_project"
        staging_dir.mkdir(parents=True, exist_ok=True)
        dest = staging_dir / src.name

        # If already staged, keep it
        try:
            same = os.path.samefile(src, dest)
        except Exception:
            same = str(src.resolve()) == str(dest.resolve()) if sys.platform != "win32" else str(src).lower() == str(dest).lower()
        if same:
            return project_path

        for attempt in range(1, 4):
            try:
                shutil.copy2(str(src), str(dest))
                logger.info(f"Staged project locally: {src} -> {dest}")
                return str(dest)
            except Exception as ex:
                logger.warning(f"Project staging attempt {attempt}/3 failed: {ex}")
                time.sleep(0.5 * attempt)

    except Exception as ex:
        logger.warning(f"Project staging failed (continuing with original path): {ex}")

    return project_path


# -----------------------------
# Concurrency (auto)
# -----------------------------

def _cpu_count() -> int:
    try:
        c = os.cpu_count() or 0
        return int(c)
    except Exception:
        return 0


def get_total_ram_native(logger: logging.Logger) -> float:
    """
    Authoritatively derive total system RAM (in GB) using OS-native calls
    when psutil is unavailable.
    """
    # 1. Try psutil (Gold Standard - easiest/fastest)
    if psutil is not None:
        try:
            vm = psutil.virtual_memory()
            return float(vm.total) / (1024 ** 3)
        except Exception:
            pass

    # 2. Native Fallbacks (The "Authoritative" Backup)
    try:
        # WINDOWS: Use WMI (Windows Management Instrumentation)
        if sys.platform == "win32":
            # 'wmic' is standard on all Windows versions (XP through 11/Server)
            cmd = ["wmic", "computersystem", "get", "TotalPhysicalMemory"]
            # Output format:
            # TotalPhysicalMemory
            # 34359738368
            out = subprocess.check_output(cmd, text=True).strip().split('\n')
            for line in out:
                clean = line.strip()
                if clean.isdigit():
                    return float(clean) / (1024 ** 3)

        # MACOS: Use sysctl (System Control)
        elif sys.platform == "darwin":
            # 'hw.memsize' is the kernel parameter for physical RAM
            cmd = ["sysctl", "-n", "hw.memsize"]
            out = subprocess.check_output(cmd, text=True).strip()
            if out.isdigit():
                return float(out) / (1024 ** 3)

        # LINUX: Use /proc/meminfo (Standard Kernel Interface)
        elif sys.platform.startswith("linux"):
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    if "MemTotal" in line:
                        # Format: MemTotal:        16326644 kB
                        parts = line.split()
                        # Convert kB to GB
                        return float(parts[1]) / (1024 * 1024)

    except Exception as ex:
        logger.debug(f"Native RAM detection failed: {ex}")

    return 0.0


def auto_concurrency(args: argparse.Namespace, logger: logging.Logger) -> int:
    """
    Pick a reasonable concurrency based on:
      - logical CPUs
      - total RAM (if psutil is available)
      - requested max_concurrency
      - MFR on/off hint
    """
    logical = _cpu_count()
    max_c = int(getattr(args, "max_concurrency", 24) or 24)
    if logical <= 0:
        return max(1, min(4, max_c))

    # RAM budget (Authoritative with Fallback)
    total_ram_gb = get_total_ram_native(logger)

    try:
        ram_per_proc_gb = float(getattr(args, "ram_per_process_gb", 32.0) or 32.0)
    except Exception:
        ram_per_proc_gb = 32.0
    if ram_per_proc_gb <= 0:
        ram_per_proc_gb = 32.0

    usable_ram_gb = total_ram_gb * 0.80 if total_ram_gb > 0 else 0.0
    max_by_ram = int(usable_ram_gb // ram_per_proc_gb) if usable_ram_gb > 0 else logical

    # Thread-based limit (rough heuristic)
    try:
        mfr_threads = int(getattr(args, "mfr_threads", 0) or 0)
    except Exception:
        mfr_threads = 0

    if getattr(args, "disable_mfr", False):
        target_threads_per_proc = max(8, mfr_threads or 8)
    else:
        target_threads_per_proc = max(16, mfr_threads or 16)

    base_by_threads = max(1, logical // target_threads_per_proc)
    base = max(1, min(max_c, max_by_ram, base_by_threads, logical))

    logger.info(
        "Auto concurrency=%s (logical=%s, total_ram_gb=%.1f, ram_per_proc_gb=%.1f, max_by_ram=%s, base_by_threads=%s, mfr=%s)",
        base, logical, total_ram_gb, ram_per_proc_gb, max_by_ram, base_by_threads, "OFF" if getattr(args, "disable_mfr", False) else "ON"
    )
    return base


# -----------------------------
# Affinity (optional)
# -----------------------------

def load_numa_nodes(numa_map_path: str, logger: logging.Logger) -> Dict[str, List[int]]:
    p = Path(numa_map_path)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as ex:
        logger.warning(f"Failed to read NUMA map {p}: {ex}")
        return {}

    out: Dict[str, List[int]] = {}
    if not isinstance(data, dict):
        logger.warning("NUMA map must be a JSON object: {\"node0\": [0,1,...], ...}")
        return {}

    for k, v in data.items():
        if isinstance(v, list):
            try:
                cpus = [int(x) for x in v]
            except Exception:
                continue
            cpus = [c for c in cpus if c >= 0]
            if cpus:
                out[str(k)] = cpus
    return out


def build_affinity_blocks(concurrency: int, pools: List[List[int]]) -> List[List[int]]:
    if concurrency <= 0:
        return []
    all_cpus: List[int] = []
    for p in pools:
        all_cpus.extend(p)
    all_cpus = list(dict.fromkeys(all_cpus))
    if not all_cpus:
        return []

    blocks: List[List[int]] = [[] for _ in range(concurrency)]
    for i, cpu in enumerate(all_cpus):
        blocks[i % concurrency].append(cpu)
    return blocks


def apply_affinity(proc_obj, affinity: Optional[List[int]], logger: logging.Logger) -> Optional[List[int]]:
    if not affinity:
        return None
    if psutil is None:
        return None

    try:
        p = proc_obj if hasattr(proc_obj, "cpu_affinity") else psutil.Process(proc_obj.pid)  # type: ignore
        if not hasattr(p, "cpu_affinity"):
            return None

        cleaned: List[int] = []
        for cpu in affinity:
            try:
                cid = int(cpu)
            except Exception:
                continue
            if cid >= 0 and cid not in cleaned:
                cleaned.append(cid)

        if not cleaned:
            return None

        p.cpu_affinity(cleaned)  # type: ignore
        return cleaned
    except Exception as ex:
        logger.debug(f"Could not apply affinity to pid={getattr(proc_obj, 'pid', 'n/a')}: {ex}")
        return None


# -----------------------------
# Offloader (scratch → final)
# -----------------------------

def offload_loop(
    local_dir: Path,
    final_dir: Path,
    matcher,
    stop_event: threading.Event,
    logger: logging.Logger,
    poll_sec: float = 0.75,
) -> None:
    copied: set[str] = set()
    final_dir.mkdir(parents=True, exist_ok=True)

    while not stop_event.is_set():
        try:
            for p in local_dir.iterdir():
                if not p.is_file():
                    continue
                if not matcher(p):
                    continue
                key = p.name.lower() if sys.platform == "win32" else p.name
                if key in copied:
                    continue

                dest = final_dir / p.name
                try:
                    shutil.copy2(str(p), str(dest))
                    copied.add(key)
                except Exception as ex:
                    logger.debug(f"Offload copy failed for {p.name}: {ex}")

        except Exception:
            pass

        time.sleep(poll_sec)

    logger.info("Offloader stopped.")


# -----------------------------
# Aerender command builder
# -----------------------------

def build_aerender_cmd(
    args: argparse.Namespace,
    s: int,
    e: int,
    output_path: str,  # local path
) -> List[str]:
    # aerender supports -sound ON|OFF
    sound_flag = str(getattr(args, "sound", "ON") or "ON").upper()
    if sound_flag not in ("ON", "OFF"):
        sound_flag = "ON"

    cmd: List[str] = [
        args.aerender_path,
        "-project", args.project,
        "-output", output_path,
        "-sound", sound_flag,
        "-s", str(s),
        "-e", str(e),
    ]

    if args.comp:
        cmd += ["-comp", args.comp]
    if args.rqindex is not None:
        cmd += ["-rqindex", str(args.rqindex)]
    if getattr(args, "rs_template", None):
        cmd += ["-RStemplate", args.rs_template]
    if getattr(args, "om_template", None):
        cmd += ["-OMtemplate", args.om_template]

    # MFR control: aerender supports '-mfr ON|OFF <percent>'
    mfr_flag = "OFF" if getattr(args, "disable_mfr", False) else "ON"
    cmd += ["-mfr", mfr_flag, "100"]

    return cmd


# -----------------------------
# CLI
# -----------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="STMPO Local After Effects Orchestrator (aerender)")

    p.add_argument("--project", required=True, help="Path to .aep/.aepx project")
    p.add_argument("--comp", default=None, help="Optional comp name")
    p.add_argument("--rqindex", type=int, default=None, help="Optional render queue index")
    p.add_argument("--output", required=True, help="Final output path (pattern or single file)")
    p.add_argument("--sound", default="ON", help="aerender audio. ON (default) or OFF")

    p.add_argument("--start", type=int, required=True, help="Start frame (inclusive)")
    p.add_argument("--end", type=int, required=True, help="End frame (inclusive)")

    p.add_argument("--concurrency", type=int, default=0, help="Child process count. 0=auto.")
    p.add_argument("--max_concurrency", type=int, default=24, help="Upper bound when concurrency=0 auto.")
    p.add_argument("--ram_per_process_gb", type=float, default=32.0, help="Used by auto-concurrency heuristic.")
    p.add_argument("--mfr_threads", type=int, default=0, help="Hint used by auto-concurrency heuristic.")

    p.add_argument("--disable_mfr", action="store_true", help="Force aerender -mfr OFF for children.")

    p.add_argument("--aerender_path", default=None, help="Path to aerender executable (optional, auto-discovered)")
    p.add_argument("--after_effects_dir", default=None, help="Optional AE install folder (helps auto-discovery).")

    p.add_argument("--scratch_root", default=None, help="Scratch root folder (default: OS temp + /stmpo_ae)")
    p.add_argument("--no_scratch", action="store_true", help="Render directly to final output path (no scratch/offload).")
    p.add_argument("--stage_project", action="store_true", default=True, help="Stage project to local scratch (default: on)")
    p.add_argument("--no_stage_project", dest="stage_project", action="store_false", help="Disable local project staging.")

    p.add_argument("--spawn_delay", type=float, default=2.0, help="Delay between child spawns.")
    p.add_argument("--child_grace_sec", type=float, default=10.0, help="Seconds before warning about silent children.")
    p.add_argument("--kill_on_fail", action="store_true", default=False, help="If any child fails, terminate the rest.")

    p.add_argument("--disable_affinity", action="store_true", default=False, help="Disable CPU affinity.")
    p.add_argument("--numa_map", default=None, help="Path to NUMA map JSON (Windows/Linux only).")

    p.add_argument("--rs_template", default=None)
    p.add_argument("--om_template", default=None)

    p.add_argument("--env_file", default=None, help="JSON env var overrides applied to each child")
    p.add_argument("--log_file", default=None, help="Log file path (default: stdout)")
    p.add_argument("--dry_run", action="store_true", help="Print ranges/commands without running aerender")

    p.add_argument("--output_is_pattern", action="store_true", help="Force output to be treated as sequence pattern.")
    return p


# -----------------------------
# Entry
# -----------------------------

def run_orchestrator(args: argparse.Namespace, logger: logging.Logger, resolve_aerender_fn) -> int:
    # Resolve aerender path
    args.aerender_path = resolve_aerender_fn(args.aerender_path, args.after_effects_dir, logger)

    # Useful for external controllers
    try:
        logger.info("Runner pid=%s", os.getpid())
    except Exception:
        pass

    # Ensure output dir exists
    final_output_path = Path(args.output)
    final_output_dir = final_output_path.parent
    final_output_dir.mkdir(parents=True, exist_ok=True)

    # Decide if we can parallelize
    total_frames = args.end - args.start + 1
    output_is_seq = bool(getattr(args, "output_is_pattern", False)) or looks_like_sequence(str(final_output_path))
    requested = int(args.concurrency or 0)
    if requested < 0:
        requested = 0

    # Compute concurrency (auto or user-specified)
    concurrency = requested if requested >= 1 else auto_concurrency(args, logger)
    if total_frames <= 1:
        concurrency = 1

    # IMPORTANT: aeRender cannot safely have multiple processes writing to the *same single* output file.
    # However, we *can* parallelize by rendering per-range segment files and stitching at the end with ffmpeg.
    # This is only attempted if:
    #   - output is a single file (NOT an image sequence)
    #   - total_frames > 1
    #   - concurrency > 1
    #   - ffmpeg is available
    single_file_concat_mode = (total_frames > 1 and not output_is_seq and concurrency > 1)
    ffmpeg_path: Optional[str] = None
    if single_file_concat_mode:
        ffmpeg_path = find_ffmpeg()
        if not ffmpeg_path:
            logger.warning(
                "Single-file output detected (%s) with concurrency=%s, but ffmpeg was not found. "
                "Falling back to concurrency=1. (Install ffmpeg or set $FFMPEG to enable segment stitching.)",
                final_output_path,
                concurrency,
            )
            single_file_concat_mode = False
            concurrency = 1
        else:
            logger.info(
                "Single-file output detected (%s). Using segmented renders (concurrency=%s) + ffmpeg stitching (%s).",
                final_output_path,
                concurrency,
                ffmpeg_path,
            )

    ranges = split_ranges(args.start, args.end, concurrency)
    logger.info("Frame ranges: %s", ranges)

    # Scratch + staging
    use_scratch = not bool(args.no_scratch)
    scratch_root = args.scratch_root or os.environ.get("STMPO_SCRATCH_ROOT") or str(Path(tempfile.gettempdir()) / "stmpo_ae")
    scratch_root_path = Path(scratch_root)

    run_id = str(uuid.uuid4())[:8]
    local_scratch_dir = scratch_root_path / f"job_{run_id}"
    local_output_path = final_output_path

    if use_scratch:
        local_scratch_dir.mkdir(parents=True, exist_ok=True)
        local_output_path = local_scratch_dir / final_output_path.name
        logger.info("Scratch enabled: %s", local_scratch_dir)

        if args.stage_project:
            args.project = stage_project_to_local(args.project, local_scratch_dir, logger)

    # If we're chunking a *single-file* output, render each chunk to its own temp file,
    # then stitch into local_output_path using ffmpeg.
    segment_outputs: List[Path] = []
    segment_dir: Optional[Path] = None
    if single_file_concat_mode and concurrency > 1:
        # Keep segments in a subfolder so the background offloader (if enabled) doesn't
        # try to copy partial segment files.
        if use_scratch:
            segment_dir = local_scratch_dir / "_segments"
        else:
            segment_dir = final_output_path.parent / f".stmpo_segments_{run_id}"
        segment_dir.mkdir(parents=True, exist_ok=True)

        ext = final_output_path.suffix or ""
        base = final_output_path.stem or "render"
        for idx, (s, e) in enumerate(ranges, start=1):
            seg_name = f"{base}__part_{idx:03d}_{s}-{e}{ext}"
            segment_outputs.append(segment_dir / seg_name)
        # Avoid accidentally picking up stale segments from a previous failed run.
        for seg in segment_outputs:
            try:
                if seg.exists():
                    seg.unlink()
            except Exception as ex:
                logger.warning("Could not remove existing segment %s: %s", seg, ex)
        logger.info("Segment render mode: %s segment(s) -> %s", len(segment_outputs), segment_dir)

    # Offloader
    stop_offload_event = threading.Event()
    offloader_thread: Optional[threading.Thread] = None
    if use_scratch:
        matcher = build_output_matcher(str(final_output_path)) if output_is_seq else (lambda p: p.name.lower() == final_output_path.name.lower())
        offloader_thread = threading.Thread(
            target=offload_loop,
            args=(local_scratch_dir, final_output_dir, matcher, stop_offload_event, logger),
            daemon=True,
        )
        offloader_thread.start()
        logger.info("Offloader started (scratch → final).")

    # Affinity blocks
    affinities: List[Optional[List[int]]] = [None] * concurrency
    if not args.disable_affinity and psutil is not None and hasattr(psutil.Process(), "cpu_affinity"):
        if args.numa_map:
            nodes = load_numa_nodes(args.numa_map, logger)
            pools = [v for _, v in sorted(nodes.items())] if nodes else []
            blocks = build_affinity_blocks(concurrency, pools)
            if blocks:
                affinities = [b for b in blocks] + [None] * max(0, concurrency - len(blocks))
                logger.info("Affinity blocks prepared: %s", len(blocks))

    # Environment
    env_overrides = load_env_overrides(args.env_file)
    child_env = dict(os.environ)
    child_env.update(env_overrides)

    # Dry run: print commands and exit
    if args.dry_run:
        for i, (s, e) in enumerate(ranges):
            child_out = segment_outputs[i] if segment_outputs else local_output_path
            cmd = build_aerender_cmd(args, s, e, str(child_out))
            logger.info("DRY RUN child[%s]: %s", i, " ".join(cmd))
        stop_offload_event.set()
        if offloader_thread:
            offloader_thread.join(timeout=1.0)
        return 0

    # Spawn children
    children: List[ChildProc] = []
    out_q: queue.Queue = queue.Queue()
    stop_children_event = threading.Event()

    def cleanup_resources():
        stop_children_event.set()
        for ch in children:
            try:
                _terminate_process_tree(ch.popen, logger, grace_sec=2.0)
            except Exception:
                pass
        stop_offload_event.set()
        if offloader_thread and offloader_thread.is_alive():
            offloader_thread.join(timeout=2.0)

        if use_scratch:
            # best-effort cleanup
            try:
                shutil.rmtree(str(local_scratch_dir), ignore_errors=True)
            except Exception:
                pass

    # Signal handlers
    def _sig_handler(signum, frame):
        logger.warning("Received signal %s. Shutting down…", signum)
        cleanup_resources()

    signal.signal(signal.SIGINT, _sig_handler)
    signal.signal(signal.SIGTERM, _sig_handler)

    for i, (s, e) in enumerate(ranges):
        if stop_children_event.is_set():
            break
        if i > 0 and args.spawn_delay > 0:
            time.sleep(args.spawn_delay)

        child_out = segment_outputs[i] if segment_outputs else local_output_path
        cmd = build_aerender_cmd(args, s, e, str(child_out))
        logger.info("Launching child[%s] frames=%s-%s", i, s, e)
        logger.info("CMD: %s", " ".join(cmd))

        pop = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            universal_newlines=True,
            env=child_env,
        **_popen_kwargs_for_child(),
        )

        # Emit a PID-bearing line so UIs can map ranges<->pids.
        logger.info("Launched child[%s] pid=%s frames=%s-%s", i, pop.pid, s, e)

        ps_proc = None
        if psutil is not None:
            try:
                ps_proc = psutil.Process(pop.pid)
            except Exception:
                ps_proc = None

        aff = apply_affinity(ps_proc or pop, affinities[i] if i < len(affinities) else None, logger)

        child = ChildProc(pop, (s, e), aff, ps_proc, time.time())
        children.append(child)

        # log streaming threads
        if pop.stdout:
            threading.Thread(target=stream_reader, args=(pop.pid, pop.stdout, out_q, "STDOUT"), daemon=True).start()
        if pop.stderr:
            threading.Thread(target=stream_reader, args=(pop.pid, pop.stderr, out_q, "STDERR"), daemon=True).start()

    # Monitor loop
    last_output_time: Dict[int, float] = {ch.popen.pid: time.time() for ch in children}
    failures: List[int] = []

    while True:
        # Drain output queue
        drained = False
        try:
            while True:
                pid, tag, line = out_q.get_nowait()
                drained = True
                last_output_time[pid] = time.time()
                logger.info(f"[{pid} {tag}] {line}")
        except queue.Empty:
            pass

        # Periodic silent-child warnings
        now = time.time()
        for ch in children:
            if ch.popen.poll() is not None:
                continue
            last = last_output_time.get(ch.popen.pid, ch.start_time)
            if now - last > float(args.child_grace_sec):
                # warn once per interval
                last_output_time[ch.popen.pid] = now
                cpu = mem = "n/a"
                if psutil is not None and ch.psutil_proc is not None:
                    try:
                        cpu = f"{ch.psutil_proc.cpu_percent(interval=0.0):.1f}%"
                        mem = f"{ch.psutil_proc.memory_info().rss / (1024**2):.1f}MB"
                    except Exception:
                        pass
                logger.warning(f"Child pid={ch.popen.pid} produced no output for {args.child_grace_sec}s (cpu={cpu}, rss={mem}).")

        # Check completion
        all_done = True
        for ch in children:
            rc = ch.popen.poll()
            if rc is None:
                all_done = False
                continue
            if rc != 0 and ch.popen.pid not in failures:
                failures.append(ch.popen.pid)
                logger.error("Child pid=%s failed with rc=%s (frames=%s-%s).", ch.popen.pid, rc, ch.frame_range[0], ch.frame_range[1])
                if args.kill_on_fail:
                    logger.error("kill_on_fail enabled -> terminating remaining children.")
                    cleanup_resources()
                    break

        if all_done:
            break

        if not drained:
            time.sleep(0.15)

    # Stop offloader and finalize
    # If we rendered multiple segments to support concurrent rendering of a single-file output,
    # stitch the segments into the final output file using ffmpeg.
    if segment_outputs:
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            logger.error(
                "Concurrency produced %d segments, but ffmpeg was not found. "
                "Install ffmpeg or set $FFMPEG to its path, then re-run.",
                len(segment_outputs),
            )
            return 2

        # Sanity check: segments exist
        missing = [p for p in segment_outputs if not p.exists()]
        if missing:
            logger.error("Missing %d/%d segment file(s). Example: %s", len(missing), len(segment_outputs), missing[0])
            logger.error("Leaving scratch directory intact for debugging.")
            return 2

        logger.info("Stitching %d segment(s) -> %s", len(segment_outputs), local_output_path)
        ok = ffmpeg_concat_segments(ffmpeg, segment_outputs, local_output_path, logger)
        if not ok:
            logger.error("FFmpeg stitch failed. Leaving segments for debugging.")
            return 2

        # Clean up segments directory when possible (scratch cleanup below will remove it anyway).
        try:
            seg_dir = segment_outputs[0].parent
            shutil.rmtree(str(seg_dir), ignore_errors=True)
        except Exception:
            pass

    stop_offload_event.set()
    if offloader_thread:
        offloader_thread.join(timeout=5.0)

    # If scratch + single-file output, copy the file at end
    if use_scratch and not output_is_seq:
        try:
            src = local_output_path
            dst = final_output_path
            if src.exists():
                shutil.copy2(str(src), str(dst))
        except Exception as ex:
            logger.warning(f"Final single-file copy failed: {ex}")

    # Cleanup scratch
    if use_scratch:
        try:
            shutil.rmtree(str(local_scratch_dir), ignore_errors=True)
        except Exception:
            pass

    if stop_children_event.is_set() and not failures:
        rc = 130
    else:
        rc = 1 if failures else 0
    logger.info("Run complete rc=%s", rc)
    return rc


def main(resolve_aerender_fn) -> int:
    parser = build_parser()
    args = parser.parse_args()
    logger = setup_logging(args.log_file)
    return run_orchestrator(args, logger, resolve_aerender_fn)