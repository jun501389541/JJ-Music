"""Probe 2: extract the shapes a compatible player must interoperate with.

Read-only. Never writes into the live LX Music data directory.
Usage: python tools/probe/dump_lx_shapes.py [lx_data_dir]
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile

DEFAULT_DIR = os.path.join(os.environ.get("APPDATA", ""), "lx-music-desktop", "LxDatas")


def connect(db_path: str) -> sqlite3.Connection:
    tmp = os.path.join(tempfile.gettempdir(), "lx_shapes.db")
    shutil.copy(db_path, tmp)
    con = sqlite3.connect(tmp)
    con.row_factory = sqlite3.Row
    return con


def show_config(data_dir: str) -> None:
    path = os.path.join(data_dir, "config_v2.json")
    with open(path, encoding="utf-8") as fh:
        cfg = json.load(fh)
    setting = cfg.get("setting", {})
    print(f"=== config_v2.json: {len(setting)} settings ===")
    groups: dict[str, list[str]] = {}
    for key in setting:
        group = key.split(".", 1)[0]
        groups.setdefault(group, []).append(key)
    for group, keys in sorted(groups.items()):
        print(f"\n-- {group} ({len(keys)})")
        for key in sorted(keys):
            val = setting[key]
            if isinstance(val, str) and len(val) > 60:
                val = val[:60] + "..."
            print(f"   {key} = {val!r}")
    other = {k: v for k, v in cfg.items() if k != "setting"}
    print(f"\n-- other top-level keys: {list(other)}")


def show_user_api(data_dir: str) -> None:
    path = os.path.join(data_dir, "user_api.json")
    with open(path, encoding="utf-8") as fh:
        obj = json.load(fh)
    apis = obj.get("userApis", [])
    print(f"\n=== user_api.json: {len(apis)} source(s) ===")
    for i, api in enumerate(apis):
        meta = {k: v for k, v in api.items() if k != "script"}
        print(f"\n[{i}] fields={list(api)}")
        print(f"    meta={json.dumps(meta, ensure_ascii=False)}")
        script = api.get("script", "")
        print(f"    script length={len(script)}")
        head = "\n".join(script.splitlines()[:40])
        print("    --- script head ---")
        for line in head.splitlines():
            print(f"    | {line}")
        events = sorted(
            {
                tok.split("'")[1]
                for tok in script.replace('"', "'").split("lx.on(")[1:]
                if "'" in tok
            }
        )
        print(f"    lx.on events referenced: {events}")


def show_rows(con: sqlite3.Connection, sql: str, title: str) -> None:
    print(f"\n=== {title} ===")
    try:
        for row in con.execute(sql):
            out = {}
            for key in row.keys():
                val = row[key]
                if isinstance(val, (bytes, bytearray)):
                    val = f"<blob {len(val)}b>"
                elif isinstance(val, str) and len(val) > 900:
                    val = val[:900] + "...<trunc>"
                out[key] = val
            print(json.dumps(out, ensure_ascii=False, indent=2, default=str))
    except sqlite3.Error as exc:
        print(f"  <{exc}>")


def main() -> None:
    data_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR
    show_config(data_dir)
    show_user_api(data_dir)

    con = connect(os.path.join(data_dir, "lx.data.db"))
    show_rows(con, "SELECT * FROM my_list_music_info LIMIT 2", "my_list_music_info sample")
    show_rows(
        con,
        "SELECT id, source, type, substr(text,1,400) AS text FROM lyric LIMIT 4",
        "lyric sample",
    )
    show_rows(
        con,
        "SELECT id, quality, ext, fileName, substr(filePath,1,160) AS filePath, "
        "substr(musicInfo,1,700) AS musicInfo FROM download_list "
        "WHERE isComplate=1 ORDER BY position DESC LIMIT 2",
        "download_list completed sample",
    )
    show_rows(
        con,
        "SELECT id, substr(url,1,120) AS url FROM music_url LIMIT 3",
        "music_url sample",
    )
    show_rows(con, "SELECT * FROM db_info", "db_info")
    print("\n=== quality distribution in download_list ===")
    for row in con.execute(
        "SELECT quality, ext, COUNT(*) n FROM download_list GROUP BY quality, ext ORDER BY n DESC"
    ):
        print(f"  {row['quality']:<12} {row['ext']:<8} {row['n']}")
    print("\n=== lyric type/source distribution ===")
    for row in con.execute(
        "SELECT source, type, COUNT(*) n FROM lyric GROUP BY source, type ORDER BY n DESC LIMIT 20"
    ):
        print(f"  {row['source']:<24} {row['type']:<12} {row['n']}")
    con.close()


if __name__ == "__main__":
    main()
