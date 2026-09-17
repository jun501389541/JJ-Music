"""Probe 3: extract the user 音源 script to a workspace file for analysis.

Writes only into the workspace (docs/research/samples/). The live LX Music
data directory is never modified.
"""
from __future__ import annotations

import json
import os
import re
import sys

DEFAULT_DIR = os.path.join(os.environ.get("APPDATA", ""), "lx-music-desktop", "LxDatas")
OUT_DIR = os.path.join("docs", "research", "samples")


def main() -> None:
    data_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(data_dir, "user_api.json"), encoding="utf-8") as fh:
        obj = json.load(fh)

    apis = obj.get("userApis", [])
    report: list[str] = [f"userApis entries: {len(apis)}", ""]

    for i, api in enumerate(apis):
        report.append(f"--- entry {i} ---")
        report.append(f"type: {type(api).__name__}")
        if not isinstance(api, dict):
            report.append(repr(api)[:500])
            continue
        for key, val in api.items():
            if isinstance(val, str):
                report.append(f"  {key}: str len={len(val)}")
            else:
                report.append(f"  {key}: {type(val).__name__} = {val!r}"[:300])

        script = api.get("script", "")
        if script:
            # Detect whether the script is plain JS or an encoded blob.
            printable = sum(1 for ch in script[:2000] if 32 <= ord(ch) < 127)
            ratio = printable / max(1, len(script[:2000]))
            b64_like = bool(re.fullmatch(r"[A-Za-z0-9+/=\s]+", script[:5000]))
            report.append(f"  -> printable ratio (first 2000): {ratio:.2f}")
            report.append(f"  -> base64-like: {b64_like}")
            head = script[:400].replace("\n", "\\n")
            report.append(f"  -> head: {head}")

            out_path = os.path.join(OUT_DIR, f"user_api_{i}.raw.txt")
            with open(out_path, "w", encoding="utf-8") as fh:
                fh.write(script)
            report.append(f"  -> written: {out_path}")

            if b64_like:
                import base64

                try:
                    decoded = base64.b64decode(script)
                    report.append(f"  -> base64 decoded {len(decoded)} bytes")
                    dec_path = os.path.join(OUT_DIR, f"user_api_{i}.decoded.bin")
                    with open(dec_path, "wb") as fh:
                        fh.write(decoded)
                    report.append(f"  -> decoded written: {dec_path}")
                    preview = decoded[:300]
                    report.append(f"  -> decoded head: {preview!r}")
                except Exception as exc:  # noqa: BLE001 - diagnostics
                    report.append(f"  -> base64 decode failed: {exc}")

    text = "\n".join(report)
    with open(os.path.join(OUT_DIR, "user_api_report.txt"), "w", encoding="utf-8") as fh:
        fh.write(text)
    print(text)


if __name__ == "__main__":
    main()
