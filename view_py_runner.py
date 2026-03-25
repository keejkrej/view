from __future__ import annotations

import os
import runpy
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent


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

    dist_index = ROOT / "apps" / "view-py" / "web" / "dist" / "index.html"
    source_paths = [
        ROOT / "package.json",
        ROOT / "bun.lock",
        ROOT / "packages" / "view" / "package.json",
        ROOT / "packages" / "view" / "src",
        ROOT / "apps" / "view-py" / "web" / "index.html",
        ROOT / "apps" / "view-py" / "web" / "package.json",
        ROOT / "apps" / "view-py" / "web" / "src",
        ROOT / "apps" / "view-py" / "web" / "vite.config.ts",
        ROOT / "apps" / "view-py" / "web" / "tsconfig.json",
    ]
    latest_source_change = max(latest_mtime(path) for path in source_paths if path.exists())

    if dist_index.exists() and dist_index.stat().st_mtime >= latest_source_change:
        return

    try:
        subprocess.run(
            ["bun", "run", "build:view-py:web"],
            cwd=ROOT,
            check=True,
        )
    except FileNotFoundError as error:
        raise RuntimeError("bun is required to build apps/view-py/web") from error
    except subprocess.CalledProcessError as error:
        raise RuntimeError("failed to build apps/view-py/web") from error


def main() -> int:
    ensure_view_py_web_dist()
    app_path = ROOT / "apps" / "view-py" / "pyside6" / "main.py"
    module_globals = runpy.run_path(str(app_path))
    return int(module_globals["main"]())
