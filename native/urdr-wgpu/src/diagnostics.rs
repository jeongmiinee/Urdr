use std::{
    cell::Cell,
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

const LOG_QUEUE_CAPACITY: usize = 2_048;
const RETAINED_LOG_FILES: usize = 12;

static LOGGER: OnceLock<RuntimeLogger> = OnceLock::new();
static REGIONAL_REFINEMENT_CALLS: AtomicU64 = AtomicU64::new(0);
static MAP_GENERATION_CALLS: AtomicU64 = AtomicU64::new(0);

thread_local! {
    static THREAD_PIPELINE_CALLS: Cell<PipelineCallCounters> = const {
        Cell::new(PipelineCallCounters {
            regional_refinement_calls: 0,
            map_generation_calls: 0,
        })
    };
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PipelineCallCounters {
    pub regional_refinement_calls: u64,
    pub map_generation_calls: u64,
}

pub(crate) fn mark_regional_refinement_call() {
    REGIONAL_REFINEMENT_CALLS.fetch_add(1, Ordering::Relaxed);
    THREAD_PIPELINE_CALLS.with(|calls| {
        let mut value = calls.get();
        value.regional_refinement_calls = value.regional_refinement_calls.saturating_add(1);
        calls.set(value);
    });
}

pub(crate) fn mark_map_generation_call() {
    MAP_GENERATION_CALLS.fetch_add(1, Ordering::Relaxed);
    THREAD_PIPELINE_CALLS.with(|calls| {
        let mut value = calls.get();
        value.map_generation_calls = value.map_generation_calls.saturating_add(1);
        calls.set(value);
    });
}

pub(crate) fn pipeline_call_counters() -> PipelineCallCounters {
    PipelineCallCounters {
        regional_refinement_calls: REGIONAL_REFINEMENT_CALLS.load(Ordering::Relaxed),
        map_generation_calls: MAP_GENERATION_CALLS.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
pub(crate) fn thread_pipeline_call_counters() -> PipelineCallCounters {
    THREAD_PIPELINE_CALLS.with(Cell::get)
}

#[derive(Serialize)]
struct StructuredRecord {
    sequence: u64,
    unix_ms: u128,
    session_elapsed_ms: u128,
    level: &'static str,
    category: String,
    operation: String,
    phase: String,
    process_id: u32,
    thread: String,
    fields: BTreeMap<String, String>,
}

enum LogCommand {
    Record(StructuredRecord),
    Flush,
    Shutdown,
}

struct RuntimeLogger {
    sender: SyncSender<LogCommand>,
    worker: Mutex<Option<JoinHandle<()>>>,
    started: Instant,
    sequence: AtomicU64,
    directory: PathBuf,
}

pub(crate) fn initialize() -> Option<PathBuf> {
    if let Some(logger) = LOGGER.get() {
        return Some(logger.directory.clone());
    }
    let logger = RuntimeLogger::start().ok()?;
    let directory = logger.directory.clone();
    if LOGGER.set(logger).is_err() {
        return LOGGER.get().map(|logger| logger.directory.clone());
    }
    event(
        "application",
        "startup",
        "logger_ready",
        &[("log_directory", directory.display().to_string())],
    );
    Some(directory)
}

pub(crate) fn event(category: &str, operation: &str, phase: &str, fields: &[(&str, String)]) {
    emit("info", category, operation, phase, fields);
}

pub(crate) fn warning(category: &str, operation: &str, phase: &str, fields: &[(&str, String)]) {
    emit("warning", category, operation, phase, fields);
}

pub(crate) fn error(category: &str, operation: &str, phase: &str, fields: &[(&str, String)]) {
    emit("error", category, operation, phase, fields);
    flush();
}

pub(crate) fn flush() {
    if let Some(logger) = LOGGER.get() {
        let _ = logger.sender.try_send(LogCommand::Flush);
    }
}

pub(crate) fn shutdown() {
    let Some(logger) = LOGGER.get() else {
        return;
    };
    let _ = logger.sender.send(LogCommand::Shutdown);
    if let Ok(mut worker) = logger.worker.lock()
        && let Some(worker) = worker.take()
    {
        let _ = worker.join();
    }
}

pub(crate) fn write_debug_artifact(
    prefix: &str,
    extension: &str,
    contents: &[u8],
) -> Result<PathBuf, String> {
    let directory = LOGGER
        .get()
        .map(|logger| logger.directory.clone())
        .ok_or_else(|| "diagnostics logger is not initialized".to_owned())?;
    let safe_prefix = prefix
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let safe_extension = extension.trim_start_matches('.');
    let path = directory.join(format!(
        "{safe_prefix}-{}.{}",
        unix_millis(),
        safe_extension
    ));
    fs::write(&path, contents).map_err(|error| error.to_string())?;
    Ok(path)
}

pub(crate) fn write_debug_package(
    prefix: &str,
    files: &[(&str, Vec<u8>)],
) -> Result<PathBuf, String> {
    let directory = create_debug_package(prefix)?;
    for (name, contents) in files {
        let safe_name = Path::new(name)
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("invalid diagnostic file name: {name}"))?;
        fs::write(directory.join(safe_name), contents).map_err(|error| error.to_string())?;
    }
    Ok(directory)
}

pub(crate) fn create_debug_package(prefix: &str) -> Result<PathBuf, String> {
    let root = LOGGER
        .get()
        .map(|logger| logger.directory.clone())
        .ok_or_else(|| "diagnostics logger is not initialized".to_owned())?;
    let safe_prefix = prefix
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let directory = root.join(format!("{safe_prefix}-{}", unix_millis()));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn emit(
    level: &'static str,
    category: &str,
    operation: &str,
    phase: &str,
    fields: &[(&str, String)],
) {
    let Some(logger) = LOGGER.get() else {
        return;
    };
    let record = StructuredRecord {
        sequence: logger.sequence.fetch_add(1, Ordering::Relaxed),
        unix_ms: unix_millis(),
        session_elapsed_ms: logger.started.elapsed().as_millis(),
        level,
        category: category.to_owned(),
        operation: operation.to_owned(),
        phase: phase.to_owned(),
        process_id: std::process::id(),
        thread: thread::current().name().unwrap_or("unnamed").to_owned(),
        fields: fields
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect(),
    };
    let _ = logger.sender.try_send(LogCommand::Record(record));
}

impl RuntimeLogger {
    fn start() -> Result<Self, String> {
        let directory = create_log_directory()?;
        rotate_logs(&directory, "urdr-session-", ".log");
        rotate_logs(&directory, "map-performance-", ".jsonl");

        let session = format!("{}-{}", unix_millis(), std::process::id());
        let human_path = directory.join(format!("urdr-session-{session}.log"));
        let structured_path = directory.join(format!("map-performance-{session}.jsonl"));
        let human = open_log(&human_path)?;
        let structured = open_log(&structured_path)?;
        let (sender, receiver) = mpsc::sync_channel(LOG_QUEUE_CAPACITY);
        let worker = thread::Builder::new()
            .name("urdr-diagnostics-writer".to_owned())
            .spawn(move || {
                let mut human = BufWriter::with_capacity(64 * 1_024, human);
                let mut structured = BufWriter::with_capacity(64 * 1_024, structured);
                while let Ok(command) = receiver.recv() {
                    match command {
                        LogCommand::Record(record) => {
                            write_human_record(&mut human, &record);
                            if let Ok(line) = serde_json::to_string(&record) {
                                let _ = writeln!(structured, "{line}");
                            }
                            // Generation stages are sparse. Flushing each stage keeps the last
                            // completed operation available even if the renderer is terminated.
                            let _ = human.flush();
                            let _ = structured.flush();
                        }
                        LogCommand::Flush => {
                            let _ = human.flush();
                            let _ = structured.flush();
                        }
                        LogCommand::Shutdown => {
                            let _ = human.flush();
                            let _ = structured.flush();
                            break;
                        }
                    }
                }
            })
            .map_err(|error| error.to_string())?;

        Ok(Self {
            sender,
            worker: Mutex::new(Some(worker)),
            started: Instant::now(),
            sequence: AtomicU64::new(1),
            directory,
        })
    }
}

fn create_log_directory() -> Result<PathBuf, String> {
    let portable = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Logs");
    if fs::create_dir_all(&portable).is_ok() {
        return Ok(portable);
    }
    let fallback = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("URDR")
        .join("Logs");
    fs::create_dir_all(&fallback).map_err(|error| error.to_string())?;
    Ok(fallback)
}

fn open_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn rotate_logs(directory: &Path, prefix: &str, extension: &str) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut files = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (name.starts_with(prefix) && name.ends_with(extension)).then(|| {
                let modified = entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(UNIX_EPOCH);
                (modified, entry.path())
            })
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(modified, _)| *modified);
    let remove_count = files.len().saturating_sub(RETAINED_LOG_FILES - 1);
    for (_, path) in files.into_iter().take(remove_count) {
        let _ = fs::remove_file(path);
    }
}

fn write_human_record(writer: &mut BufWriter<File>, record: &StructuredRecord) {
    let fields = record
        .fields
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join(" ");
    let suffix = if fields.is_empty() {
        String::new()
    } else {
        format!(" {fields}")
    };
    let _ = writeln!(
        writer,
        "[{} ms] {:<7} {}::{} phase={} thread={}{}",
        record.session_elapsed_ms,
        record.level,
        record.category,
        record.operation,
        record.phase,
        record.thread,
        suffix,
    );
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
}
