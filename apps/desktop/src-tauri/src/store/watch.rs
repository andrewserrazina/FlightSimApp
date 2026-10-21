//! Store side of the GSX receipt watcher (schema v7, S2-06 PR 1): file bookkeeping, the watcher
//! setting, and importing one stable file together with its bookkeeping in a single transaction.

use rusqlite::{params, OptionalExtension};

use super::ledger::{import_one, ImportedOne};
use super::{now_utc_ms, Store, StoreError};
use crate::receipts::scan::ScannedFile;
use crate::receipts::watch::{FileState, FileUpdate, ImportOne, KnownFile, Meta, Ready};

pub const WATCH_ENABLED_KEY: &str = "receipts.watch.enabled";

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptFileOut {
    pub rel_path: String,
    pub size: Option<i64>,
    pub state: String,
    pub detail: Option<String>,
    pub receipt_id: Option<String>,
    pub first_seen_at_utc: String,
    pub updated_at_utc: String,
}

impl Store {
    pub fn receipt_files_load(&self) -> Result<Vec<KnownFile>, StoreError> {
        let mut stmt = self.conn.prepare("SELECT rel_path, size, mtime_ns, state FROM receipt_files ORDER BY rel_path")?;
        let rows = stmt
            .query_map([], |r| {
                let size: Option<i64> = r.get(1)?;
                let mtime: Option<i64> = r.get(2)?;
                let state: String = r.get(3)?;
                Ok(KnownFile {
                    rel: r.get(0)?,
                    meta: size.zip(mtime).map(|(s, m)| Meta { size: s as u64, mtime_ns: m }),
                    state: FileState::parse(&state).unwrap_or(FileState::Failed),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn receipt_files_list(&self, limit: i64) -> Result<Vec<ReceiptFileOut>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT rel_path, size, state, detail, receipt_id, first_seen_at_utc, updated_at_utc FROM receipt_files ORDER BY updated_at_utc DESC, rel_path LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([limit.clamp(1, 2000)], |r| {
                Ok(ReceiptFileOut { rel_path: r.get(0)?, size: r.get(1)?, state: r.get(2)?, detail: r.get(3)?, receipt_id: r.get(4)?, first_seen_at_utc: r.get(5)?, updated_at_utc: r.get(6)? })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Apply watcher bookkeeping updates. Never touches `gsx_receipts` or any expense.
    pub fn receipt_files_apply(&mut self, updates: &[FileUpdate]) -> Result<(), StoreError> {
        let tx = self.conn.transaction()?;
        let now = now_utc_ms();
        for u in updates {
            if matches!(u.state, FileState::Imported | FileState::Duplicate) {
                // Only an import (receipt_watch_import) may set these, with its receipt.
                continue;
            }
            let detail: Option<String> = u.detail.as_ref().map(|d| d.chars().take(300).collect());
            tx.execute(
                "INSERT INTO receipt_files (rel_path, size, mtime_ns, state, detail, first_seen_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) \
                 ON CONFLICT(rel_path) DO UPDATE SET \
                   size = COALESCE(excluded.size, receipt_files.size), mtime_ns = COALESCE(excluded.mtime_ns, receipt_files.mtime_ns), \
                   state = excluded.state, detail = excluded.detail, updated_at_utc = excluded.updated_at_utc, \
                   sha256 = CASE WHEN excluded.state = 'vanished' THEN receipt_files.sha256 ELSE NULL END, \
                   receipt_id = CASE WHEN excluded.state = 'vanished' THEN receipt_files.receipt_id ELSE NULL END",
                params![u.rel, u.meta.map(|m| m.size as i64), u.meta.map(|m| m.mtime_ns), u.state.as_str(), detail, now],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Import one stable file and record it, atomically. Identical content is a duplicate (exact SHA-256).
    pub fn receipt_watch_import(&mut self, ready: &Ready) -> Result<ImportOne, StoreError> {
        let tx = self.conn.transaction()?;
        let file = ScannedFile { group: ready.group.clone(), file_name: ready.file_name.clone(), size: ready.meta.size, modified_at_utc: ready.modified_at_utc.clone(), bytes: ready.bytes.clone() };
        let (receipt_id, duplicate, possible_revision, verified) = match import_one(&tx, &file)? {
            ImportedOne::Duplicate { receipt_id } => (receipt_id, true, false, true),
            ImportedOne::New { receipt_id, possible_revision, verified } => (receipt_id, false, possible_revision, verified),
        };
        let sha: String = tx.query_row("SELECT sha256 FROM gsx_receipts WHERE id = ?1", [&receipt_id], |r| r.get(0))?;
        let state = if duplicate { FileState::Duplicate } else { FileState::Imported };
        let now = now_utc_ms();
        tx.execute(
            "INSERT INTO receipt_files (rel_path, size, mtime_ns, state, detail, sha256, receipt_id, first_seen_at_utc, updated_at_utc) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?7) \
             ON CONFLICT(rel_path) DO UPDATE SET size = excluded.size, mtime_ns = excluded.mtime_ns, state = excluded.state, detail = NULL, \
               sha256 = excluded.sha256, receipt_id = excluded.receipt_id, updated_at_utc = excluded.updated_at_utc",
            params![ready.rel, ready.meta.size as i64, ready.meta.mtime_ns, state.as_str(), sha, receipt_id, now],
        )?;
        tx.commit()?;
        Ok(ImportOne { receipt_id, duplicate, possible_revision, verified })
    }

    pub fn setting_get(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self.conn.query_row("SELECT value FROM app_settings WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn setting_set(&mut self, key: &str, value: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO app_settings (key, value, updated_at_utc) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_utc = excluded.updated_at_utc",
            params![key, value, now_utc_ms()],
        )?;
        Ok(())
    }

    /// The watcher runs unless the user turned it off.
    pub fn watch_enabled(&self) -> Result<bool, StoreError> {
        Ok(self.setting_get(WATCH_ENABLED_KEY)?.as_deref() != Some("false"))
    }
}
