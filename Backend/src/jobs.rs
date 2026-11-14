//! In-memory job store. Jobs are lost on restart, which is fine for the prototype.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::RwLock;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::inference::AnalysisResult;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Queued,
    Searching,
    Downloading,
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Job {
    pub id: Uuid,
    pub status: Status,
    #[schema(example = "downloading scene 2024-07-12")]
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<AnalysisResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Default)]
pub struct JobStore(Arc<RwLock<HashMap<Uuid, Job>>>);

impl JobStore {
    pub async fn create(&self) -> Uuid {
        let id = Uuid::new_v4();
        let job = Job { id, status: Status::Queued, message: "queued".into(), result: None, error: None };
        self.0.write().await.insert(id, job);
        id
    }

    pub async fn get(&self, id: Uuid) -> Option<Job> {
        self.0.read().await.get(&id).cloned()
    }

    pub async fn update(&self, id: Uuid, status: Status, message: impl Into<String>) {
        if let Some(j) = self.0.write().await.get_mut(&id) {
            j.status = status;
            j.message = message.into();
        }
    }

    pub async fn finish(&self, id: Uuid, result: AnalysisResult) {
        if let Some(j) = self.0.write().await.get_mut(&id) {
            j.status = Status::Done;
            j.message = "done".into();
            j.result = Some(result);
        }
    }

    pub async fn fail(&self, id: Uuid, error: impl ToString) {
        if let Some(j) = self.0.write().await.get_mut(&id) {
            j.status = Status::Error;
            j.message = "failed".into();
            j.error = Some(error.to_string());
        }
    }
}
