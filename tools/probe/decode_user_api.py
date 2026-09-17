"""Decode an LX Music user_api script payload.

LX Music stores imported 音源 scripts gzip-compressed and base64-encoded with a
`gz_` prefix. This decodes that back to plain JavaScript for analysis.
"""
from __future__ import annotations

import base64
import gzip
import os
import sys
import zlib

OUT_DIR = os.path.join("docs", "research", "samples")


def decode(payload: str) -> str:
    """Decode an LX script payload.

    LX uses a `gz_` prefix but the body is actually raw zlib (magic 0x78 0x9c),
    not gzip. Accept both so the decoder is robust across LX versions.
    """
    for prefix in ("gz_", "zlib_"):
        if not payload.startswith(prefix):
            continue
        raw = base64.b64decode(payload[len(prefix) :])
        if raw[:2] == b"\x1f\x8b":
            return gzip.decompress(raw).decode("utf-8")
        return zlib.decompress(raw).decode("utf-8")
    return payload


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        OUT_DIR, "user_api_0.raw.txt"
    )
    with open(src, encoding="utf-8") as fh:
        payload = fh.read().strip()

    script = decode(payload)
    out_path = os.path.join(OUT_DIR, "user_api_0.decoded.js")
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(script)

    lines = script.splitlines()
    print(f"decoded {len(script)} chars, {len(lines)} lines -> {out_path}\n")
    print("=== first 60 lines ===")
    for i, line in enumerate(lines[:60], 1):
        print(f"{i:4} | {line[:160]}")
    print("\n=== last 40 lines ===")
    for i, line in enumerate(lines[-40:], len(lines) - 39):
        print(f"{i:4} | {line[:160]}")

    # Find the lx API surface actually used.
    import re

    events = sorted(set(re.findall(r"lx\.on\(\s*['\"]([a-zA-Z]+)['\"]", script)))
    sends = sorted(set(re.findall(r"lx\.send\(\s*['\"]([a-zA-Z]+)['\"]", script)))
    utils = sorted(set(re.findall(r"lx\.utils\.([A-Za-z0-9_]+)", script)))
    reqs = sorted(set(re.findall(r"lx\.request\(", script)))
    print(f"\nlx.on events:   {events}")
    print(f"lx.send events: {sends}")
    print(f"lx.utils.*:     {utils}")
    print(f"lx.request uses: {len(reqs)}")


if __name__ == "__main__":
    main()
