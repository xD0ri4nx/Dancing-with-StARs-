//! NASA ASF DAAC client: search OPERA RTC-S1 scenes and download them to a local cache.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, LOCATION};
use serde::Serialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::geo::Polygon;

const SEARCH_URL: &str = "https://api.daac.asf.alaska.edu/services/search/param";

/// One Sentinel-1 burst acquisition (both polarizations).
#[derive(Debug, Clone, Serialize)]
pub struct Scene {
    pub burst_id: String,
    pub date: String,
    pub vv_url: String,
    pub vh_url: String,
}

/// Local files for a scene after download.
#[derive(Debug, Clone, Serialize)]
pub struct SceneFiles {
    pub date: String,
    pub vv: PathBuf,
    pub vh: PathBuf,
}

#[derive(Clone)]
pub struct AsfClient {
    http: reqwest::Client,
    token: String,
    cache_dir: PathBuf,
}

impl AsfClient {
    pub fn new(token: String, cache_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&cache_dir)?;
        // Absolute, so the inference service can open the files from any working directory.
        let cache_dir = cache_dir.canonicalize()?;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self { http, token, cache_dir })
    }

    /// Finds the burst with the most scenes in the interval and returns its first and last scene.
    pub async fn find_pair(&self, aoi: &Polygon, start: &str, end: &str) -> Result<(Scene, Scene)> {
        let resp = self
            .http
            .get(SEARCH_URL)
            .query(&[
                ("dataset", "OPERA-S1"),
                ("processingLevel", "RTC"),
                ("intersectsWith", &aoi.to_wkt()),
                ("start", &format!("{start}T00:00:00Z")),
                ("end", &format!("{end}T23:59:59Z")),
                ("maxResults", "2000"),
                ("output", "geojson"),
            ])
            .send()
            .await
            .context("ASF search request failed")?
            .error_for_status()
            .context("ASF search returned an error")?
            .json::<Value>()
            .await?;

        let mut by_burst: HashMap<String, Vec<Scene>> = HashMap::new();
        for f in resp["features"].as_array().into_iter().flatten() {
            if let Some(s) = parse_scene(&f["properties"]) {
                by_burst.entry(s.burst_id.clone()).or_default().push(s);
            }
        }

        let mut scenes = by_burst
            .into_values()
            .filter(|v| v.len() >= 2)
            .max_by_key(|v| v.len())
            .ok_or_else(|| anyhow!("no burst with at least two SAR scenes between {start} and {end}"))?;
        scenes.sort_by(|a, b| a.date.cmp(&b.date));
        scenes.dedup_by(|a, b| a.date == b.date);
        if scenes.len() < 2 {
            bail!("only one acquisition date available in this interval");
        }
        Ok((scenes.first().unwrap().clone(), scenes.last().unwrap().clone()))
    }

    pub async fn download_scene(&self, scene: &Scene) -> Result<SceneFiles> {
        Ok(SceneFiles {
            date: scene.date.clone(),
            vv: self.download(&scene.vv_url).await?,
            vh: self.download(&scene.vh_url).await?,
        })
    }

    /// Downloads a file unless it is already in the cache. Follows Earthdata redirects by hand
    /// so the bearer token is kept across hosts.
    async fn download(&self, url: &str) -> Result<PathBuf> {
        let name = Path::new(url).file_name().ok_or_else(|| anyhow!("bad url {url}"))?;
        let dest = self.cache_dir.join(name);
        if tokio::fs::metadata(&dest).await.is_ok() {
            return Ok(dest);
        }

        let mut current = url.to_string();
        let resp = loop {
            let r = self
                .http
                .get(&current)
                .header(AUTHORIZATION, format!("Bearer {}", self.token))
                .send()
                .await?;
            if r.status().is_redirection() {
                let loc = r
                    .headers()
                    .get(LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| anyhow!("redirect without Location"))?;
                current = r.url().join(loc)?.to_string();
                // A bounce to the URS login page means the bearer token was not accepted.
                if current.contains("urs.earthdata.nasa.gov/oauth/authorize") {
                    bail!("Earthdata rejected the token; check EARTHDATA_TOKEN and that 'Alaska Satellite Facility Data Access' is authorized in your Earthdata profile");
                }
                continue;
            }
            if r.status() == 401 || r.status() == 403 {
                bail!("Earthdata rejected the token (HTTP {})", r.status());
            }
            break r.error_for_status()?;
        };

        let tmp = dest.with_extension("part");
        let mut file = tokio::fs::File::create(&tmp).await?;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            file.write_all(&chunk?).await?;
        }
        file.flush().await?;
        tokio::fs::rename(&tmp, &dest).await?;
        Ok(dest)
    }
}

fn parse_scene(p: &Value) -> Option<Scene> {
    let file_id = p["fileID"].as_str()?;
    let burst_id = p["operaBurstID"]
        .as_str()
        .map(str::to_string)
        .or_else(|| file_id.split('_').find(|s| s.starts_with('T') && s.contains("-IW")).map(str::to_string))?;
    let date = p["startTime"].as_str()?[..10].to_string();

    let mut urls: Vec<&str> = p["additionalUrls"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    if let Some(u) = p["url"].as_str() {
        urls.push(u);
    }
    let pick = |suffix: &str| urls.iter().find(|u| u.ends_with(suffix)).map(|u| u.to_string());
    Some(Scene {
        burst_id,
        date,
        vv_url: pick("_VV.tif")?,
        vh_url: pick("_VH.tif")?,
    })
}
