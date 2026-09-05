use std::path::{Path, PathBuf};

use crate::model::Language;

const MANIFEST_RELATIVE_PATH: &str = "Data/manifest.json";

pub fn resource_root() -> Result<PathBuf, String> {
    if let Some(override_root) = std::env::var_os("URDR_RESOURCE_ROOT") {
        let root = PathBuf::from(override_root);
        if root.join(MANIFEST_RELATIVE_PATH).is_file() {
            return validate_root(root);
        }
        if root.join("public/demoProjectData.json.gz").is_file() {
            return Ok(root);
        }
        return Err("URDR_RESOURCE_ROOT does not contain a valid URDR resource set.".to_owned());
    }

    let executable_directory = std::env::current_exe()
        .map_err(|error| format!("The executable path could not be resolved: {error}"))?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "The executable directory could not be resolved.".to_owned())?;
    if executable_directory.join(MANIFEST_RELATIVE_PATH).is_file() {
        return validate_root(executable_directory);
    }

    let running_from_cargo_target = executable_directory
        .ancestors()
        .any(|path| path.file_name().is_some_and(|name| name == "target"));
    if cfg!(debug_assertions) || running_from_cargo_target {
        let repository_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .components()
            .collect::<PathBuf>();
        if repository_root
            .join("public/demoProjectData.json.gz")
            .is_file()
        {
            return Ok(repository_root);
        }
    }

    Err(format!(
        "URDR resources were not found. Extract the entire portable ZIP into one folder before running URDR.exe. {MANIFEST_RELATIVE_PATH} must remain beside the executable."
    ))
}

pub fn read_demo(language: Language) -> Result<Vec<u8>, String> {
    let root = resource_root()?;
    let packaged = root.join("Data/Demos").join(match language {
        Language::Korean => "demoProjectData.json.gz",
        Language::English => "demoProjectData.en.json.gz",
    });
    let development = root.join("public").join(match language {
        Language::Korean => "demoProjectData.json.gz",
        Language::English => "demoProjectData.en.json.gz",
    });
    let path = if packaged.is_file() {
        packaged
    } else {
        development
    };
    std::fs::read(&path).map_err(|error| {
        format!(
            "Demo data is missing or damaged ({}): {error}",
            path.display()
        )
    })
}

pub fn read_native_demo(language: Language) -> Result<Option<Vec<u8>>, String> {
    let root = resource_root()?;
    let filename = match language {
        Language::Korean => "demoNativeWorld.json.gz",
        Language::English => "demoNativeWorld.en.json.gz",
    };
    let packaged = root.join("Data/Demos").join(filename);
    let development = root.join("public").join(filename);
    let path = if packaged.is_file() {
        packaged
    } else if development.is_file() {
        development
    } else {
        return Ok(None);
    };
    std::fs::read(&path)
        .map(Some)
        .map_err(|error| format!("Failed to read native demo {}: {error}", path.display()))
}

fn validate_root(root: PathBuf) -> Result<PathBuf, String> {
    let manifest_path = root.join(MANIFEST_RELATIVE_PATH);
    let manifest = std::fs::read_to_string(&manifest_path).map_err(|error| {
        format!(
            "The resource manifest could not be read ({}): {error}",
            manifest_path.display()
        )
    })?;
    let value: serde_json::Value = serde_json::from_str(&manifest).map_err(|error| {
        format!(
            "The resource manifest is damaged ({}): {error}",
            manifest_path.display()
        )
    })?;
    if value
        .get("formatVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err("This URDR resource format is not supported.".to_owned());
    }
    if let Some(required) = value.get("required").and_then(serde_json::Value::as_array) {
        for relative in required.iter().filter_map(serde_json::Value::as_str) {
            let path = root.join(relative);
            if !path.is_file() {
                return Err(format!(
                    "Required URDR resource is missing: {}. Extract the entire portable ZIP into the same folder.",
                    path.display()
                ));
            }
        }
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_demo_resources_are_resolvable() {
        assert!(!read_demo(Language::Korean).expect("Korean demo").is_empty());
        assert!(
            !read_demo(Language::English)
                .expect("English demo")
                .is_empty()
        );
    }

    #[test]
    fn packaged_manifest_does_not_make_speech_a_startup_requirement() {
        let manifest_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("runtime-resources/Data/manifest.json");
        let value: serde_json::Value = serde_json::from_slice(
            &std::fs::read(manifest_path).expect("packaged resource manifest"),
        )
        .expect("valid resource manifest");
        let required = value["required"].as_array().expect("required resources");
        assert!(
            required
                .iter()
                .filter_map(serde_json::Value::as_str)
                .all(|path| !path.starts_with("Data/Speech/"))
        );
        assert!(
            value["optionalFeatures"]["speech"]
                .as_array()
                .is_some_and(|resources| !resources.is_empty())
        );
    }
}
