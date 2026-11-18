#!/bin/sh
# Print unresolved shared libraries of Open3D's native modules, then fail if any remain.
missing=$(find /opt/venv/lib/python3.12/site-packages/open3d -name "*.so*" -exec ldd {} \; 2>/dev/null | grep "not found" | sort -u)
if [ -n "$missing" ]; then echo "MISSING SHARED LIBS:"; echo "$missing"; exit 1; fi
python -c "import open3d, rasterio, pvlib; print('open3d', open3d.__version__, 'import OK')"
