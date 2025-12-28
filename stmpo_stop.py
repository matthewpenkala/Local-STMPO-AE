#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

try:
    import psutil  # type: ignore
except Exception:
    psutil = None  # type: ignore


PID_RE = re.compile(r"pid\s*=\s*(\d+)", re.IGNORECASE)
LAUNCHED_RE = re.compile(r"Launched child\[\d+\]\s+pid=(\d+)")


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        try:
            return path.read_text()
        except Exception:
            return ""


def _gather_pids_from_file(path: Path) -> set[int]:
    pids: set[int] = set()
    txt = _read_text(path)
    if not txt:
        return pids
    for m in PID_RE.finditer(txt):
        try:
            pid = int(m.group(1))
            if pid > 1:
                pids.add(pid)
        except Exception:
            pass
    # Allow plain numeric lines too (best-effort)
    for line in txt.splitlines():
        line = line.strip()
        if line.isdigit():
            try:
                pid = int(line)
                if pid > 1:
                    pids.add(pid)
            except Exception:
                pass
    return pids


def _gather_pids_from_log(path: Path) -> set[int]:
    pids: set[int] = set()
    txt = _read_text(path)
    if not txt:
        return pids
    for m in LAUNCHED_RE.finditer(txt):
        try:
            pid = int(m.group(1))
            if pid > 1:
                pids.add(pid)
        except Exception:
            pass
    # Also capture any explicit pid= lines written elsewhere
    for m in PID_RE.finditer(txt):
        try:
            pid = int(m.group(1))
            if pid > 1:
                pids.add(pid)
        except Exception:
            pass
    return pids


def _kill_tree(pid: int, grace: float = 2.0) -> None:
    if pid <= 1:
        return

    if psutil is None:
        # Fallback: basic kill
        try:
            if os.name == "nt":
                os.system(f'taskkill /PID {pid} /T /F >NUL 2>NUL')
            else:
                os.kill(pid, 15)
                time.sleep(min(grace, 0.5))
                os.kill(pid, 9)
        except Exception:
            pass
        return

    try:
        p = psutil.Process(pid)
    except Exception:
        return

    procs = []
    try:
        procs = [p] + p.children(recursive=True)
    except Exception:
        procs = [p]

    # terminate
    for proc in procs:
        try:
            proc.terminate()
        except Exception:
            pass

    try:
        gone, alive = psutil.wait_procs(procs, timeout=grace)
    except Exception:
        alive = procs

    for proc in alive:
        try:
            proc.kill()
        except Exception:
            pass


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Stop STMPO local runner and all child render processes.")
    ap.add_argument("--pid_file", required=True, help="Path to runner_pid.txt")
    ap.add_argument("--child_pid_file", default=None, help="Path to children_pids.txt (optional)")
    ap.add_argument("--log_file", default=None, help="Path to last_run.log (optional)")
    ap.add_argument("--stop_log", default=None, help="Path to write a stop log (optional)")

    args = ap.parse_args(argv)

    pid_file = Path(args.pid_file)
    child_pid_file = Path(args.child_pid_file) if args.child_pid_file else None
    log_file = Path(args.log_file) if args.log_file else None

    stop_log = Path(args.stop_log) if args.stop_log else pid_file.parent / "stop.log"

    def log(msg: str) -> None:
        try:
            ts = time.strftime("%Y-%m-%d %H:%M:%S")
            stop_log.parent.mkdir(parents=True, exist_ok=True)
            with stop_log.open("a", encoding="utf-8") as f:
                f.write(f"[{ts}] {msg}\n")
        except Exception:
            pass

    # Gather PIDs
    pids: set[int] = set()

    # runner pid
    if pid_file.exists():
        txt = _read_text(pid_file).strip()
        if txt.isdigit():
            try:
                pids.add(int(txt))
            except Exception:
                pass

    if child_pid_file is None:
        child_pid_file = pid_file.with_name("children_pids.txt")

    if child_pid_file and child_pid_file.exists():
        pids |= _gather_pids_from_file(child_pid_file)

    if log_file and log_file.exists():
        pids |= _gather_pids_from_log(log_file)

    # Kill children first, then runner (prevents respawn)
    # Sort by pid just for determinism
    pids_list = [p for p in sorted(pids) if p > 1]

    log("Stop requested. Target PIDs: %s" % (", ".join([str(p) for p in pids_list]) if pids_list else "(none)"))

    # Try to kill non-runner first
    runner_pid = None
    if pid_file.exists():
        txt = _read_text(pid_file).strip()
        if txt.isdigit():
            runner_pid = int(txt)

    for pid in pids_list:
        if runner_pid is not None and pid == runner_pid:
            continue
        _kill_tree(pid, grace=2.0)

    if runner_pid is not None:
        _kill_tree(runner_pid, grace=2.0)

    # Best-effort cleanup
    try:
        if child_pid_file and child_pid_file.exists():
            child_pid_file.unlink()
    except Exception:
        pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
