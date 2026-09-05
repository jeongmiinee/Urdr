use std::{
    collections::{HashMap, VecDeque},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Mutex, OnceLock,
        mpsc::{self, Receiver, TryRecvError},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{
    ipa,
    model::{DictionaryVoiceProfile, EmbeddedSpeechAsset, Language},
    resources,
};

#[derive(Default)]
pub struct ImsToucanState {
    initialized: bool,
    manifest: Option<ImsToucanManifest>,
    speech_root: Option<PathBuf>,
    cache: HashMap<String, CachedSpeech>,
    pending: Option<PendingSpeech>,
    queued: VecDeque<QueuedSpeech>,
    warmup: Option<Receiver<Result<(), String>>>,
    worker_ready: bool,
    pub playing_key: Option<String>,
    playing_until: Option<Instant>,
    pub status: String,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImsToucanManifest {
    engine: String,
    license: String,
    provenance: String,
    #[serde(default)]
    required: Vec<String>,
    runner: ImsToucanRunner,
    #[serde(default)]
    voices: Vec<ImsToucanVoice>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImsToucanRunner {
    executable: String,
    script: String,
    #[serde(default)]
    worker_script: String,
    engine_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImsToucanVoice {
    id: String,
    language: String,
    model: String,
    vocoder: String,
}

struct CachedSpeech {
    path: PathBuf,
    duration: Duration,
}

struct PendingSpeech {
    key: String,
    receiver: Receiver<Result<PathBuf, String>>,
    duration: Duration,
}

struct QueuedSpeech {
    key: String,
    ipa: String,
    output: PathBuf,
    profile: DictionaryVoiceProfile,
    duration: Duration,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRequest<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    id: &'a str,
    ipa: &'a str,
    output: &'a str,
    speed: f32,
    pitch: f32,
    volume: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerResponse {
    #[serde(rename = "type")]
    message_type: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    startup_ms: f64,
    #[serde(default)]
    acoustic_ms: f64,
    #[serde(default)]
    vocoder_ms: f64,
    #[serde(default)]
    write_ms: f64,
}

struct PersistentImsWorker {
    voice_id: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

static IMS_WORKER: OnceLock<Mutex<Option<PersistentImsWorker>>> = OnceLock::new();

#[derive(Debug, PartialEq, Eq)]
pub enum SpeechRequest {
    Disabled,
    Unsupported(Vec<String>),
    ModelUnavailable,
    Queued(String),
    Stopped,
}

impl ImsToucanState {
    pub fn ensure_initialized(&mut self, language: Language) {
        if self.initialized {
            return;
        }
        self.initialized = true;
        match load_manifest() {
            Ok((manifest, root)) => {
                let _ = cleanup_speech_cache();
                self.status = tr(
                    language,
                    "IMS-Toucan IPA 음성 모델을 불러오는 중입니다.",
                    "Loading the IMS-Toucan IPA speech model.",
                )
                .to_owned();
                let warm_manifest = manifest.clone();
                let warm_root = root.clone();
                let mut profile = DictionaryVoiceProfile::default();
                if let Some(voice) = manifest.voices.first() {
                    profile.voice_id = voice.id.clone();
                }
                let (sender, receiver) = mpsc::channel();
                thread::spawn(move || {
                    let result = ensure_persistent_worker(&warm_root, &warm_manifest, &profile);
                    let _ = sender.send(result);
                });
                self.warmup = Some(receiver);
                self.manifest = Some(manifest);
                self.speech_root = Some(root);
            }
            Err(error) => {
                self.last_error = Some(error);
                self.status = tr(
                    language,
                    "IMS-Toucan 음성 런타임을 사용할 수 없습니다.",
                    "The IMS-Toucan speech runtime is unavailable.",
                )
                .to_owned();
            }
        }
    }

    pub fn poll(&mut self, language: Language) {
        if self
            .playing_until
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            self.playing_key = None;
            self.playing_until = None;
        }
        if let Some(receiver) = self.warmup.take() {
            match receiver.try_recv() {
                Ok(Ok(())) => {
                    self.worker_ready = true;
                    self.status = tr(
                        language,
                        "IMS-Toucan IPA 음성 엔진이 준비되었습니다.",
                        "The IMS-Toucan IPA speech engine is ready.",
                    )
                    .to_owned();
                }
                Ok(Err(error)) => {
                    self.last_error = Some(error.clone());
                    self.status = error;
                }
                Err(TryRecvError::Empty) => self.warmup = Some(receiver),
                Err(TryRecvError::Disconnected) => {
                    self.status = tr(
                        language,
                        "IMS-Toucan 준비 작업이 중단되었습니다.",
                        "IMS-Toucan warm-up stopped unexpectedly.",
                    )
                    .to_owned();
                }
            }
        }
        if let Some(pending) = self.pending.take() {
            match pending.receiver.try_recv() {
                Ok(Ok(path)) if valid_wav(&path) => {
                    if let Err(error) = play_wav(&path) {
                        self.last_error = Some(error.clone());
                        self.status = error;
                        self.playing_key = None;
                    } else {
                        self.cache.insert(
                            pending.key.clone(),
                            CachedSpeech {
                                path,
                                duration: pending.duration,
                            },
                        );
                        self.playing_key = Some(pending.key);
                        self.playing_until = Some(Instant::now() + pending.duration);
                        self.status = tr(
                            language,
                            "발음을 재생하고 있습니다.",
                            "Playing pronunciation.",
                        )
                        .to_owned();
                    }
                }
                Ok(Ok(path)) => {
                    let _ = fs::remove_file(path);
                    self.status = tr(
                        language,
                        "생성된 음성 캐시가 올바르지 않습니다.",
                        "The generated speech cache is invalid.",
                    )
                    .to_owned();
                }
                Ok(Err(error)) => {
                    self.last_error = Some(error.clone());
                    self.status = error;
                    self.playing_key = None;
                }
                Err(TryRecvError::Empty) => self.pending = Some(pending),
                Err(TryRecvError::Disconnected) => {
                    self.status = tr(
                        language,
                        "음성 생성 작업이 예기치 않게 중단되었습니다.",
                        "The speech task stopped unexpectedly.",
                    )
                    .to_owned();
                    self.playing_key = None;
                }
            }
        }
        if self.pending.is_none() {
            self.dispatch_next(language);
        }
    }

    pub fn request(
        &mut self,
        language: Language,
        ipa_text: &str,
        profile: &DictionaryVoiceProfile,
    ) -> SpeechRequest {
        self.ensure_initialized(language);
        self.poll(language);
        if ipa_text.trim().is_empty() {
            return SpeechRequest::Disabled;
        }
        let unsupported = ipa::unsupported_symbols(ipa_text);
        if !unsupported.is_empty() {
            self.status = format!(
                "{} {}",
                tr(
                    language,
                    "현재 IPA 입력 체계에서 지원하지 않는 기호입니다:",
                    "These symbols are not supported by the current IPA input system:",
                ),
                unsupported.join(" ")
            );
            return SpeechRequest::Unsupported(unsupported);
        }
        let Some(manifest) = self.manifest.clone() else {
            self.status = tr(
                language,
                "IMS-Toucan 음성 모델이 설치되지 않았습니다.",
                "The IMS-Toucan speech model is not installed.",
            )
            .to_owned();
            return SpeechRequest::ModelUnavailable;
        };
        if self.speech_root.is_none() {
            return SpeechRequest::ModelUnavailable;
        }
        if !manifest
            .voices
            .iter()
            .any(|voice| voice.id == profile.voice_id)
        {
            self.status = tr(
                language,
                "선택한 IMS-Toucan 음성 모델을 사용할 수 없습니다.",
                "The selected IMS-Toucan voice is unavailable.",
            )
            .to_owned();
            return SpeechRequest::ModelUnavailable;
        }

        let key = cache_key(ipa_text, profile);
        if self.playing_key.as_ref() == Some(&key) {
            self.cancel_pending();
            stop_wav();
            self.playing_key = None;
            self.playing_until = None;
            self.status = tr(language, "발음을 중지했습니다.", "Pronunciation stopped.").to_owned();
            return SpeechRequest::Stopped;
        }
        let duration = estimated_duration(ipa_text, profile.speed);
        if let Some(cached) = self.cache.get(&key) {
            if play_wav(&cached.path).is_ok() {
                self.playing_key = Some(key.clone());
                self.playing_until = Some(Instant::now() + cached.duration);
                self.status = tr(
                    language,
                    "발음을 재생하고 있습니다.",
                    "Playing pronunciation.",
                )
                .to_owned();
                return SpeechRequest::Queued(key);
            }
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.key == key)
            || self.queued.iter().any(|queued| queued.key == key)
        {
            self.status = tr(
                language,
                "이전 발음을 생성하고 있습니다.",
                "A pronunciation is already being generated.",
            )
            .to_owned();
            return SpeechRequest::Queued(key);
        }

        let output = match speech_cache_path(&key) {
            Ok(path) => path,
            Err(error) => {
                self.last_error = Some(error.clone());
                self.status = error;
                return SpeechRequest::ModelUnavailable;
            }
        };
        if valid_wav(&output) {
            if play_wav(&output).is_ok() {
                self.cache.insert(
                    key.clone(),
                    CachedSpeech {
                        path: output,
                        duration,
                    },
                );
                self.playing_key = Some(key.clone());
                self.playing_until = Some(Instant::now() + duration);
                self.status = tr(
                    language,
                    "諛쒖쓬???ъ깮?섍퀬 ?덉뒿?덈떎.",
                    "Playing pronunciation.",
                )
                .to_owned();
                return SpeechRequest::Queued(key);
            }
        } else if output.exists() {
            let _ = fs::remove_file(&output);
        }
        let ipa = ipa::normalize(ipa_text);
        self.queued.push_back(QueuedSpeech {
            key: key.clone(),
            ipa,
            output,
            profile: profile.clone(),
            duration,
        });
        self.playing_key = Some(key.clone());
        self.status = tr(
            language,
            "IMS-Toucan에서 IPA 발음을 생성하고 있습니다.",
            "IMS-Toucan is generating the IPA pronunciation.",
        )
        .to_owned();
        self.dispatch_next(language);
        SpeechRequest::Queued(key)
    }

    pub fn is_playing(&self, ipa_text: &str, profile: &DictionaryVoiceProfile) -> bool {
        self.playing_key.as_deref() == Some(cache_key(ipa_text, profile).as_str())
            && self
                .playing_until
                .is_none_or(|deadline| Instant::now() < deadline)
    }

    pub fn is_generating(&self, ipa_text: &str, profile: &DictionaryVoiceProfile) -> bool {
        let key = cache_key(ipa_text, profile);
        self.pending
            .as_ref()
            .is_some_and(|pending| pending.key == key)
            || self.queued.iter().any(|queued| queued.key == key)
    }

    pub fn export_embedded_assets(&self) -> Result<Vec<EmbeddedSpeechAsset>, String> {
        let mut assets = self
            .cache
            .iter()
            .map(|(key, cached)| {
                let bytes = fs::read(&cached.path).map_err(|error| error.to_string())?;
                Ok(EmbeddedSpeechAsset {
                    cache_key: key.clone(),
                    wav_base64: encode_base64(&bytes),
                    duration_millis: cached.duration.as_millis().min(u64::MAX as u128) as u64,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        assets.sort_by(|left, right| left.cache_key.cmp(&right.cache_key));
        Ok(assets)
    }

    pub fn restore_embedded_assets(
        &mut self,
        assets: &[EmbeddedSpeechAsset],
    ) -> Result<(), String> {
        for asset in assets {
            if asset.cache_key.is_empty() || asset.wav_base64.is_empty() {
                continue;
            }
            let bytes = decode_base64(&asset.wav_base64)?;
            let path = speech_cache_path(&asset.cache_key)?;
            fs::write(&path, bytes).map_err(|error| error.to_string())?;
            if valid_wav(&path) {
                self.cache.insert(
                    asset.cache_key.clone(),
                    CachedSpeech {
                        path,
                        duration: Duration::from_millis(asset.duration_millis.max(1)),
                    },
                );
            }
        }
        Ok(())
    }

    pub fn invalidate_profile(&mut self, profile: &DictionaryVoiceProfile) {
        let suffix = format!(
            "|{}|{:.3}|{:.3}|{:.3}",
            profile.voice_id, profile.speed, profile.pitch, profile.volume
        );
        self.cache.retain(|key, _| !key.ends_with(&suffix));
        self.cancel_pending();
        self.queued.clear();
        self.playing_key = None;
        self.playing_until = None;
        stop_wav();
    }

    fn cancel_pending(&mut self) {
        self.pending = None;
    }

    fn dispatch_next(&mut self, language: Language) {
        if self.pending.is_some() || !self.worker_ready {
            return;
        }
        let Some(queued) = self.queued.pop_front() else {
            return;
        };
        let Some(root) = self.speech_root.clone() else {
            return;
        };
        let Some(manifest) = self.manifest.clone() else {
            return;
        };
        let (sender, receiver) = mpsc::channel();
        let output = queued.output.clone();
        let worker_output = output.clone();
        thread::spawn(move || {
            let result = synthesize_persistent(
                &root,
                &manifest,
                &queued.ipa,
                &worker_output,
                &queued.profile,
            )
            .map(|_| worker_output);
            let _ = sender.send(result);
        });
        self.pending = Some(PendingSpeech {
            key: queued.key,
            receiver,
            duration: queued.duration,
        });
        self.status = tr(
            language,
            "IMS-Toucan?먯꽌 IPA 諛쒖쓬???앹꽦?섍퀬 ?덉뒿?덈떎.",
            "IMS-Toucan is generating the IPA pronunciation.",
        )
        .to_owned();
    }

    pub fn available_voice_ids(&self) -> Vec<String> {
        self.manifest
            .as_ref()
            .map(|manifest| {
                manifest
                    .voices
                    .iter()
                    .map(|voice| voice.id.clone())
                    .collect()
            })
            .unwrap_or_else(|| vec!["ims-toucan-multilingual".to_owned()])
    }

    pub fn engine_summary(&self) -> Option<String> {
        self.manifest.as_ref().map(|manifest| {
            format!(
                "IMS-Toucan · {} · {}",
                manifest.license, manifest.provenance
            )
        })
    }
}

impl Drop for ImsToucanState {
    fn drop(&mut self) {
        self.cancel_pending();
        stop_wav();
    }
}

fn load_manifest() -> Result<(ImsToucanManifest, PathBuf), String> {
    let root = resources::resource_root()?;
    let packaged_root = root.join("Data/Speech/IMS-Toucan");
    let speech_root = if packaged_root.is_dir() {
        packaged_root
    } else {
        root.join("runtime-resources/Data/Speech/IMS-Toucan")
    };
    let manifest_path = speech_root.join("manifest.json");
    let content = fs::read_to_string(&manifest_path).map_err(|error| {
        format!(
            "IMS-Toucan manifest could not be read ({}): {error}",
            manifest_path.display()
        )
    })?;
    let manifest: ImsToucanManifest = serde_json::from_str(&content)
        .map_err(|error| format!("IMS-Toucan manifest is invalid: {error}"))?;
    if manifest.engine != "IMS-Toucan"
        || manifest.license.to_ascii_lowercase() != "apache-2.0"
        || manifest.provenance.trim().is_empty()
    {
        return Err("IMS-Toucan engine, license, or provenance metadata is invalid.".to_owned());
    }
    for relative in manifest.required.iter().chain([
        &manifest.runner.executable,
        &manifest.runner.script,
        &manifest.runner.worker_script,
        &manifest.runner.engine_root,
    ]) {
        let path = safe_resource_path(&speech_root, relative)?;
        if !path.exists() {
            return Err(format!(
                "Required IMS-Toucan resource is missing: {}",
                path.display()
            ));
        }
    }
    for voice in &manifest.voices {
        if voice.id.trim().is_empty() || voice.language.trim().is_empty() {
            return Err("IMS-Toucan voice metadata is invalid.".to_owned());
        }
        for relative in [&voice.model, &voice.vocoder] {
            let path = safe_resource_path(&speech_root, relative)?;
            if !path.is_file() {
                return Err(format!("IMS-Toucan model is missing: {}", path.display()));
            }
        }
    }
    if manifest.voices.is_empty() {
        return Err("No IMS-Toucan voice is installed.".to_owned());
    }
    Ok((manifest, speech_root))
}

impl PersistentImsWorker {
    fn start(
        root: &Path,
        manifest: &ImsToucanManifest,
        profile: &DictionaryVoiceProfile,
    ) -> Result<Self, String> {
        let voice = manifest
            .voices
            .iter()
            .find(|voice| voice.id == profile.voice_id)
            .ok_or_else(|| "Selected IMS-Toucan voice is unavailable.".to_owned())?;
        let executable = safe_resource_path(root, &manifest.runner.executable)?;
        let script = safe_resource_path(root, &manifest.runner.worker_script)?;
        let engine_root = safe_resource_path(root, &manifest.runner.engine_root)?;
        let model = safe_resource_path(root, &voice.model)?;
        let vocoder = safe_resource_path(root, &voice.vocoder)?;
        let mut command = Command::new(executable);
        command
            .current_dir(root)
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .arg(script)
            .arg("--engine-root")
            .arg(engine_root)
            .arg("--language")
            .arg(&voice.language)
            .arg("--model")
            .arg(model)
            .arg("--vocoder")
            .arg(vocoder)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("IMS-Toucan worker could not start: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "IMS-Toucan worker input pipe is unavailable.".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "IMS-Toucan worker output pipe is unavailable.".to_owned())?;
        let mut worker = Self {
            voice_id: voice.id.clone(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
        };
        let ready = worker.read_response()?;
        if ready.message_type != "ready" {
            return Err(format!(
                "IMS-Toucan worker did not become ready: {}",
                ready.message
            ));
        }
        append_speech_metric(&format!(
            "startup voice={} total_ms={:.1}",
            worker.voice_id, ready.startup_ms
        ));
        Ok(worker)
    }

    fn is_alive(&mut self) -> bool {
        self.child.try_wait().is_ok_and(|status| status.is_none())
    }

    fn synthesize(
        &mut self,
        key: &str,
        ipa: &str,
        output: &Path,
        profile: &DictionaryVoiceProfile,
    ) -> Result<(), String> {
        let output_text = output.to_string_lossy().into_owned();
        let request = WorkerRequest {
            message_type: "synthesize",
            id: key,
            ipa,
            output: &output_text,
            speed: profile.speed.clamp(0.5, 2.0),
            pitch: profile.pitch.clamp(0.7, 1.4),
            volume: profile.volume.clamp(0.0, 1.0),
        };
        serde_json::to_writer(&mut self.stdin, &request)
            .map_err(|error| format!("IMS-Toucan request could not be encoded: {error}"))?;
        self.stdin
            .write_all(b"\n")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("IMS-Toucan request could not be sent: {error}"))?;
        loop {
            let response = self.read_response()?;
            if response.id != key && !response.id.is_empty() {
                continue;
            }
            match response.message_type.as_str() {
                "result" => {
                    append_speech_metric(&format!(
                        "synthesis key={} acoustic_ms={:.1} vocoder_ms={:.1} write_ms={:.1}",
                        stable_hash(key),
                        response.acoustic_ms,
                        response.vocoder_ms,
                        response.write_ms
                    ));
                    return valid_wav(output)
                        .then_some(())
                        .ok_or_else(|| "IMS-Toucan generated an invalid WAV file.".to_owned());
                }
                "error" => {
                    return Err(format!("IMS-Toucan synthesis failed: {}", response.message));
                }
                _ => {}
            }
        }
    }

    fn read_response(&mut self) -> Result<WorkerResponse, String> {
        loop {
            let mut line = String::new();
            let read = self
                .stdout
                .read_line(&mut line)
                .map_err(|error| format!("IMS-Toucan worker output failed: {error}"))?;
            if read == 0 {
                return Err("IMS-Toucan worker stopped unexpectedly.".to_owned());
            }
            if let Ok(response) = serde_json::from_str::<WorkerResponse>(line.trim()) {
                return Ok(response);
            }
        }
    }
}

impl Drop for PersistentImsWorker {
    fn drop(&mut self) {
        let _ = self.stdin.write_all(b"{\"type\":\"shutdown\"}\n");
        let _ = self.stdin.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn worker_slot() -> &'static Mutex<Option<PersistentImsWorker>> {
    IMS_WORKER.get_or_init(|| Mutex::new(None))
}

fn ensure_persistent_worker(
    root: &Path,
    manifest: &ImsToucanManifest,
    profile: &DictionaryVoiceProfile,
) -> Result<(), String> {
    let mut slot = worker_slot()
        .lock()
        .map_err(|_| "IMS-Toucan worker lock is unavailable.".to_owned())?;
    let reusable = slot
        .as_mut()
        .is_some_and(|worker| worker.voice_id == profile.voice_id && worker.is_alive());
    if !reusable {
        *slot = Some(PersistentImsWorker::start(root, manifest, profile)?);
    }
    Ok(())
}

fn synthesize_persistent(
    root: &Path,
    manifest: &ImsToucanManifest,
    ipa: &str,
    output: &Path,
    profile: &DictionaryVoiceProfile,
) -> Result<(), String> {
    let key = cache_key(ipa, profile);
    let mut first_error = None;
    for _ in 0..2 {
        ensure_persistent_worker(root, manifest, profile)?;
        let mut slot = worker_slot()
            .lock()
            .map_err(|_| "IMS-Toucan worker lock is unavailable.".to_owned())?;
        let result = slot
            .as_mut()
            .ok_or_else(|| "IMS-Toucan worker is unavailable.".to_owned())?
            .synthesize(&key, ipa, output, profile);
        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                first_error.get_or_insert(error);
                *slot = None;
            }
        }
    }
    Err(first_error.unwrap_or_else(|| "IMS-Toucan synthesis failed.".to_owned()))
}

fn safe_resource_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("IMS-Toucan resource path leaves the packaged directory.".to_owned());
    }
    Ok(root.join(path))
}

fn speech_cache_root() -> Result<PathBuf, String> {
    let root = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| "The speech cache directory is unavailable.".to_owned())?
        .join("URDR/SpeechCache/IMS-Toucan");
    fs::create_dir_all(&root)
        .map_err(|error| format!("The speech cache could not be created: {error}"))?;
    Ok(root)
}

fn speech_cache_path(key: &str) -> Result<PathBuf, String> {
    Ok(speech_cache_root()?.join(format!("{}.wav", stable_hash(key))))
}

fn valid_wav(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if metadata.len() <= 44 {
        return false;
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut header = [0_u8; 12];
    file.read_exact(&mut header).is_ok() && &header[0..4] == b"RIFF" && &header[8..12] == b"WAVE"
}

fn cleanup_speech_cache() -> Result<(), String> {
    const LIMIT_BYTES: u64 = 512 * 1024 * 1024;
    let root = speech_cache_root()?;
    let mut entries = fs::read_dir(&root)
        .map_err(|error| format!("The speech cache could not be inspected: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("wav") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((
                metadata.modified().unwrap_or(UNIX_EPOCH),
                metadata.len(),
                path,
            ))
        })
        .collect::<Vec<_>>();
    let mut total = entries.iter().map(|(_, size, _)| *size).sum::<u64>();
    entries.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.2.cmp(&right.2)));
    for (_, size, path) in entries {
        if total <= LIMIT_BYTES {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
    Ok(())
}

fn append_speech_metric(message: &str) {
    let Ok(root) = speech_cache_root() else {
        return;
    };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis());
    if let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("performance.log"))
    {
        let _ = writeln!(log, "{timestamp} {message}");
    }
}

fn stable_hash(value: &str) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in value.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn estimated_duration(text: &str, speed: f32) -> Duration {
    let seconds = (text
        .chars()
        .filter(|character| !character.is_whitespace())
        .count() as f32
        / (7.0 * speed.clamp(0.5, 2.0)))
    .clamp(0.8, 18.0);
    Duration::from_secs_f32(seconds)
}

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    fn decode(value: u8) -> Option<u8> {
        match value {
            b'A'..=b'Z' => Some(value - b'A'),
            b'a'..=b'z' => Some(value - b'a' + 26),
            b'0'..=b'9' => Some(value - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let compact = value
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    if compact.len() % 4 != 0 {
        return Err("embedded speech asset has invalid base64 length".to_owned());
    }
    let mut output = Vec::with_capacity(compact.len() / 4 * 3);
    for block in compact.chunks_exact(4) {
        let first = decode(block[0]).ok_or("embedded speech asset has invalid base64")?;
        let second = decode(block[1]).ok_or("embedded speech asset has invalid base64")?;
        output.push((first << 2) | (second >> 4));
        if block[2] != b'=' {
            let third = decode(block[2]).ok_or("embedded speech asset has invalid base64")?;
            output.push((second << 4) | (third >> 2));
            if block[3] != b'=' {
                let fourth = decode(block[3]).ok_or("embedded speech asset has invalid base64")?;
                output.push((third << 6) | fourth);
            }
        }
    }
    Ok(output)
}

#[cfg(target_os = "windows")]
fn play_wav(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "winmm")]
    unsafe extern "system" {
        fn PlaySoundW(psz_sound: *const u16, module: usize, flags: u32) -> i32;
    }
    const SND_ASYNC: u32 = 0x0001;
    const SND_NODEFAULT: u32 = 0x0002;
    const SND_FILENAME: u32 = 0x0002_0000;
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let played = unsafe { PlaySoundW(wide.as_ptr(), 0, SND_ASYNC | SND_FILENAME | SND_NODEFAULT) };
    (played != 0)
        .then_some(())
        .ok_or_else(|| format!("WAV playback failed: {}", path.display()))
}

#[cfg(not(target_os = "windows"))]
fn play_wav(_path: &Path) -> Result<(), String> {
    Err("No audio playback backend is available on this platform.".to_owned())
}

#[cfg(target_os = "windows")]
fn stop_wav() {
    #[link(name = "winmm")]
    unsafe extern "system" {
        fn PlaySoundW(psz_sound: *const u16, module: usize, flags: u32) -> i32;
    }
    unsafe {
        PlaySoundW(std::ptr::null(), 0, 0);
    }
}

#[cfg(not(target_os = "windows"))]
fn stop_wav() {}

pub fn cache_key(ipa_text: &str, profile: &DictionaryVoiceProfile) -> String {
    format!(
        "ims-toucan-v2|{}|{}|{:.3}|{:.3}|{:.3}",
        ipa::normalize(ipa_text),
        profile.voice_id,
        profile.speed,
        profile.pitch,
        profile.volume
    )
}

fn tr<'a>(language: Language, korean: &'a str, english: &'a str) -> &'a str {
    match language {
        Language::Korean => korean,
        Language::English => english,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_normalizes_ipa_and_tracks_voice_settings() {
        let profile = DictionaryVoiceProfile::default();
        assert_eq!(cache_key("a\u{303}", &profile), cache_key("ã", &profile));
        let mut faster = profile.clone();
        faster.speed = 1.2;
        assert_ne!(cache_key("ã", &profile), cache_key("ã", &faster));
    }

    #[test]
    fn missing_ipa_disables_synthesis() {
        let mut state = ImsToucanState::default();
        state.initialized = true;
        assert_eq!(
            state.request(Language::English, "", &DictionaryVoiceProfile::default()),
            SpeechRequest::Disabled
        );
    }

    #[test]
    fn stable_cache_hash_is_deterministic() {
        assert_eq!(stable_hash("same"), stable_hash("same"));
        assert_ne!(stable_hash("same"), stable_hash("different"));
    }

    #[test]
    fn embedded_speech_base64_round_trips_binary_wav_bytes() {
        let bytes = b"RIFF\0\x01\x02WAVEfmt ";
        assert_eq!(decode_base64(&encode_base64(bytes)).unwrap(), bytes);
    }

    #[test]
    fn bundled_ims_manifest_is_valid_and_resolvable() {
        let bundled_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("runtime-resources/Data/Speech/IMS-Toucan");
        let complete_bundle = bundled_root.join("python/python.exe").is_file()
            && bundled_root.join("Models/ToucanTTS.pt").is_file()
            && bundled_root.join("Models/Vocoder.pt").is_file();
        if !complete_bundle && std::env::var_os("URDR_REQUIRE_SPEECH_BUNDLE").is_none() {
            eprintln!(
                "optional IMS-Toucan runtime is absent; set URDR_REQUIRE_SPEECH_BUNDLE=1 for packaging validation"
            );
            return;
        }
        let (manifest, root) = load_manifest().expect("bundled IMS-Toucan manifest");
        assert_eq!(manifest.engine, "IMS-Toucan");
        assert_eq!(manifest.license, "Apache-2.0");
        assert!(root.join(&manifest.runner.executable).is_file());
        assert!(
            manifest
                .voices
                .iter()
                .any(|voice| voice.id == "ims-toucan-multilingual")
        );
    }

    #[test]
    fn ims_resource_paths_cannot_escape_the_bundle() {
        let root = Path::new("speech-root");
        assert!(safe_resource_path(root, "Models/ToucanTTS.pt").is_ok());
        assert!(safe_resource_path(root, "../outside").is_err());
        assert!(safe_resource_path(root, "C:\\outside").is_err());
    }
}
