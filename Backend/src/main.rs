mod api;
mod asf;
mod geo;
mod inference;
mod jobs;

use std::env;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

#[derive(Clone)]
pub struct AppState {
    pub asf: asf::AsfClient,
    pub inference: inference::InferenceClient,
    pub jobs: jobs::JobStore,
    pub max_aoi_km: f64,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(env::var("RUST_LOG").unwrap_or_else(|_| "info,tower_http=info".into()))
        .init();

    let token = env::var("EARTHDATA_TOKEN").context("EARTHDATA_TOKEN is not set")?;
    let cache_dir = PathBuf::from(env::var("SAR_CACHE_DIR").unwrap_or_else(|_| "cache".into()));
    let inference_url = env::var("INFERENCE_URL").unwrap_or_else(|_| "http://localhost:8000".into());
    let max_aoi_km: f64 = env::var("MAX_AOI_KM").ok().and_then(|v| v.parse().ok()).unwrap_or(50.0);
    let port: u16 = env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(3000);

    let state = AppState {
        asf: asf::AsfClient::new(token, cache_dir)?,
        inference: inference::InferenceClient::new(inference_url),
        jobs: jobs::JobStore::default(),
        max_aoi_km,
    };

    let app = api::router(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("listening on http://localhost:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}
