//! A small C ABI over the cccc complexity engine, made for `bun:ffi`.
//!
//! Every entry point takes one UTF-8 JSON request (a pointer and a byte
//! length) and returns one NUL-terminated UTF-8 JSON response. The caller must
//! give each returned pointer back to [`cccc_string_free`].
//!
//! A response is always an envelope: `{"ok": <value>}` on success, or
//! `{"error": "<message>"}` on failure. A panic in an adapter does not cross
//! the FFI boundary: it becomes an error for that file (or for the call).

use std::ffi::{CString, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use cccc_cli::lang::{self, LANGUAGES, Language};
use cccc_core::report::FileReport;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// Stack for each worker thread: what the adapters need, plus room to drop and
/// serialize deeply nested reports (the same budget the `cccc` CLI uses).
const STACK_SIZE: usize = cccc_core::guard::STACK_SIZE + (64 << 20);

/// The cccc release at the git `rev` in `Cargo.toml`. Change both together.
const CCCC_VERSION: &str = "1.8.2";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LanguageInfo {
    name: &'static str,
    aliases: &'static [&'static str],
    extensions: &'static [&'static str],
}

#[derive(Deserialize)]
struct SourceRequest {
    language: String,
    path: PathBuf,
    source: String,
}

#[derive(Deserialize)]
struct FilesRequest {
    files: Vec<FileRequest>,
}

#[derive(Deserialize)]
struct FileRequest {
    path: PathBuf,
    language: String,
}

#[derive(Serialize)]
#[serde(untagged)]
enum FileOutcome {
    Report {
        language: &'static str,
        report: FileReport,
    },
    Error {
        path: String,
        error: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Envelope<T: Serialize> {
    Ok(T),
    Error(String),
}

/// Returns the version of this library and of the cccc engine, as
/// `{"ok": {"ffi": "...", "cccc": "..."}}`.
#[unsafe(no_mangle)]
pub extern "C" fn cccc_version() -> *mut c_char {
    #[derive(Serialize)]
    struct Version {
        ffi: &'static str,
        cccc: &'static str,
    }
    respond(Envelope::Ok(Version {
        ffi: env!("CARGO_PKG_VERSION"),
        cccc: CCCC_VERSION,
    }))
}

/// Returns every language compiled into the engine, as
/// `{"ok": [{"name", "aliases", "extensions"}]}`.
#[unsafe(no_mangle)]
pub extern "C" fn cccc_languages() -> *mut c_char {
    let langs: Vec<LanguageInfo> = LANGUAGES
        .iter()
        .map(|l| LanguageInfo {
            name: l.name,
            aliases: l.aliases,
            extensions: l.exts,
        })
        .collect();
    respond(Envelope::Ok(langs))
}

/// Analyzes source text that is in memory.
///
/// Request: `{"language", "path", "source"}`. The path is only a label (and,
/// for some adapters, a hint for the dialect, e.g. `.tsx`). Response:
/// `{"ok": FileReport}`.
///
/// # Safety
///
/// `request` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cccc_analyze_source(request: *const u8, len: usize) -> *mut c_char {
    // SAFETY: the caller guarantees `request` points to `len` readable bytes.
    let bytes = unsafe { request_bytes(request, len) };
    let envelope = parse::<SourceRequest>(bytes).and_then(|req| {
        let language = find_language(&req.language)?;
        on_large_stack(move || guarded(|| (language.analyze)(&req.path, &req.source)))
    });
    respond(match envelope {
        Ok(report) => Envelope::Ok(report),
        Err(e) => Envelope::Error(e),
    })
}

/// Reads and analyzes many files in parallel.
///
/// Request: `{"files": [{"path", "language"}]}`. Response: `{"ok": [...]}`,
/// with one entry per file in request order. Each entry is either
/// `{"language", "report": FileReport}` or `{"path", "error"}`.
///
/// # Safety
///
/// `request` must point to `len` readable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cccc_analyze_files(request: *const u8, len: usize) -> *mut c_char {
    // SAFETY: the caller guarantees `request` points to `len` readable bytes.
    let bytes = unsafe { request_bytes(request, len) };
    let envelope = parse::<FilesRequest>(bytes).and_then(|req| {
        pool()?.install(|| {
            Ok(req
                .files
                .into_par_iter()
                .map(|file| analyze_file(&file.path, &file.language))
                .collect::<Vec<_>>())
        })
    });
    respond(match envelope {
        Ok(outcomes) => Envelope::Ok(outcomes),
        Err(e) => Envelope::Error(e),
    })
}

/// Releases a string that this library returned.
///
/// # Safety
///
/// `ptr` must be null or a pointer that this library returned and that was
/// not released before.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cccc_string_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        // SAFETY: the caller guarantees `ptr` came from `CString::into_raw`.
        drop(unsafe { CString::from_raw(ptr) });
    }
}

unsafe fn request_bytes<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: forwarded from the caller of the entry point.
        unsafe { std::slice::from_raw_parts(ptr, len) }
    }
}

fn parse<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("invalid request: {e}"))
}

fn respond<T: Serialize>(envelope: Envelope<T>) -> *mut c_char {
    let json = serde_json::to_string(&envelope).unwrap_or_else(|e| {
        format!(r#"{{"error":{}}}"#, serde_json::Value::String(e.to_string()))
    });
    // serde_json escapes NUL inside strings, so the output never contains one.
    CString::new(json)
        .expect("JSON output contains no NUL byte")
        .into_raw()
}

fn find_language(query: &str) -> Result<&'static Language, String> {
    let name = lang::require_canonical(query, "request")?;
    Ok(LANGUAGES
        .iter()
        .find(|l| l.name == name)
        .expect("canonical name is registered"))
}

fn analyze_file(path: &Path, language: &str) -> FileOutcome {
    let fail = |error: String| FileOutcome::Error {
        path: path.display().to_string(),
        error,
    };
    let language = match find_language(language) {
        Ok(l) => l,
        Err(e) => return fail(e),
    };
    let source = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => return fail(format!("cannot read file: {e}")),
    };
    match guarded(|| (language.analyze)(path, &source)) {
        Ok(report) => FileOutcome::Report {
            language: language.name,
            report,
        },
        Err(e) => fail(e),
    }
}

fn guarded<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(f)).map_err(|panic| {
        let msg = panic
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| panic.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".to_string());
        format!("analyzer panicked: {msg}")
    })
}

fn on_large_stack<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    std::thread::Builder::new()
        .name("cccc".into())
        .stack_size(STACK_SIZE)
        .spawn(f)
        .map_err(|e| format!("cannot spawn analysis thread: {e}"))?
        .join()
        .map_err(|_| "analysis thread panicked".to_string())?
}

fn pool() -> Result<&'static rayon::ThreadPool, String> {
    static POOL: OnceLock<Result<rayon::ThreadPool, String>> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .thread_name(|i| format!("cccc-{i}"))
            .stack_size(STACK_SIZE)
            .build()
            .map_err(|e| format!("cannot create thread pool: {e}"))
    })
    .as_ref()
    .map_err(Clone::clone)
}
