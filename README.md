# STMPO Local Debug Runner for After Effects (aerender)

This is a **local-only** fork of the STMPO (Single‑Task Multi‑Process Orchestrator) concept for Adobe After Effects.

**Goal:** run the exact “segmented / parallel `aerender`” approach **on your current machine** for debugging and test iteration—**no AWS Deadline Cloud**, no worker fleets, no submitter UI, no templates.

---

## What it does

- Splits a frame range into **N sub‑ranges**
- Launches **N parallel `aerender` processes**
- (Optional) renders to **local scratch** and **copies outputs** to the final destination
- (Optional / Windows) applies **CPU affinity** using a NUMA map
- Streams child logs to the console with PID tags

---

## Quick start

### 1) Install dependencies

```bash
python -m pip install -r requirements.txt
```

### 2) Run a local segmented render

Image sequence output (recommended for parallelism):

```bash
python stmpo_local_render.py ^
  --project "D:\Projects\my_project.aep" ^
  --comp "Main" ^
  --output "D:\Renders\shotA_[#####].png" ^
  --frames "1-300" ^
  --concurrency 0
```

- `--concurrency 0` = **auto** (based on CPU/RAM)
- If your `--output` is a **single file** (e.g., `.mov`/`.mp4`), STMPO can still run **concurrent** `aerender` children by rendering **per-range segments** and then **stitching** them at the end with **ffmpeg**.
  - Requires `ffmpeg` on your `PATH`, or set the `FFMPEG` environment variable to an explicit executable path.
  - Stitching tries **stream copy** first (`-c copy`). If that fails, it will **re-encode** as a fallback.

### 3) Mimic “task chunking” (Deadline-style)

If you want to reproduce the same *task chunk* selection behavior:

```bash
python stmpo_local_render.py ^
  --project "D:\Projects\my_project.aep" ^
  --comp "Main" ^
  --output "D:\Renders\shotA_[#####].png" ^
  --frames "1-300" ^
  --chunk_size 50 ^
  --index 3
```

That renders only frames for the 4th chunk (0-based index).

---

## Key options

- `--aerender_path`  
  Optional. If omitted, the runner tries to auto-locate `aerender` on Windows/macOS, or uses `AERENDER_PATH`.

- `--scratch_root` / `--no_scratch`  
  By default, renders go to a per-run folder under your OS temp directory and are then copied to the final output folder.
  Use `--no_scratch` to render directly to the final output path.

- `--disable_mfr`  
  Forces `-mfr OFF ...` for each `aerender` child.

- `--disable_affinity` / `--numa_map` (Windows only)  
  Applies per-child `cpu_affinity()` blocks. On macOS this is automatically ignored.

- `--env_file`  
  Path to a JSON file of environment variables to inject into each child process.

- `--dry_run`  
  Prints what it would do (ranges + commands) without launching `aerender`.

---

## Output path formats

The offloader (scratch → final) works best with **sequence patterns**, e.g.:

- AE style: `shot_[#####].png` or `shot_[00000].exr`
- Hash style: `shot_####.png`
- printf style: `shot_%04d.png`

If your output is a single file (mov/mp4/wav/etc), the runner prevents parallel writes by forcing concurrency=1.

---

## Notes & troubleshooting

- After Effects licensing / dialogs: running `aerender` in a non-interactive context can hang if AE shows a modal dialog.
  On Windows, the runner logs session information when possible.
- Network projects: `--stage_project` (default) copies the `.aep` into scratch before launching `aerender`, which can prevent SMB hangs.

---

## What was removed from the original repo

This fork intentionally deletes:
- Deadline Cloud submitter UI (`.jsx`)
- Job templates (`template.json`, `step_*.json`, etc.)
- Deadline-specific wrapper entrypoints

This is meant to be a **small, portable debug harness** you can run anywhere.
