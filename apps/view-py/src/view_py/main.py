from __future__ import annotations

import os
import subprocess
from pathlib import Path

from .native_shell import main as native_main


APP_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = APP_ROOT.parents[1]


def latest_mtime(root: Path) -> float:
    if root.is_file():
        return root.stat().st_mtime

    latest = 0.0
    for path in root.rglob("*"):
        if path.is_file():
            latest = max(latest, path.stat().st_mtime)
    return latest


def ensure_view_py_web_dist() -> None:
    if os.getenv("VIEW_PYSIDE6_URL"):
        return

    dist_index = APP_ROOT / "web" / "dist" / "index.html"
    source_paths = [
        REPO_ROOT / "package.json",
        REPO_ROOT / "bun.lock",
        REPO_ROOT / "packages" / "view" / "package.json",
        REPO_ROOT / "packages" / "view" / "src",
        APP_ROOT / "web" / "index.html",
        APP_ROOT / "web" / "package.json",
        APP_ROOT / "web" / "src",
        APP_ROOT / "web" / "vite.config.ts",
        APP_ROOT / "web" / "tsconfig.json",
    ]
    latest_source_change = max(latest_mtime(path) for path in source_paths if path.exists())

    if dist_index.exists() and dist_index.stat().st_mtime >= latest_source_change:
        return

    try:
        subprocess.run(
            ["bun", "run", "build:view-py:web"],
            cwd=REPO_ROOT,
            check=True,
        )
    except FileNotFoundError as error:
        raise RuntimeError("bun is required to build apps/view-py/web") from error
    except subprocess.CalledProcessError as error:
        raise RuntimeError("failed to build apps/view-py/web") from error


def main() -> int:
    ensure_view_py_web_dist()
    return int(native_main())
