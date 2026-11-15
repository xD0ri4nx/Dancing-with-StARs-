//! Client for the Python inference service (same preprocessing as the Colab notebook).

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::asf::SceneFiles;
use crate::geo::Polygon;

#[derive(Serialize)]
struct PredictRequest<'a> {
    polygon: &'a Polygon,
    analysis_type: &'a str,
    t1: &'a SceneFiles,
    t2: &'a SceneFiles,
}

/// What the frontend receives.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AnalysisResult {
    #[schema(example = "2024-07-12")]
    pub from: String,
    #[schema(example = "2024-11-21")]
    pub to: String,
    pub changed_km2: f64,
    pub changed_pct: f64,
    /// GeoJSON FeatureCollection in EPSG:4326.
    #[schema(value_type = Object)]
    pub features: Value,
    /// Optional PNG (base64) of the change probability map, with its WGS84 bounds [w, s, e, n].
    #[serde(default)]
    pub overlay_png: Option<String>,
    #[serde(default)]
    pub overlay_bounds: Option<[f64; 4]>,
}

#[derive(Clone)]
pub struct InferenceClient {
    http: reqwest::Client,
    base_url: String,
}

impl InferenceClient {
    pub fn new(base_url: String) -> Self {
        Self { http: reqwest::Client::new(), base_url }
    }

    pub async fn analyze_nisar(&self, polygon: &Polygon, start: &str, end: &str, analysis_type: &str) -> Result<AnalysisResult> {
        let body = serde_json::json!({"polygon": polygon, "start_date": start, "end_date": end, "analysis_type": analysis_type});
        let resp = self.http.post(format!("{}/analyze", self.base_url)).json(&body).send().await.context("NISAR inference service unreachable")?;
        if !resp.status().is_success() { bail!("NISAR inference service error {}: {}", resp.status(), resp.text().await.unwrap_or_default()); }
        Ok(resp.json().await?)
    }

    pub async fn predict(
        &self,
        polygon: &Polygon,
        analysis_type: &str,
        t1: &SceneFiles,
        t2: &SceneFiles,
    ) -> Result<AnalysisResult> {
        let resp = self
            .http
            .post(format!("{}/predict", self.base_url))
            .json(&PredictRequest { polygon, analysis_type, t1, t2 })
            .send()
            .await
            .context("inference service unreachable")?;
        if !resp.status().is_success() {
            bail!("inference service error {}: {}", resp.status(), resp.text().await.unwrap_or_default());
        }
        Ok(resp.json().await?)
    }
}
