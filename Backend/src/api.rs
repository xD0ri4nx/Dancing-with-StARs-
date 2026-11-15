use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect, Response};
use axum::{Json, Router, routing::get, routing::post};
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;
use uuid::Uuid;

use crate::AppState;
use crate::geo::Polygon;
use crate::inference::AnalysisResult;
use crate::jobs::{Job, Status};

#[derive(OpenApi)]
#[openapi(
    info(title = "SAR Change Detection API", description = "Experimental NISAR GCOV change detection over a user-drawn parcel."),
    paths(health, analyze, get_job),
    components(schemas(AnalyzeRequest, AnalyzeResponse, Job, Status, AnalysisResult, Polygon, ErrorBody))
)]
struct ApiDoc;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(|| async { Redirect::to("/swagger-ui/") }))
        .route("/api/health", get(health))
        .route("/api/analyze", post(analyze))
        .route("/api/jobs/{id}", get(get_job))
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .with_state(state)
}

#[derive(Deserialize, ToSchema)]
pub struct AnalyzeRequest {
    pub polygon: Polygon,
    #[schema(example = "2024-07-01")]
    pub start_date: String,
    #[schema(example = "2024-11-30")]
    pub end_date: String,
    #[serde(default = "default_type")]
    #[schema(example = "surface")]
    pub analysis_type: String,
}

fn default_type() -> String {
    "surface".into()
}

#[derive(Serialize, ToSchema)]
struct AnalyzeResponse {
    job_id: Uuid,
    status: Status,
}

#[derive(Serialize, ToSchema)]
struct ErrorBody {
    error: String,
}

#[utoipa::path(get, path = "/api/health", responses((status = 200, description = "Service is up")))]
async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true }))
}

/// Start a change-detection job. Poll `/api/jobs/{id}` for the result.
#[utoipa::path(post, path = "/api/analyze", request_body = AnalyzeRequest,
    responses((status = 202, body = AnalyzeResponse), (status = 400, body = ErrorBody)))]
async fn analyze(State(state): State<AppState>, Json(req): Json<AnalyzeRequest>) -> Result<Response, ApiError> {
    if !is_date(&req.start_date) || !is_date(&req.end_date) {
        return Err(ApiError::bad("dates must be YYYY-MM-DD"));
    }
    if req.start_date >= req.end_date {
        return Err(ApiError::bad("start_date must be before end_date"));
    }
    req.polygon.validate(state.max_aoi_km).map_err(ApiError::bad)?;

    let id = state.jobs.create().await;
    tokio::spawn(run_job(state.clone(), id, req));
    Ok((StatusCode::ACCEPTED, Json(AnalyzeResponse { job_id: id, status: Status::Queued })).into_response())
}

/// Job status; `result` is present when status is `done`, `error` when it is `error`.
#[utoipa::path(get, path = "/api/jobs/{id}", params(("id" = Uuid, Path)),
    responses((status = 200, body = Job), (status = 404, body = ErrorBody)))]
async fn get_job(State(state): State<AppState>, Path(id): Path<Uuid>) -> Result<Response, ApiError> {
    match state.jobs.get(id).await {
        Some(job) => Ok(Json(job).into_response()),
        None => Err(ApiError(StatusCode::NOT_FOUND, "job not found".into())),
    }
}

/// The whole pipeline for one request: search → download → inference.
async fn run_job(state: AppState, id: Uuid, req: AnalyzeRequest) {
    let jobs = state.jobs.clone();
    let step = async {
        jobs.update(id, Status::Searching, "Searching NISAR and processing data; large downloads may take time").await;
        state.inference.analyze_nisar(&req.polygon, &req.start_date, &req.end_date, &req.analysis_type).await
    };

    match step.await {
        Ok(result) => jobs.finish(id, result).await,
        Err(e) => {
            tracing::warn!(job = %id, "job failed: {e:#}");
            jobs.fail(id, format!("{e:#}")).await
        }
    }
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

pub struct ApiError(StatusCode, String);

impl ApiError {
    fn bad(msg: impl ToString) -> Self {
        Self(StatusCode::BAD_REQUEST, msg.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}
