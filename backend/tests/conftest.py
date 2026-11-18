import os
import sys
import tempfile
from pathlib import Path

# isolate DB/files and force in-process jobs BEFORE the app is imported
_TMP = tempfile.mkdtemp(prefix="geobuild_test_")
os.environ["GEOBUILD_DATA_DIR"] = _TMP
os.environ["DATABASE_URL"] = f"sqlite:///{Path(_TMP, 'test.db').as_posix()}"
os.environ["JOB_BACKEND"] = "thread"
os.environ["FRONTEND_URL"] = "http://127.0.0.1:9"  # unreachable -> exercises the 3D-capture fallback
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app.analysis.raycast import make_engine  # noqa: E402
from app.scene.geometry import extrude  # noqa: E402
from shapely.geometry import box  # noqa: E402


@pytest.fixture
def flat_engine():
    def _make(boxes):
        eng = make_engine("open3d")
        eng.add_mesh("GROUND", [[-2000, -2000, 0], [2000, -2000, 0], [2000, 2000, 0], [-2000, 2000, 0]], [[0, 1, 2], [0, 2, 3]])
        for label, (x0, y0, x1, y1, h) in boxes.items():
            v, t = extrude(box(x0, y0, x1, y1), 0.0, h)
            eng.add_mesh(label, v, t)
        return eng
    return _make
