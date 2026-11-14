"""Inference service called by the Rust backend.

POST /predict  {polygon, analysis_type, t1: {date, vv, vh}, t2: {date, vv, vh}}
Preprocessing is identical to the Colab notebook; the ONNX model comes from model.onnx.
Run:  uvicorn app:app --port 8000
"""
import base64, io, json, os
from pathlib import Path

import numpy as np
import onnxruntime as ort
import rasterio
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel
from rasterio.features import shapes
from rasterio.warp import Resampling, reproject, transform_bounds, transform_geom
from rasterio.windows import from_bounds, Window
from scipy import ndimage as ndi
from scipy.ndimage import uniform_filter
from shapely.geometry import mapping, shape

MODEL_DIR = Path(os.environ.get("MODEL_DIR", "."))
META = json.load(open(MODEL_DIR / "model_meta.json"))
SESSION = ort.InferenceSession(str(MODEL_DIR / "model.onnx"),
                               providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
POLS = META["channels"]
DB_RANGE = {p: (v["db_min"], v["db_max"]) for p, v in META["preprocessing"]["normalize"].items()}
THRESHOLD = META.get("threshold", 0.5)
TILE, OVERLAP = META.get("recommended_tile", 512), META.get("tile_overlap", 128)

app = FastAPI()


class SceneFiles(BaseModel):
    date: str
    vv: str
    vh: str


class PredictRequest(BaseModel):
    polygon: list[list[float]]
    analysis_type: str = "surface"
    t1: SceneFiles
    t2: SceneFiles


def lee_filter(img, size=5):
    m = uniform_filter(img, size)
    var = np.maximum(uniform_filter(img * img, size) - m * m, 0)
    k = var / (var + var.mean() + 1e-12)
    return m + k * (img - m)


def to_norm(lin, pol):
    lo, hi = DB_RANGE[pol]
    db = 10 * np.log10(np.clip(lin, 1e-5, None))
    return np.clip((db - lo) / (hi - lo), 0, 1).astype(np.float32)


def ref_grid(path, bounds_wgs84):
    with rasterio.open(path) as src:
        b = transform_bounds("EPSG:4326", src.crs, *bounds_wgs84)
        win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
        win = win.intersection(Window(0, 0, src.width, src.height))
        if win.width < 16 or win.height < 16:
            raise HTTPException(422, "polygon does not overlap the SAR scene")
        return src.crs, src.window_transform(win), int(win.height), int(win.width)


def load(path, crs, transform, h, w, pol):
    dst = np.full((h, w), np.nan, np.float32)
    with rasterio.open(path) as src:
        reproject(rasterio.band(src, 1), dst, src_transform=src.transform, src_crs=src.crs,
                  src_nodata=src.nodata, dst_transform=transform, dst_crs=crs,
                  dst_nodata=np.nan, resampling=Resampling.bilinear)
    valid = np.isfinite(dst) & (dst > 0)
    fill = np.nanmedian(dst[valid]) if valid.any() else 1e-3
    return to_norm(lee_filter(np.where(valid, dst, fill)), pol), valid


def predict(a, b):
    c, h, w = a.shape
    ph, pw = (-h) % 16, (-w) % 16
    A = np.pad(a, ((0, 0), (0, ph), (0, pw)))[None]
    B = np.pad(b, ((0, 0), (0, ph), (0, pw)))[None]
    Hp, Wp = A.shape[-2:]
    t = min(TILE, Hp, Wp)
    step = max(16, t - OVERLAP)
    win = np.outer(np.hanning(t), np.hanning(t)).astype(np.float32) + 1e-3
    out = np.zeros((Hp, Wp), np.float32)
    wsum = np.zeros_like(out)
    ys = sorted(set(list(range(0, Hp - t + 1, step)) + [Hp - t]))
    xs = sorted(set(list(range(0, Wp - t + 1, step)) + [Wp - t]))
    for y in ys:
        for x in xs:
            p = SESSION.run(None, {"t1": A[..., y:y + t, x:x + t], "t2": B[..., y:y + t, x:x + t]})[0][0, 0]
            out[y:y + t, x:x + t] += p * win
            wsum[y:y + t, x:x + t] += win
    return (out / wsum)[:h, :w]


def to_geojson(mask, crs, transform, min_px=10):
    lab, n = ndi.label(mask)
    if n:
        sizes = ndi.sum(mask, lab, range(1, n + 1))
        mask = np.isin(lab, np.where(sizes >= min_px)[0] + 1)
    feats = []
    for geom, _ in shapes(mask.astype(np.uint8), mask=mask, transform=transform):
        g = shape(geom).simplify(15)
        if not g.is_empty:
            feats.append({"type": "Feature", "geometry": transform_geom(crs, "EPSG:4326", mapping(g)),
                          "properties": {"area_km2": round(g.area / 1e6, 4)}})
    return {"type": "FeatureCollection", "features": feats}


def overlay_png(prob, aoi_mask):
    rgba = np.zeros((*prob.shape, 4), np.uint8)
    rgba[..., 0] = 255
    rgba[..., 1] = (255 * (1 - prob)).astype(np.uint8)
    rgba[..., 3] = (200 * prob * aoi_mask).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgba).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


@app.post("/predict")
def predict_endpoint(req: PredictRequest):
    poly = shape({"type": "Polygon", "coordinates": [req.polygon + [req.polygon[0]]]})
    crs, transform, h, w = ref_grid(req.t1.vv, poly.bounds)

    stacks, valid = [], np.ones((h, w), bool)
    for files in (req.t1, req.t2):
        chans = []
        for pol in POLS:
            arr, v = load(getattr(files, pol.lower()), crs, transform, h, w, pol)
            chans.append(arr)
            valid &= v
        stacks.append(np.stack(chans))

    poly_utm = shape(transform_geom("EPSG:4326", crs, mapping(poly)))
    aoi_mask = rasterio.features.rasterize([(poly_utm, 1)], out_shape=(h, w), transform=transform).astype(bool)
    prob = predict(*stacks)
    prob[~(valid & aoi_mask)] = 0
    changed = prob > THRESHOLD

    pix_km2 = abs(transform.a * transform.e) / 1e6
    bounds = transform_bounds(crs, "EPSG:4326", *rasterio.transform.array_bounds(h, w, transform))
    return {
        "from": req.t1.date, "to": req.t2.date,
        "changed_km2": round(float(changed.sum() * pix_km2), 3),
        "changed_pct": round(float(changed.sum() / max(aoi_mask.sum(), 1) * 100), 2),
        "features": to_geojson(changed, crs, transform),
        "overlay_png": overlay_png(prob, aoi_mask),
        "overlay_bounds": list(bounds),
    }


@app.get("/health")
def health():
    return {"ok": True, "model": META.get("model"), "providers": SESSION.get_providers()}
