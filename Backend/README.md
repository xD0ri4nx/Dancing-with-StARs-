# Backend (Rust)

Primește de la frontend un poligon + două date, ia imagini SAR de la NASA și întoarce zonele schimbate.

## Cum îl pornești

### 1. Instalează Rust (o singură dată)

**Windows**
1. Descarcă și rulează `rustup-init.exe` de pe https://rustup.rs
2. Dacă te întreabă de *Visual Studio C++ Build Tools*, zi **da** și lasă-l să le instaleze
3. Închide și deschide din nou terminalul (PowerShell)

**Mac / Linux**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```
Închide și deschide din nou terminalul.

Verifică: `cargo --version` trebuie să afișeze o versiune.

### 2. Fă-ți token NASA (o singură dată)

1. Cont gratuit pe https://urs.earthdata.nasa.gov/users/new
2. După login: **Generate Token** → copiază token-ul
3. Tot acolo: **Applications → Authorized Apps → Approve more applications** → caută și aprobă **Alaska Satellite Facility Data Access**

### 3. Creează fișierul `.env`

În folderul `Backend`:

**Windows (PowerShell)**
```powershell
copy .env.example .env
```

**Mac / Linux**
```bash
cp .env.example .env
```

Deschide `.env` și pune token-ul după `EARTHDATA_TOKEN=`. Fișierul `.env` nu ajunge pe git.

### 4. Pornește serverul

Din folderul `Backend` (toate sistemele):
```bash
cargo run
```

Prima dată compilează 1–3 minute. Când vezi `listening on http://localhost:3000`, e gata.

Deschide http://localhost:3000 — se deschide Swagger, de unde poți testa API-ul cu butonul **Try it out**.

Oprire: `Ctrl + C`.

## Probleme frecvente

| Problemă | Rezolvare |
|---|---|
| `cargo: command not found` | Deschide un terminal nou după instalarea Rust |
| Windows: eroare cu `link.exe` | Lipsesc C++ Build Tools: rulează din nou `rustup-init.exe` și acceptă instalarea lor |
| `EARTHDATA_TOKEN is not set` | Nu ai `.env` în folderul `Backend` sau e gol |
| `Earthdata rejected the token` | Token expirat sau nu ai aprobat *Alaska Satellite Facility Data Access* (pasul 2.3) |
| Job-ul dă `inference service unreachable` | Normal dacă nu rulează serviciul Python (vezi mai jos). Restul API-ului merge |
| Windows Firewall întreabă | Permite accesul |

## Serviciul de inferență (pentru rezultate reale)

Backend-ul trimite imaginile unui serviciu Python care rulează modelul antrenat. Fără el, job-ul se oprește la pasul `running` cu `inference service unreachable`.

1. Modelul: pune folderul `sar_change_bundle` (de la echipa Colab, conține `model.onnx` + `model_meta.json`) în `Backend/`. Nu e pe git, cere-l pe Drive.
2. Într-un **al doilea terminal**, din rădăcina repo-ului:

```bash
cd PipelineSar/inference_service
pip install -r requirements.txt
uvicorn app:app --port 8000
```

Verificare: http://localhost:8000/health trebuie să arate `"model": "SiameseUNet"`. Dacă bundle-ul e în alt loc: `MODEL_DIR=/calea/catre/bundle uvicorn app:app --port 8000`.

## API (pentru frontend)

Toate răspunsurile sunt JSON. Documentația interactivă: http://localhost:3000/swagger-ui/

**1. Pornește o analiză** — `POST /api/analyze`
```json
{
  "polygon": [[27.70, 45.55], [28.05, 45.55], [28.05, 45.80], [27.70, 45.80]],
  "start_date": "2024-07-01",
  "end_date": "2024-11-30",
  "analysis_type": "surface"
}
```
`polygon` = lista de puncte `[lon, lat]` desenate de user (minim 3). Răspuns: `202 { "job_id": "...", "status": "queued" }`.

**2. Întreabă de rezultat** — `GET /api/jobs/{job_id}` (la fiecare ~2 secunde)
```json
{
  "id": "...",
  "status": "queued | searching | downloading | running | done | error",
  "message": "downloading scene 2024-07-12",
  "result": {
    "from": "2024-07-12",
    "to": "2024-11-21",
    "changed_km2": 12.4,
    "changed_pct": 3.1,
    "features": { "type": "FeatureCollection", "features": [] },
    "overlay_png": "<base64>",
    "overlay_bounds": [west, south, east, north]
  },
  "error": "apare doar când status = error"
}
```
- `result` apare doar la `status: done`
- `features` e GeoJSON (lon/lat) → `Cesium.GeoJsonDataSource.load(result.features)`
- `overlay_png` + `overlay_bounds` → imagine de probabilitate, se pune pe glob cu `SingleTileImageryProvider`

**Erori de validare** (`400 { "error": "..." }`): date în format `YYYY-MM-DD`, start înainte de end, minim 3 puncte, zonă de maxim 50 × 50 km.

## Setări opționale

Se pun în `.env` doar dacă vrei să schimbi default-urile: `PORT` (3000), `INFERENCE_URL` (http://localhost:8000), `SAR_CACHE_DIR` (./cache), `MAX_AOI_KM` (50).
