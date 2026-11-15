"""Experimental NISAR GCOV service, compatible with the Rust job API."""
import base64
import io
import json
import os
import re
import tempfile
from collections import defaultdict
from datetime import date
from pathlib import Path

import asf_search as asf
import h5py
import numpy as np
import onnxruntime as ort
import rasterio
import threading 
from contextlib import nullcontext
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel
from rasterio.features import geometry_mask, shapes
from rasterio.transform import Affine, array_bounds
from rasterio.warp import Resampling, reproject, transform_bounds, transform_geom
from scipy.ndimage import uniform_filter, label as ndlabel
from shapely.geometry import Polygon, mapping, shape

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = PROJECT_ROOT / "Backend" / "nisar_cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Împiedică două cereri simultane să descarce același fișier.
DOWNLOAD_LOCK = threading.Lock()
MODEL_DIR = Path(os.environ.get('MODEL_DIR', PROJECT_ROOT / 'Backend' / 'nisar_model_bundle'))
with (MODEL_DIR / 'model_meta.json').open(encoding='utf-8') as f:
    META = json.load(f)
if META.get('channels') != ['HH', 'HV']:
    raise RuntimeError('Modelul configurat nu are canalele NISAR HH/HV')
# Încarcă bibliotecile CUDA și cuDNN instalate.
ort.preload_dlls()

SESSION = ort.InferenceSession(
    str(MODEL_DIR / "model.onnx"),
    providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
)

print("Provideri folositi:", SESSION.get_providers())

app = FastAPI()
class AnalyzeRequest(BaseModel):
    polygon: list[list[float]]
    start_date: str
    end_date: str
    analysis_type: str = 'surface'

def get_token():
    token = os.environ.get('EARTHDATA_TOKEN', '').strip()
    if not token:
        raise HTTPException(500, 'EARTHDATA_TOKEN lipsește din mediul serviciului Python')
    return token

def select_pair(poly, start, end):
    results = asf.search(dataset='NISAR', processingLevel='GCOV', intersectsWith=poly.wkt,
                         start=start + 'T00:00:00Z', end=end + 'T23:59:59Z', maxResults=2000)
    groups = defaultdict(dict)
    for product in results:
        props = product.properties
        parts = str(props.get('fileID') or '').split('_')
        if len(parts) < 14 or parts[3] != 'GCOV' or not parts[9].startswith('DH'):
            continue
        day = str(props.get('startTime') or '')[:10]
        try:
            date.fromisoformat(day)
        except ValueError:
            continue
        key = tuple(parts[i] for i in (5, 6, 7, 8, 9, 10, 13))
        groups[key].setdefault(day, product)
    candidates = []
    for group in groups.values():
        days = sorted(group)
        if len(days) >= 2:
            # Mirrors training's <=90 day pairing.
            for i, first in enumerate(days):
                for last in days[i + 1:]:
                    gap = (date.fromisoformat(last) - date.fromisoformat(first)).days
                    if 0 < gap <= 90:
                        candidates.append((last, gap, first, group[first], group[last]))
    if not candidates:
        raise HTTPException(404, 'Nu există două scene NISAR HH/HV compatibile la maximum 90 de zile în intervalul ales.')
    last, _, first, p1, p2 = max(candidates, key=lambda x: (x[0], x[1]))
    return first, last, p1, p2

def download(product, directory, session):
    fid = str(product.properties.get("fileID") or "")

    if not re.fullmatch(r"[A-Za-z0-9_.-]+", fid):
        raise ValueError("ID NISAR invalid")

    cache_path = directory / f"{fid}.h5"

    with DOWNLOAD_LOCK:
        # Dacă avem deja un fișier HDF5 care se poate deschide,
        # îl refolosim.
        if cache_path.is_file():
            try:
                with h5py.File(cache_path, "r") as h5:
                    if "/science/LSAR/GCOV/grids/frequencyA" in h5:
                        print(f"✅ Folosesc imaginea din cache: {fid}")
                        return cache_path
            except OSError:
                pass

            # Nu suprascriem automat un fișier corupt.
            raise RuntimeError(
                f"Fișierul din cache nu poate fi citit: {cache_path}. "
                "Verifică-l înainte de a relua analiza."
            )

        print(f"⬇️ Descarc imaginea NISAR: {fid}", flush=True)

        # Download-ul este făcut într-un folder temporar separat.
        # Fișierul ajunge în cache doar după ce a fost verificat.
        with tempfile.TemporaryDirectory(
            prefix="nisar_download_",
            dir=directory,
        ) as temporary_dir:
            temporary_path = Path(temporary_dir)

            product.download(
                path=str(temporary_path),
                session=session,
            )

            candidates = list(
                temporary_path.glob(fid + "*.h5")
            )

            if len(candidates) != 1:
                raise RuntimeError(
                    f"Nu am găsit exact un fișier .h5 pentru {fid}."
                )

            downloaded_file = candidates[0]

            if downloaded_file.stat().st_size == 0:
                raise RuntimeError(
                    f"Fișierul descărcat este gol: {fid}"
                )

            with h5py.File(downloaded_file, "r") as h5:
                if "/science/LSAR/GCOV/grids/frequencyA" not in h5:
                    raise RuntimeError(
                        f"Fișierul nu conține datele GCOV așteptate: {fid}"
                    )

            os.replace(downloaded_file, cache_path)

        print(f"✅ Imagine salvată în cache: {fid}", flush=True)
        return cache_path
def crop_gcov(path, bounds):
    with h5py.File(path, 'r') as f:
        g = f['/science/LSAR/GCOV/grids/frequencyA']
        for key in ('HHHH', 'HVHV', 'xCoordinates', 'yCoordinates', 'projection'):
            if key not in g:
                raise ValueError('Stratul NISAR lipsește: ' + key)
        x = g['xCoordinates'][:]; y = g['yCoordinates'][:]
        dx = float(x[1] - x[0]); dy = float(y[1] - y[0])
        if dx <= 0 or dy >= 0:
            raise ValueError('Orientarea grilei NISAR nu este suportată')
        crs = 'EPSG:' + str(int(g['projection'][()]))
        left, bottom, right, top = transform_bounds('EPSG:4326', crs, *bounds, densify_pts=21)
        xs = np.flatnonzero((x >= left) & (x <= right)); ys = np.flatnonzero((y >= bottom) & (y <= top))
        if len(xs) < 2 or len(ys) < 2:
            raise ValueError('Zona nu intersectează grila NISAR')
        x0, x1 = int(xs[0]), int(xs[-1]) + 1
        y0, y1 = int(ys[0]), int(ys[-1]) + 1
        if (x1 - x0) * (y1 - y0) > 4_000_000:
            raise ValueError('Zona este prea mare pentru procesare. Alege o zonă mai mică.')
        data = np.stack([g[k][y0:y1, x0:x1].astype(np.float32) for k in ('HHHH', 'HVHV')])
        transform = Affine(dx, 0, float(x[x0] - dx / 2), 0, dy, float(y[y0] - dy / 2))
        return data, crs, transform

def preprocess(path1, path2, poly):
    a, crs, transform = crop_gcov(path1, poly.bounds)
    b, crs2, transform2 = crop_gcov(path2, poly.bounds)
    aligned = np.full(a.shape, np.nan, np.float32)
    for k in range(2):
        src = np.where(np.isfinite(b[k]) & (b[k] > 0), b[k], np.nan).astype(np.float32)
        reproject(src, aligned[k], src_transform=transform2, src_crs=crs2, src_nodata=np.nan,
                  dst_transform=transform, dst_crs=crs, dst_nodata=np.nan, resampling=Resampling.bilinear)
    valid = np.all(np.isfinite(a) & (a > 0) & np.isfinite(aligned) & (aligned > 0), axis=0)
    geom = transform_geom('EPSG:4326', crs, mapping(poly))
    aoi = geometry_mask([geom], out_shape=valid.shape, transform=transform, invert=True)
    valid &= aoi
    if valid.sum() < 100:
        raise ValueError('Suprapunerea validă între imagini și zonă este insuficientă')
    weight = uniform_filter(valid.astype(np.float32), size=5)
    result = []
    for data in (a, aligned):
        channels = []
        for k, name in enumerate(('HH', 'HV')):
            filtered = uniform_filter(np.where(valid, data[k], 0), size=5) / np.maximum(weight, 1e-6)
            db = 10 * np.log10(np.maximum(filtered, 1e-8))
            limits = META['preprocessing']['normalize'][name]
            scaled = np.clip((db - limits['db_min']) / (limits['db_max'] - limits['db_min']), 0, 1)
            channels.append(np.nan_to_num(scaled, nan=0, posinf=0, neginf=0).astype(np.float32))
        result.append(np.stack(channels))
    return result[0], result[1], valid, crs, transform

def predict(a, b, tile=256):
    _, h, w = a.shape
    # The model was trained on 256x256 tiles; zero-pad incomplete edge tiles.
    result = np.zeros((h, w), dtype=np.float32)
    for y in range(0, h, tile):
        for x in range(0, w, tile):
            hh, ww = min(tile, h-y), min(tile, w-x)
            aa = np.zeros((1, 2, tile, tile), np.float32); bb = np.zeros_like(aa)
            aa[0, :, :hh, :ww] = a[:, y:y+hh, x:x+ww]
            bb[0, :, :hh, :ww] = b[:, y:y+hh, x:x+ww]
            output = SESSION.run(['change_prob'], {'t1': aa, 't2': bb})[0]
            result[y:y+hh, x:x+ww] = output[0, 0, :hh, :ww]
    return result

def geojson(mask, crs, transform):
    components, count = ndlabel(mask)
    if count:
        sizes = np.bincount(components.ravel()); keep = sizes >= 10; keep[0] = False
        mask = keep[components]
    features = []
    for geom, value in shapes(mask.astype(np.uint8), mask=mask, transform=transform):
        if value != 1: continue
        g = shape(geom).simplify(15, preserve_topology=True)
        if not g.is_empty:
            features.append({'type': 'Feature', 'geometry': transform_geom(crs, 'EPSG:4326', mapping(g)),
                             'properties': {'area_km2': round(g.area / 1e6, 4)}})
    return {'type': 'FeatureCollection', 'features': features}

def overlay(prob, valid):
    rgba = np.zeros((*prob.shape, 4), np.uint8)
    rgba[..., 0] = 255; rgba[..., 1] = (255 * (1 - prob)).astype(np.uint8)
    rgba[..., 3] = (200 * prob * valid).astype(np.uint8)
    stream = io.BytesIO(); Image.fromarray(rgba).save(stream, format='PNG')
    return base64.b64encode(stream.getvalue()).decode('ascii')

@app.post('/analyze')
def analyze(req: AnalyzeRequest):
    try:
        d1, d2 = date.fromisoformat(req.start_date), date.fromisoformat(req.end_date)
        if d1 >= d2: raise HTTPException(400, 'Data de început trebuie să fie înainte de data de sfârșit')
        poly = Polygon(req.polygon)
        if not poly.is_valid or poly.is_empty or poly.area == 0: raise HTTPException(400, 'Poligon invalid')
        first, last, p1, p2 = select_pair(poly, req.start_date, req.end_date)
        session = asf.ASFSession().auth_with_token(get_token())
        # TemporaryDirectory contains only files downloaded for this job.
        with nullcontext(str(CACHE_DIR)) as tmp:
            directory = Path(tmp)
            path1 = download(p1, directory, session); path2 = download(p2, directory, session)
            a, b, valid, crs, transform = preprocess(path1, path2, poly)
            prob = predict(a, b); prob[~valid] = 0
            changed = (prob > float(META.get('threshold', 0.5))) & valid
            pixel_km2 = abs(transform.a * transform.e - transform.b * transform.d) / 1e6
            bounds = transform_bounds(crs, 'EPSG:4326', *array_bounds(*valid.shape, transform), densify_pts=21)
            return {'from': first, 'to': last, 'changed_km2': round(float(changed.sum()*pixel_km2), 3),
                    'changed_pct': round(float(changed.sum()/valid.sum()*100), 2),
                    'features': geojson(changed, crs, transform), 'overlay_png': overlay(prob, valid),
                    'overlay_bounds': list(bounds)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f'NISAR processing failed: {type(exc).__name__}: {exc}') from exc

@app.get('/health')
def health():
    return {'ok': True, 'model': META.get('model'), 'source': META.get('source'), 'channels': META.get('channels'), 'providers': SESSION.get_providers()}
