# RodjerCloud Architecture (v2)

This document provides a technical overview of the new data layer and synchronization architecture introduced in v2, designed to be read by other AI agents or developers continuing the work on this project.

## 1. Storage: SQLite + WAL
The legacy `rodjercloud-folders.json` flat-file storage has been completely replaced by a robust `better-sqlite3` database.
- **Location:** `userData/rodjercloud.sqlite`
- **Schema:** Defined in `electron/main/db.ts`. Contains `folders`, `file_folders`, `upload_jobs`, and `sync_state` tables.
- **Resilience:** The database operates in Write-Ahead Logging (WAL) mode (`journal_mode = WAL`) and `synchronous = NORMAL`. This ensures full ACID compliance and immunity against data corruption during unexpected application crashes or power failures.

## 2. File Uploads: Two-Phase Commit (`upload_jobs`)
To completely eliminate the risk of "orphaned" files (files lost when the app crashes during upload), uploads now follow a Two-Phase Commit pattern:
1. **Intent (Pending):** When the user drops files into the app, an entry is immediately inserted into the `upload_jobs` SQLite table with a `pending` status.
2. **Execution:** The file is uploaded to Telegram via `telegramService.uploadFile`.
3. **Completion:** Upon successful upload, the job status is updated to `completed` and the messageId is recorded. If an error occurs, it is marked as `error`.

**Crash Recovery:** On application boot (`app.whenReady` in `electron/main/index.ts`), the system queries all incomplete `upload_jobs` from SQLite and automatically pushes them back into the `uploadQueue`. The user does not need to restart the upload manually.

## 3. Cloud Synchronization: Event Sourcing (`event-sync.ts`)
The legacy method of uploading a gigantic monolithic JSON state object to a Telegram channel has been deprecated to prevent race conditions and merge conflicts across multiple devices.
- **Event Driven:** Every mutation (e.g., creating a folder, moving a file) dispatches a lightweight JSON event payload prefixed with `#event` to the hidden Telegram state channel.
- **Polling / Consumer:** The `EventSyncService` polls the channel for new events. Events are sequentially applied to the local SQLite database.
- **Conflict Resolution:** Because events are purely additive and immutable, multiple devices can independently write events, and they will naturally converge to the identical state when pulling and applying the event stream.

## 4. UI Rendering Notes (`MyFilesPage.tsx`)
- **Virtual Folders:** Specific file extensions are auto-categorized into Virtual Folders (Images, Videos, etc.) managed by the `drillDown` state.
- **Custom Folders:** Managed by the `folderDrill` state. The UI gracefully falls back to empty states ("Здесь пока никого" / Duck animation) when custom folder levels or root lists are empty, ensuring the user always has a clickable area to create new folders via the right-click context menu.
- **Native Modules:** `better-sqlite3` must remain externalized in `electron.vite.config.ts` (`external: ['better-sqlite3']`), and `npmRebuild: true` must be enabled in `electron-builder.json` to ensure the ABI matches the internal Electron Node.js engine during the build process.
