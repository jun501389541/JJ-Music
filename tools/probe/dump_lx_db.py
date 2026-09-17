"""Read-only probe of an installed LX Music Desktop data directory.

Copies the SQLite DB to a temp file first so the live app is never locked.
Usage: python tools/probe/dump_lx_db.py [lx_data_dir]
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile

DEFAULT_DIR = os.path.join(
    os.environ.get("APPDATA", ""), "lx-music-desktop", "LxDatas"
)


def dump_schema(db_path: str) -> None:
    tmp = os.path.join(tempfile.gettempdir(), "lx_probe.db")
    shutil.copy(db_path, tmp)
    con = sqlite3.connect(tmp)
    print("=== TABLES ===")
    rows = list(
        con.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"
        )
    )
    for name, sql in rows:
        try:
            count = con.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        except sqlite3.Error as exc:  # pragma: no cover - diagnostics only
            count = f"<{exc}>"
        print(f"\n-- {name}  (rows={count})")
        print(sql)
    print("\n=== INDEXES / TRIGGERS ===")
    for name, sql in con.execute(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('index','trigger') ORDER BY name"
    ):
        print(f"{name}: {sql}")
    con.close()


def peek_table(db_path: str, table: str, limit: int = 3) -> None:
    tmp = os.path.join(tempfile.gettempdir(), "lx_probe.db")
    if not os.path.exists(tmp):
        shutil.copy(db_path, tmp)
    con = sqlite3.connect(tmp)
    con.row_factory = sqlite3.Row
    print(f"\n=== SAMPLE {table} (first {limit}) ===")
    try:
        for row in con.execute(f'SELECT * FROM "{table}" LIMIT {limit}'):
            out = {}
            for key in row.keys():
                val = row[key]
                if isinstance(val, (bytes, bytearray)):
                    val = f"<blob {len(val)}b>"
                elif isinstance(val, str) and len(val) > 300:
                    val = val[:300] + "...<truncated>"
                out[key] = val
            print(json.dumps(out, ensure_ascii=False, indent=2, default=str))
    except sqlite3.Error as exc:
        print(f"  <{exc}>")
    con.close()


def main() -> None:
    data_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR
    print(f"LX data dir: {data_dir}\n")

    db = os.path.join(data_dir, "lx.data.db")
    if os.path.exists(db):
        dump_schema(db)
        for table in ("list", "dislike", "music", "song", "history"):
            peek_table(db, table)
    else:
        print(f"! no db at {db}")

    for name in ("config_v2.json", "data.json", "hot_key.json"):
        path = os.path.join(data_dir, name)
        if not os.path.exists(path):
            continue
        print(f"\n=== {name} ===")
        with open(path, encoding="utf-8") as fh:
            obj = json.load(fh)
        text = json.dumps(obj, ensure_ascii=False, indent=2)
        print(text[:4000])
        if len(text) > 4000:
            print(f"...<{len(text) - 4000} more chars>")

    api_path = os.path.join(data_dir, "user_api.json")
    if os.path.exists(api_path):
        print("\n=== user_api.json (structure only) ===")
        with open(api_path, encoding="utf-8") as fh:
            obj = json.load(fh)
        apis = obj.get("userApis", []) if isinstance(obj, dict) else obj
        print(f"userApis: {len(apis)} entries")
        for i, api in enumerate(apis):
            if not isinstance(api, dict):
                print(f"  [{i}] {type(api).__name__}")
                continue
            meta = {k: v for k, v in api.items() if k != "script"}
            script = api.get("script", "")
            print(f"  [{i}] meta={json.dumps(meta, ensure_ascii=False)}")
            print(f"      script bytes={len(script)}")


if __name__ == "__main__":
    main()
