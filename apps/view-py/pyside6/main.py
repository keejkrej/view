import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "")

from PySide6 import QtWebView

QtWebView.QtWebView.initialize()

from native_shell import main


if __name__ == "__main__":
    raise SystemExit(main())
