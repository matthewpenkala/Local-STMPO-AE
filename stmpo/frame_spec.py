from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple


@dataclass(frozen=True)
class Chunk:
    index: int
    start_frame: int
    end_frame: int


def parse_frames(frames_spec: str) -> List[int]:
    """
    Parse a simple framespec like:
      "0-99" or "0-99,120-200"
    into a sorted unique list of ints.

    This intentionally stays conservative (debug harness).
    """
    frames: List[int] = []
    for part in str(frames_spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start = int(a)
            end = int(b)
            if end < start:
                start, end = end, start
            frames.extend(range(start, end + 1))
        else:
            frames.append(int(part))
    return sorted(set(frames))


def build_chunks(frames: List[int], chunk_size: int) -> List[Chunk]:
    chunks: List[Chunk] = []
    if not frames:
        return chunks
    if chunk_size <= 0:
        chunk_size = len(frames)

    start = frames[0]
    prev = start
    count = 1
    chunk_start = start
    chunk_index = 0

    for f in frames[1:]:
        if f != prev + 1 or count >= chunk_size:
            chunks.append(Chunk(chunk_index, chunk_start, prev))
            chunk_index += 1
            chunk_start = f
            count = 1
        else:
            count += 1
        prev = f

    chunks.append(Chunk(chunk_index, chunk_start, prev))
    return chunks


def select_task_range(frames_spec: str, chunk_size: Optional[int], index: Optional[int]) -> Tuple[int, int]:
    frames = parse_frames(frames_spec)
    if not frames:
        raise ValueError(f"No frames parsed from spec: {frames_spec}")

    if chunk_size and index is not None:
        chunks = build_chunks(frames, int(chunk_size))
        match = next((c for c in chunks if c.index == int(index)), None)
        if not match:
            raise ValueError(
                f"Index {index} not found in chunks. frames={frames_spec}, chunk_size={chunk_size}, "
                f"chunk_count={len(chunks)}"
            )
        return match.start_frame, match.end_frame

    return frames[0], frames[-1]
