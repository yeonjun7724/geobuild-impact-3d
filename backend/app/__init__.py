"""GeoBuild Impact 3D backend.

A machine-wide PROJ_LIB/GDAL_DATA (e.g. from a PostGIS install) can point to an incompatible proj.db.
Pin PROJ/GDAL data to the copies bundled with the installed rasterio/pyproj wheels before they load.
"""
import os
from importlib.util import find_spec


def _pin_proj_data() -> None:
    spec = find_spec("rasterio")
    if spec and spec.submodule_search_locations:
        base = list(spec.submodule_search_locations)[0]
        proj = os.path.join(base, "proj_data")
        gdal = os.path.join(base, "gdal_data")
        if os.path.isdir(proj):
            os.environ["PROJ_LIB"] = proj
            os.environ["PROJ_DATA"] = proj
        if os.path.isdir(gdal):
            os.environ["GDAL_DATA"] = gdal


_pin_proj_data()
