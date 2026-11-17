//! Upstream installers overwrite this fork's translation features.
//! This is a build policy, not a user setting that a backup can re-enable.
use crate::storage::Storage;

pub const UPDATES_ENABLED: bool = false;

pub fn ensure_updates_enabled() -> Result<(), String> {
    if UPDATES_ENABLED {
        Ok(())
    } else {
        Err("Software updates are disabled in SayIt Translate".to_string())
    }
}

pub fn clear_legacy_update_state(storage: &Storage) -> rusqlite::Result<()> {
    if !UPDATES_ENABLED {
        storage.set("pendingUpdate", &serde_json::Value::Null)?;
        storage.set("autoCheckUpdate", &serde_json::json!(false))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_updates_are_blocked_and_legacy_pending_state_is_cleared() {
        let storage = Storage::new(std::path::PathBuf::from(":memory:")).unwrap();
        storage.set("autoCheckUpdate", &serde_json::json!(true)).unwrap();
        storage.set("pendingUpdate", &serde_json::json!({"filePath": "old.exe", "version": "0.2.5"})).unwrap();
        storage.set("shortcutTranslate", &serde_json::json!("Delete")).unwrap();

        assert!(ensure_updates_enabled().is_err());
        clear_legacy_update_state(&storage).unwrap();
        assert_eq!(storage.get("autoCheckUpdate", None), serde_json::json!(false));
        assert!(storage.get("pendingUpdate", None).is_null());
        assert_eq!(storage.get("shortcutTranslate", None), serde_json::json!("Delete"));
    }
}
