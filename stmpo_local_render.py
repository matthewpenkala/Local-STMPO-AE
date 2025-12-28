#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Optional, Tuple

from stmpo.frame_spec import select_task_range
from stmpo.orchestrator import run_orchestrator, setup_logging
from stmpo.aerender_discovery import resolve_aerender_path


def _range_from_args(args) -> Tuple[int, int]:
    # Priority: explicit start/end, else frames-based selection.
    if args.start is not None and args.end is not None:
        return int(args.start), int(args.end)

    if not args.frames:
        raise SystemExit("You must provide either --start/--end OR --frames.")

    s, e = select_task_range(args.frames, args.chunk_size, args.index)
    return int(s), int(e)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Local debug runner: parallel/segmented aerender (STMPO-style) without Deadline Cloud."
    )

    # Core AE render args
    p.add_argument("--project", required=True, help="Path to .aep/.aepx project")
    p.add_argument("--comp", default=None, help="Optional comp name")
    p.add_argument("--rqindex", type=int, default=None, help="Optional render queue index")
    p.add_argument("--output", required=True, help="Final output path (pattern or single file)")
    p.add_argument("--sound", default="ON", help="aerender audio. ON (default) or OFF")

    # Range selection:
    p.add_argument("--start", type=int, default=None, help="Start frame (inclusive)")
    p.add_argument("--end", type=int, default=None, help="End frame (inclusive)")
    p.add_argument("--frames", default=None, help='Framespec like "1-300" or "1-100,150-200"')
    p.add_argument("--chunk_size", type=int, default=None, help="If set, select a chunk from --frames")
    p.add_argument("--index", type=int, default=None, help="0-based chunk index (used with --chunk_size)")

    # Orchestration knobs
    p.add_argument("--concurrency", type=int, default=0, help="Child process count. 0=auto.")
    p.add_argument("--max_concurrency", type=int, default=24, help="Upper bound when concurrency=0 auto.")
    p.add_argument("--ram_per_process_gb", type=float, default=32.0, help="Used by auto-concurrency heuristic.")
    p.add_argument("--mfr_threads", type=int, default=0, help="Hint used by auto-concurrency heuristic.")
    p.add_argument("--disable_mfr", action="store_true", help="Force aerender -mfr OFF for children.")

    # aerender discovery
    p.add_argument("--aerender_path", default=None, help="Path to aerender executable (optional, auto-discovered)")
    p.add_argument("--after_effects_dir", default=None, help="Optional AE install folder (helps auto-discovery).")

    # Scratch/offload
    p.add_argument("--scratch_root", default=None, help="Scratch root folder (default: OS temp + /stmpo_ae)")
    p.add_argument("--no_scratch", action="store_true", help="Render directly to final output path (no scratch/offload).")
    p.add_argument("--stage_project", action="store_true", default=True, help="Stage project to local scratch (default: on)")
    p.add_argument("--no_stage_project", dest="stage_project", action="store_false", help="Disable local project staging.")

    # Child behavior
    p.add_argument("--spawn_delay", type=float, default=2.0, help="Delay between child spawns.")
    p.add_argument("--child_grace_sec", type=float, default=10.0, help="Seconds before warning about silent children.")
    p.add_argument("--kill_on_fail", action="store_true", default=False, help="If any child fails, terminate the rest.")

    # Affinity
    p.add_argument("--disable_affinity", action="store_true", default=False, help="Disable CPU affinity.")
    p.add_argument("--numa_map", default=None, help="Path to NUMA map JSON (Windows/Linux only).")

    # Templates
    p.add_argument("--rs_template", default=None)
    p.add_argument("--om_template", default=None)

    # Env/logging
    p.add_argument("--env_file", default=None, help="JSON env var overrides applied to each child")
    p.add_argument("--log_file", default=None, help="Log file path (default: stdout)")
    p.add_argument("--pid_file", default=None, help="If set, write this runner's PID to the given path")
    p.add_argument("--dry_run", action="store_true", help="Print ranges/commands without running aerender")

    p.add_argument("--output_is_pattern", action="store_true", help="Force output to be treated as sequence pattern.")
    return p


def main() -> int:
    p = build_parser()
    args = p.parse_args()

    s, e = _range_from_args(args)
    args.start = s
    args.end = e

    logger = setup_logging(args.log_file)

    # Write runner PID early for external controllers (e.g., .jsx UI)
    if args.pid_file:
        try:
            Path(args.pid_file).parent.mkdir(parents=True, exist_ok=True)
            Path(args.pid_file).write_text(str(os.getpid()), encoding="utf-8")
        except Exception:
            pass
    rc = run_orchestrator(args, logger, resolve_aerender_path)
    raise SystemExit(rc)


if __name__ == "__main__":
    main()
