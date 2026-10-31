//! Import/export engines. Each runs as a background job: it reports progress through a `JobCtx`,
//! checks `cancelled()` between units of work, and returns a `JobDone` (never an `Err`).
pub mod export;
pub mod import;
pub mod writer;
pub mod parse;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::model::{JobDone, JobProgress};

type Emit = Box<dyn Fn(JobProgress) + Send + Sync>;

pub struct JobCtx {
    pub id: String,
    cancel: Arc<AtomicBool>,
    emit: Emit,
    last: Mutex<Option<Instant>>,
}

impl JobCtx {
    pub fn new(id: String, cancel: Arc<AtomicBool>, emit: Emit) -> Self {
        Self { id, cancel, emit, last: Mutex::new(None) }
    }

    /// A context for tests: never cancelled, progress collected into the returned vector.
    pub fn for_test() -> (Self, Arc<Mutex<Vec<JobProgress>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let ctx = Self::new("test".into(), Arc::new(AtomicBool::new(false)), Box::new(move |p| sink.lock().unwrap().push(p)));
        (ctx, seen)
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// Emits progress at most every 100 ms (the first and `force`d calls always go out).
    pub fn progress(&self, done: u64, total: Option<u64>, message: &str, force: bool) {
        let mut last = self.last.lock().unwrap();
        if !force && last.is_some_and(|t| t.elapsed() < Duration::from_millis(100)) {
            return;
        }
        *last = Some(Instant::now());
        (self.emit)(JobProgress { job_id: self.id.clone(), done, total, message: message.to_string() });
    }

    /// A finished job with this id.
    pub fn done(&self) -> JobDone {
        JobDone { job_id: self.id.clone(), ..Default::default() }
    }
}
