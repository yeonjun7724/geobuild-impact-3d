#!/bin/sh
# Build-time guard: Open3D / rasterio / pvlib must import. On failure, list unresolved system libraries of the
# Open3D CPU pybind module (bundled libOpen3D and optional ML plugins are excluded via LD_LIBRARY_PATH / filter).
if python -c "import open3d, rasterio, pvlib; print('open3d', open3d.__version__, 'import OK')"; then exit 0; fi
O3D=/opt/venv/lib/python3.12/site-packages/open3d
LD_LIBRARY_PATH="$O3D:$O3D/cpu" ldd "$O3D"/cpu/pybind*.so | grep "not found" || true
exit 1
