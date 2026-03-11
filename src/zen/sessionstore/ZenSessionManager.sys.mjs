/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { JSONFile } from "resource://gre/modules/JSONFile.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenLiveFoldersManager:
    "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  SessionStartup: "resource:///modules/sessionstore/SessionStartup.sys.mjs",
  gWindowSyncEnabled: "resource:///modules/zen/ZenWindowSync.sys.mjs",
  gSyncOnlyPinnedTabs: "resource:///modules/zen/ZenWindowSync.sys.mjs",
  DeferredTask: "resource://gre/modules/DeferredTask.sys.mjs",
  ContextualIdentityService: "resource://gre/modules/ContextualIdentityService.sys.mjs",
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "gShouldLog",
  "zen.session-store.log",
  true
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "gMaxSessionBackups",
  "zen.session-store.max-backups",
  20
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "gBackupHourSpan",
  "zen.session-store.backup-hour-span",
  3
);

const SHOULD_BACKUP_FILE = Services.prefs.getBoolPref(
  "zen.session-store.backup-file",
  true
);
const FILE_NAME = "zen-sessions.jsonlz4";

const LAST_BUILD_ID_PREF = "zen.session-store.last-build-id";

// 'browser.startup.page' preference value to resume the previous session.
const BROWSER_STARTUP_RESUME_SESSION = 3;

// The amount of time (in milliseconds) to wait for our backup regeneration
// debouncer to kick off a regeneration.
const REGENERATION_DEBOUNCE_RATE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Class representing the sidebar object stored in the session file.
 * This object holds all the data related to tabs, groups, folders
 * and split view state.
 */
class nsZenSidebarObject {
  #sidebar = {};

  get data() {
    return Cu.cloneInto(this.#sidebar, {});
  }

  set data(data) {
    if (typeof data !== "object") {
      throw new Error("Sidebar data must be an object");
    }
    this.#sidebar = data;
  }
}

export class nsZenSessionManager {
  /**
   * The JSON file instance used to read/write session data.
   *
   * @type {JSONFile}
   */
  #file = null;
  /**
   * The sidebar object holding tabs, groups, folders and split view data.
   *
   * @type {nsZenSidebarObject}
   */
  #sidebarObject = new nsZenSidebarObject();
  /**
   * A deferred task to create backups of the session file.
   */
  #deferredBackupTask = null;
  /**
   * Persistent side-table for sync conflict resolution.
   * Stored in zen-sessions.jsonlz4 under the "_syncMeta" key.
   * Shape: { tabs, spaces, folders, containers } keyed by item identifier.
   *
   * @type {{tabs: object, spaces: object, folders: object, containers: object}|null}
   */
  #syncMetaStore = null;
  /**
   * Items pulled from sync that haven't yet been created in the live browser.
   * Applied on top of every saveState() collection so they aren't dropped.
   * Set to null by applySyncData() after the DOM update completes.
   *
   * @type {{spaces: Array, tabs: Array, folders: Array, groups: Array, splitViewData: Array}|null}
   */
  #pendingItems = null;
  /**
   * Set to true while applySyncData() is running so that observer callbacks
   * and saveWorkspace() skip marking sync-applied items as 'new'/'modified'.
   */
  #insideSyncOperation = false;

  init() {
    this.log("Initializing session manager");
    let backupTo = null;
    if (SHOULD_BACKUP_FILE) {
      backupTo = PathUtils.join(this.#backupFolderPath, "recovery.baklz4");
    }
    this.#file = new JSONFile({
      path: this.#storeFilePath,
      compression: "lz4",
      backupTo,
    });
    this.log("Session file path:", this.#file.path);
    this.#deferredBackupTask = new lazy.DeferredTask(async () => {
      await this.#createBackupsIfNeeded();
    }, REGENERATION_DEBOUNCE_RATE_MS);

    // Observe container lifecycle so we can keep syncMeta up to date.
    Services.obs.addObserver(this, "contextual-identity-created");
    Services.obs.addObserver(this, "contextual-identity-updated");
    Services.obs.addObserver(this, "contextual-identity-deleted");
  }

  /**
   * Observer callback for container (contextual identity) lifecycle events.
   * Skipped when inside a sync operation to avoid marking sync-applied
   * containers as 'new'.
   */
  observe(subject, topic) {
    if (this.#insideSyncOperation) {
      return;
    }
    try {
      const identity = subject?.wrappedJSObject;
      if (!identity?.userContextId) {
        return;
      }
      const key = String(identity.userContextId);
      if (topic === "contextual-identity-created") {
        this.#setSyncMeta("containers", key, "new");
      } else if (topic === "contextual-identity-updated") {
        const current = this.#getSyncMeta("containers", key);
        if (current.syncStatus !== "new") {
          this.#setSyncMeta("containers", key, "modified");
        }
      } else if (topic === "contextual-identity-deleted") {
        this.removeFromSyncMeta("containers", key);
      }
    } catch (e) {
      /* ignore errors parsing container identity */
    }
  }

  log(...args) {
    if (lazy.gShouldLog) {
      // eslint-disable-next-line no-console
      console.debug("ZenSessionManager:", ...args);
    }
  }

  get #storeFilePath() {
    return PathUtils.join(PathUtils.profileDir, FILE_NAME);
  }

  get #backupFolderPath() {
    return PathUtils.join(PathUtils.profileDir, "zen-sessions-backup");
  }

  // ---------------------------------------------------------------------------
  // _syncMeta accessors
  // ---------------------------------------------------------------------------

  /**
   * Returns the live syncMeta object, initializing it if absent.
   * Shape: { tabs, spaces, folders, containers } — each keyed by item identifier.
   */
  get #syncMeta() {
    if (!this.#syncMetaStore) {
      this.#syncMetaStore = { tabs: {}, spaces: {}, folders: {}, containers: {} };
    }
    return this.#syncMetaStore;
  }

  /**
   * Returns the syncMeta entry for a given type+key, defaulting to
   * { syncStatus: 'new', modifiedAt: 0 } if absent (correct for first sync).
   */
  #getSyncMeta(type, key) {
    return this.#syncMeta[type]?.[key] ?? { syncStatus: "new", modifiedAt: 0 };
  }

  /**
   * Sets the syncMeta entry for a given type+key.
   */
  #setSyncMeta(type, key, syncStatus, modifiedAt = Date.now()) {
    const meta = this.#syncMeta;
    if (!meta[type]) {
      meta[type] = {};
    }
    meta[type][key] = { syncStatus, modifiedAt };
  }

  // ---------------------------------------------------------------------------
  // Public syncMeta API (called from ZenWorkspaces, ZenWindowSync, ZenFolders)
  // ---------------------------------------------------------------------------

  setSyncMetaNew(type, key) {
    if (this.#insideSyncOperation) return;
    this.#setSyncMeta(type, String(key), "new");
  }

  setSyncMetaModified(type, key) {
    if (this.#insideSyncOperation) return;
    this.#setSyncMeta(type, String(key), "modified");
  }

  /**
   * Removes the syncMeta entry and also clears it from #pendingItems so
   * the overlay doesn't re-add a deliberately deleted item.
   */
  removeFromSyncMeta(type, key) {
    const sKey = String(key);
    const meta = this.#syncMeta;
    if (meta[type]) {
      delete meta[type][sKey];
    }
    // Also purge from pendingItems to prevent overlay re-adding it.
    if (this.#pendingItems) {
      if (type === "spaces") {
        this.#pendingItems.spaces = (this.#pendingItems.spaces || []).filter(
          (s) => s.uuid !== sKey
        );
      } else if (type === "tabs") {
        this.#pendingItems.tabs = (this.#pendingItems.tabs || []).filter(
          (t) => t.zenSyncId !== sKey
        );
      } else if (type === "folders") {
        this.#pendingItems.folders = (this.#pendingItems.folders || []).filter(
          (f) => String(f.id) !== sKey
        );
      }
    }
  }

  /**
   * Marks all known items as 'synced'. Called from ZenWorkspacesEngine._syncFinish()
   * after a successful push so future reconcile correctly identifies deletions.
   */
  markAllItemsSynced() {
    const meta = this.#syncMeta;
    const now = Date.now();
    for (const type of ["tabs", "spaces", "folders", "containers"]) {
      if (!meta[type]) {
        continue;
      }
      for (const key of Object.keys(meta[type])) {
        meta[type][key] = { syncStatus: "synced", modifiedAt: meta[type][key].modifiedAt || now };
      }
    }
    // Ensure all tabs with zenSyncId are tracked in syncMeta
    const sidebar = this.#sidebar;
    if (!meta.tabs) {
      meta.tabs = {};
    }
    for (const tab of sidebar?.tabs || []) {
      if (tab.zenSyncId && !meta.tabs[tab.zenSyncId]) {
        meta.tabs[tab.zenSyncId] = { syncStatus: "synced", modifiedAt: now };
      }
    }
    // Persist
    this.#file.data = { ...sidebar, _syncMeta: meta };
    this.#file.saveSoon();
  }

  /**
   * Returns a snapshot of syncMeta keyed by type, for use in createRecord().
   * Returns plain objects (not live references).
   */
  getSyncMetaSnapshot() {
    return JSON.parse(JSON.stringify(this.#syncMeta));
  }

  // ---------------------------------------------------------------------------
  // Reconcile pure functions
  // ---------------------------------------------------------------------------

  /**
   * Produces per-item sync actions from local state + syncMeta + remote state.
   * Pure function — no side effects.
   *
   * @param {Array}  localItems   — local array (spaces, pinnedTabs, folders, or containers)
   * @param {object} syncMetaMap  — syncMeta[type] keyed by item key (string)
   * @param {Array}  remoteItems  — items from incoming sync payload
   * @param {string} keyField     — 'uuid' | 'zenSyncId' | 'id' | 'userContextId'
   * @param {string} type         — for conflict strategy ('spaces' = keepLocal on modified+absent, others = deleteLocal)
   * @returns {Array<{action:'noop'|'pull'|'deleteLocal', local:object|null, remote:object|null}>}
   */
  static reconcile(localItems, syncMetaMap, remoteItems, keyField, type) {
    const remoteMap = new Map(
      (remoteItems || []).filter((i) => i[keyField] != null).map((i) => [String(i[keyField]), i])
    );
    const actions = [];

    // Process all local items
    for (const local of localItems || []) {
      const key = local[keyField] != null ? String(local[keyField]) : null;
      if (!key) {
        // No key → always keep local (can't reconcile)
        actions.push({ action: "noop", local, remote: null });
        continue;
      }
      const meta = syncMetaMap?.[key] ?? { syncStatus: "new", modifiedAt: 0 };
      const remote = remoteMap.get(key);

      if (!remote) {
        // Not in remote
        if (meta.syncStatus === "new") {
          actions.push({ action: "noop", local, remote: null }); // Local-only, will be pushed
        } else if (meta.syncStatus === "synced") {
          actions.push({ action: "deleteLocal", local, remote: null }); // Deleted elsewhere
        } else {
          // modified + absent from remote
          if (type === "spaces") {
            actions.push({ action: "noop", local, remote: null }); // keepLocal for spaces
          } else {
            actions.push({ action: "deleteLocal", local, remote: null });
          }
        }
      } else {
        // Present in remote
        if ((remote.modifiedAt || 0) > (meta.modifiedAt || 0)) {
          actions.push({ action: "pull", local, remote }); // Remote is newer
        } else {
          actions.push({ action: "noop", local, remote }); // Local is same or newer
        }
        remoteMap.delete(key); // Mark as processed
      }
    }

    // Remote items not present locally → pull them in
    for (const [, remote] of remoteMap) {
      actions.push({ action: "pull", local: null, remote });
    }

    return actions;
  }

  /**
   * Applies reconcile() output to produce new state.
   * @param {Array} actions  Output of reconcile()
   * @returns {{ merged: Array, pulled: Array, deleted: Array }}
   */
  static applyReconcileActions(actions) {
    const merged = [];
    const pulled = [];
    const deleted = [];

    for (const { action, local, remote } of actions) {
      if (action === "noop") {
        merged.push(local);
      } else if (action === "pull") {
        // Merge remote on top of local (if local exists), otherwise just use remote
        const item = local ? { ...local, ...remote } : remote;
        merged.push(item);
        pulled.push(item);
      } else if (action === "deleteLocal") {
        deleted.push(local);
        // Don't add to merged — item is removed
      }
    }

    return { merged, pulled, deleted };
  }

  async #getBackupRecoveryOrder() {
    // Also add the most recent backup file to the recovery order
    let backupFiles = [PathUtils.join(this.#backupFolderPath, "clean.jsonlz4")];
    let prefix = PathUtils.join(this.#backupFolderPath, "zen-sessions-");
    try {
      let files = await IOUtils.getChildren(this.#backupFolderPath);
      files = files
        .filter(file => file.startsWith(prefix))
        .sort()
        .reverse();
      backupFiles.push(files[0]);
    } catch {
      /* ignore errors reading backup folder */
    }
    return backupFiles;
  }

  /**
   * Gets the spaces data from the Places database for migration.
   * This is only called once during the first run after updating
   * to a version that uses the new session manager.
   */
  async #getDataFromDBForMigration() {
    try {
      const { PlacesUtils } = ChromeUtils.importESModule(
        "resource://gre/modules/PlacesUtils.sys.mjs"
      );
      const db = await PlacesUtils.promiseDBConnection();
      let data = {};
      let rows = await db.execute(
        "SELECT * FROM zen_workspaces ORDER BY created_at ASC"
      );
      try {
        data.spaces = rows.map(row => ({
          uuid: row.getResultByName("uuid"),
          name: row.getResultByName("name"),
          icon: row.getResultByName("icon"),
          containerTabId: row.getResultByName("container_id") ?? 0,
          position: row.getResultByName("position"),
          theme: row.getResultByName("theme_type")
            ? {
                type: row.getResultByName("theme_type"),
                gradientColors: JSON.parse(row.getResultByName("theme_colors")),
                opacity: row.getResultByName("theme_opacity"),
                rotation: row.getResultByName("theme_rotation"),
                texture: row.getResultByName("theme_texture"),
              }
            : null,
        }));
      } catch (e) {
        /* ignore errors reading spaces data, as it is not critical and we want to migrate even if we fail to read it */
        console.error(
          "Failed to read spaces data from database during migration",
          e
        );
      }
      try {
        rows = await db.execute("SELECT * FROM zen_pins ORDER BY position ASC");
        data.pins = rows.map(row => ({
          uuid: row.getResultByName("uuid"),
          title: row.getResultByName("title"),
          url: row.getResultByName("url"),
          containerTabId: row.getResultByName("container_id"),
          workspaceUuid: row.getResultByName("workspace_uuid"),
          position: row.getResultByName("position"),
          isEssential: Boolean(row.getResultByName("is_essential")),
          isGroup: Boolean(row.getResultByName("is_group")),
          parentUuid: row.getResultByName("folder_parent_uuid"),
          editedTitle: Boolean(row.getResultByName("edited_title")),
          folderIcon: row.getResultByName("folder_icon"),
          isFolderCollapsed: Boolean(
            row.getResultByName("is_folder_collapsed")
          ),
        }));
      } catch (e) {
        /* ignore errors reading pins data, as it is not critical and we want to migrate even if we fail to read it */
        console.error(
          "Failed to read pins data from database during migration",
          e
        );
      }
      try {
        data.recoveryData = await IOUtils.readJSON(
          PathUtils.join(
            Services.dirsvc.get("ProfD", Ci.nsIFile).path,
            "sessionstore-backups",
            "recovery.jsonlz4"
          ),
          { decompress: true }
        );
        this.log("Recovered recovery data from sessionstore-backups");
      } catch {
        /* ignore errors reading recovery data */
      }
      if (!data.recoveryData) {
        try {
          data.recoveryData = await IOUtils.readJSON(
            PathUtils.join(
              Services.dirsvc.get("ProfD", Ci.nsIFile).path,
              "sessionstore-backups",
              "recovery.jsonlz4"
            ),
            { decompress: true }
          );
          this.log("Recovered recovery data from sessionstore-backups");
        } catch {
          /* ignore errors reading recovery data */
        }
      }
      this._migrationData = data;
    } catch (e) {
      /* ignore errors during migration */
      console.error(e);
    }
  }

  async #readDataFromFile() {
    try {
      await this.#file.load();
      this._dataFromFile = this.#file.data;
      if (!this._dataFromFile?.spaces?.length) {
        // Go to the catch block to try to recover from backup files
        // if the file is empty or has invalid data, as it can happen if the app
        // crashes while writing the session file.
        throw new Error("No data in session file");
      }
    } catch {
      for (const backupFile of await this.#getBackupRecoveryOrder()) {
        try {
          let data = await IOUtils.readJSON(backupFile, { decompress: true });
          this.log(`Recovered data from backup file ${backupFile}`);
          if (!data?.spaces?.length) {
            continue;
          }
          this._dataFromFile = data;
          break;
        } catch (e) {
          /* ignore errors reading backup files */
          console.error(`Failed to read backup file ${backupFile}`, e);
        }
      }
    }
  }

  /**
   * Reads the session file and populates the sidebar object.
   * This should be only called once at startup.
   *
   * @see SessionFileInternal.read
   */
  async readFile() {
    this.init();
    try {
      this.log("Reading Zen session file from disk");
      await this.#readDataFromFile();
    } catch (e) {
      console.error("ZenSessionManager: Failed to read session file", e);
    }
    const rawData = this._dataFromFile || {};
    // Extract _syncMeta from file data and keep separately; don't store it in the sidebar object.
    if (rawData._syncMeta) {
      this.#syncMetaStore = rawData._syncMeta;
    }
    const { _syncMeta: _ignored, ...sidebarData } = rawData;
    this.#sidebar = sidebarData;
    if (!this.#sidebar.spaces?.length && !this._shouldRunMigration) {
      this.log(
        "No spaces data found in session file, running migration",
        this.#sidebar
      );
      // If we have no spaces data, we should run migration
      // to restore them from the database. Note we also do a
      // check if we already planned to run migration for optimization.
      this._shouldRunMigration = true;
      await this.#getDataFromDBForMigration();
    }
    if (
      Services.prefs.getBoolPref("zen.session-store.log-tab-entries", false)
    ) {
      for (const tab of this.#sidebar.tabs || []) {
        this.log("Tab entry in session file:", tab);
      }
    }
    delete this._dataFromFile;
  }

  get #shouldRestoreOnlyPinned() {
    let buildId = Services.appinfo.platformBuildID;
    let lastBuildId = Services.prefs.getStringPref(LAST_BUILD_ID_PREF, "");
    let buildIdChanged = buildId !== lastBuildId;
    if (buildIdChanged) {
      // If the build ID has changed since the last session, it means the user has updated the app,
      // so we should not remove the unpinned tabs as they might want to keep them after the update.
      this.log(
        "Build ID has changed since last session, not restoring only pinned tabs",
        {
          buildId,
          lastBuildId,
        }
      );
      Services.prefs.setStringPref(LAST_BUILD_ID_PREF, buildId);
      return false;
    }
    return (
      Services.prefs.getIntPref("browser.startup.page", 1) !==
        BROWSER_STARTUP_RESUME_SESSION ||
      lazy.PrivateBrowsingUtils.permanentPrivateBrowsing
    );
  }

  get #shouldRestoreFromCrash() {
    return (
      lazy.SessionStartup.previousSessionCrashed &&
      Services.prefs.getBoolPref("browser.sessionstore.resume_from_crash")
    );
  }

  /**
   * Called when the session file is read. Restores the sidebar data
   * into all windows.
   *
   * @param {object} initialState
   *        The initial session state read from the session file.
   */
  onFileRead(initialState) {
    // For the first time after migration, we restore the tabs
    // That where going to be restored by SessionStore. The sidebar
    // object will always be empty after migration because we haven't
    // gotten the opportunity to save the session yet.
    if (this._shouldRunMigration) {
      initialState = this.#runStateMigration(initialState);
    }
    if (!lazy.gWindowSyncEnabled) {
      if (initialState?.windows?.length && this.#shouldRestoreOnlyPinned) {
        this.log("Window sync disabled, restoring only pinned tabs");
        for (let i = 0; i < initialState.windows.length; i++) {
          let winData = initialState.windows[i];
          winData.tabs = (winData.tabs || []).filter(tab => tab.pinned);
        }
      }
      return initialState;
    }
    const allowRestoreUnsynced = Services.prefs.getBoolPref(
      "zen.session-store.restore-unsynced-windows",
      true
    );
    if (initialState?.windows?.length && !allowRestoreUnsynced) {
      initialState.windows = initialState.windows.filter(win => {
        if (win.isZenUnsynced) {
          this.log("Skipping unsynced window during restore");
        }
        return !win.isZenUnsynced;
      });
    }
    // If there are no windows, we create an empty one. By default,
    // firefox would create simply a new empty window, but we want
    // to make sure that the sidebar object is properly initialized.
    // This would happen on first run after having a single private window
    // open when quitting the app, for example.
    let normalWindowsExist = initialState?.windows?.some(
      win =>
        !win.isPrivate &&
        !win.isPopup &&
        !win.isTaskbarTab &&
        !win.isZenUnsynced
    );
    if (!initialState?.windows?.length || !normalWindowsExist) {
      this.log("No windows found in initial state, creating an empty one");
      initialState ||= {};
      initialState.windows ||= [];
      initialState.windows.push({
        tabs: [],
      });
    }
    return initialState;
  }

  /**
   * Called after @onFileRead, when session startup has crash checkpoint information available.
   * Restores the sidebar data into all windows, and runs any crash checkpoint related logic,
   * such as restoring only pinned tabs if the previous session was not crashed and the user
   * preference is set to do so.
   *
   * @param {object} initialState
   *        The initial session state read from the session file, possibly modified by onFileRead.
   */
  onCrashCheckpoints(initialState) {
    if (!lazy.gWindowSyncEnabled) {
      return;
    }
    // When we don't have browser.startup.page set to resume session,
    // we only want to restore the pinned tabs into the new windows.
    if (
      this.#shouldRestoreOnlyPinned &&
      !this.#shouldRestoreFromCrash &&
      this.#sidebar?.tabs
    ) {
      this.log("Restoring only pinned tabs into windows");
      const sidebar = this.#sidebar;
      sidebar.tabs = (sidebar.tabs || []).filter(tab => tab.pinned);
      this.#sidebar = sidebar;
    }
    // Restore all windows with the same sidebar object, this will
    // guarantee that all tabs, groups, folders and split view data
    // are properly synced across all windows.
    if (!this._shouldRunMigration) {
      this.log(
        `Restoring Zen session data into ${initialState.windows?.length || 0} windows`
      );
      for (let i = 0; i < initialState.windows.length; i++) {
        let winData = initialState.windows[i];
        if (
          winData.isZenUnsynced ||
          winData.isPrivate ||
          winData.isPopup ||
          winData.isTaskbarTab
        ) {
          continue;
        }
        this.#restoreWindowData(winData);
      }
    } else if (initialState) {
      this.log("Saving windata state after migration");
      this.saveState(Cu.cloneInto(initialState, {}), true);
    }
    delete this._shouldRunMigration;
  }

  get #sidebar() {
    return this.#sidebarObject.data;
  }

  set #sidebar(data) {
    this.#sidebarObject.data = data;
  }

  /**
   * Runs the state migration to restore spaces and pinned tabs
   * from the Places database into the initial session state.
   *
   * @param {object} initialState
   *        The initial session state read from the session file.
   */
  // eslint-disable-next-line complexity
  #runStateMigration(initialState) {
    this.log(
      "Restoring tabs from Places DB after migration",
      initialState,
      initialState?.lastSessionState,
      this._migrationData
    );
    if (!initialState?.windows?.length && this._migrationData?.recoveryData) {
      this.log("Using recovery data for migration");
      initialState = this._migrationData.recoveryData;
    }
    delete this._migrationData?.recoveryData;
    // Restore spaces into the sidebar object if we don't
    // have any yet.
    if (!this.#sidebar.spaces?.length) {
      this.#sidebar = {
        ...this.#sidebar,
        spaces: this._migrationData?.spaces || [],
      };
    }
    if (
      !initialState?.windows?.length &&
      (initialState?.lastSessionState || initialState?.deferredInitialState)
    ) {
      initialState = {
        ...(initialState.lastSessionState || initialState.deferredInitialState),
      };
    }
    // There might be cases where there are no windows in the
    // initial state, for example if the user had 'restore previous
    // session' disabled before migration. In that case, we try
    // to restore the last closed normal window.
    if (!initialState?.windows?.length) {
      let normalClosedWindow = initialState?._closedWindows?.find(
        win => !win.isPopup && !win.isTaskbarTab && !win.isPrivate
      );
      if (normalClosedWindow) {
        initialState.windows = [Cu.cloneInto(normalClosedWindow, {})];
        this.log("Restoring tabs from last closed normal window");
      }
    }
    if (!initialState?.windows?.length) {
      initialState ||= {};
      initialState.windows = [
        {
          tabs: [],
        },
      ];
    }
    for (const winData of initialState?.windows || []) {
      winData.spaces =
        (winData.spaces?.length
          ? winData.spaces
          : this._migrationData?.spaces) || [];
      if (winData.tabs) {
        for (const tabData of winData.tabs) {
          let storeId = tabData.zenSyncId || tabData.zenPinnedId;
          const pinData = this._migrationData?.pins?.find(
            pin => pin.uuid === storeId
          );
          // We need to migrate the static label from the pin data as this information
          // was not stored in the session file before.
          if (pinData) {
            tabData.zenStaticLabel = pinData.editedTitle
              ? pinData.title
              : undefined;
          }
        }
      }
    }
    return initialState;
  }

  onRestoringClosedWindow(aWinData) {
    // We only want to save all pinned tabs if the user preference allows it.
    // See https://github.com/zen-browser/desktop/issues/12307
    if (this.#shouldRestoreOnlyPinned && aWinData?.tabs?.length) {
      this.log("Restoring only pinned tabs for closed window");
      this.#filterUnpinnedTabs(aWinData);
    }
  }

  /**
   * Filters out all unpinned tabs and groups from the given window data object.
   *
   * @param {object} aWindow - The window data object to filter.
   */
  #filterUnpinnedTabs(aWindow) {
    aWindow.tabs = aWindow.tabs.filter(tab => tab.pinned);
    aWindow.groups = aWindow.groups?.filter(group => group.pinned);
  }

  /**
   * Determines if a given window data object is saveable.
   *
   * @param {object} aWinData - The window data object to check.
   * @returns {boolean} True if the window is saveable, false otherwise.
   */
  #isWindowSaveable(aWinData) {
    return (
      !aWinData.isPopup && !aWinData.isTaskbarTab && !aWinData.isZenUnsynced
    );
  }

  /**
   * Saves the current session state. Collects data and writes to disk.
   *
   * @param {object} state The current session state.
   * @param {boolean} soon Whether to save the file soon or immediately.
   *        If true, the file will be saved asynchronously or when quitting
   *        the app. If false, the file will be saved immediately.
   */
  saveState(state, soon = false) {
    let windows = state?.windows || [];
    windows = windows.filter(win => this.#isWindowSaveable(win));
    if (!windows.length) {
      // Don't save (or even collect) anything in permanent private
      // browsing mode. We also don't want to save if there are no windows.
      return;
    }
    const cleanPath = PathUtils.join(this.#backupFolderPath, "clean.jsonlz4");
    IOUtils.copy(this.#storeFilePath, cleanPath, { recursive: true }).catch(
      () => {
        /* ignore errors creating clean backup, as it is not critical and
         * we want to save the session even if we fail to create it */
      }
    );
    this.#collectWindowData(windows);
    // Detect relevant workspace changes and notify the sync engine.
    const _relevantHash = JSON.stringify({
      s: this.#sidebar.spaces,
      t: (this.#sidebar.tabs || []).filter((t) => t.pinned),
      f: this.#sidebar.folders,
    });
    if (_relevantHash !== this._lastZenWorkspaceHash) {
      this._lastZenWorkspaceHash = _relevantHash;
      Services.obs.notifyObservers(null, "zen-workspace-state-changed");
    }
    // This would save the data to disk asynchronously or when quitting the app.
    // Include _syncMeta in the file data so it persists across restarts.
    let sidebar = this.#sidebar;
    this.#file.data = this.#syncMetaStore
      ? { ...sidebar, _syncMeta: this.#syncMetaStore }
      : sidebar;
    if (soon) {
      this.#file.saveSoon();
    } else {
      this.#file._save();
    }
    lazy.ZenLiveFoldersManager.saveState(soon);
    this.#debounceRegeneration();
    this.log(`Saving Zen session data with ${sidebar.tabs?.length || 0} tabs`);
  }

  /**
   * Called when the last known backup should be deleted and a new one
   * created. This uses the #deferredBackupTask to debounce clusters of
   * events that might cause such a regeneration to occur.
   */
  #debounceRegeneration() {
    this.#deferredBackupTask.arm();
  }

  /**
   * Creates backups of the session file if needed. We only keep
   * a limited number of backups to avoid using too much disk space.
   * The way we are doing this is by replacing the file for today's
   * date if it already exists, otherwise we create a new one.
   * We then delete the oldest backups if we exceed the maximum
   * number of backups allowed.
   *
   * We run the next backup creation after a delay or when idling,
   * to avoid blocking the main thread during session saves.
   */
  async #createBackupsIfNeeded() {
    if (!SHOULD_BACKUP_FILE) {
      return;
    }
    try {
      const today = new Date();
      const backupFolder = this.#backupFolderPath;
      await IOUtils.makeDirectory(backupFolder, {
        ignoreExisting: true,
        createAncestors: true,
      });
      // Since backups from days ago are not that useful compared to more
      // recent ones, we would ideally want to keep more backups for recent days
      // and less for older ones. To achieve this, we create backups only
      // every few hours (configurable via gBackupHourSpan), so that we
      // can have multiple backups per day for recent days, but only
      // one backup per day for older days.
      let dateToUse = today.toISOString().slice(0, 10); // YYYY-MM-DD
      const hourSpan = Math.min(Math.max(1, lazy.gBackupHourSpan), 24);
      const backupHour = Math.floor(today.getHours() / hourSpan) * hourSpan;
      dateToUse += `-${String(backupHour).padStart(2, "0")}`;
      const todayFileName = `zen-sessions-${dateToUse}.jsonlz4`;
      const todayFilePath = PathUtils.join(backupFolder, todayFileName);
      const sessionFilePath = this.#file.path;
      this.log(`Backing up session file to ${todayFileName}`);
      await IOUtils.copy(sessionFilePath, todayFilePath, {
        noOverwrite: false,
      });
      // Now we need to check if we have exceeded the maximum
      // number of backups allowed, and delete the oldest ones
      // if needed.
      let prefix = PathUtils.join(backupFolder, "zen-sessions-");
      let files = await IOUtils.getChildren(backupFolder);
      files = files.filter(file => file.startsWith(prefix)).sort();
      for (let i = 0; i < files.length - lazy.gMaxSessionBackups; i++) {
        this.log(`Deleting old backup file ${files[i]}`);
        await IOUtils.remove(files[i]);
      }
    } catch (e) {
      console.error(
        "ZenSessionManager: Failed to create session file backups",
        e
      );
    }
  }

  /**
   * Saves the session data for a closed window if it meets the criteria.
   * See SessionStoreInternal.maybeSaveClosedWindow for more details.
   *
   * @param {object} aWinData - The window data object to save.
   * @param {boolean} isLastWindow - Whether this is the last saveable window.
   */
  maybeSaveClosedWindow(aWinData, isLastWindow) {
    // We only want to save the *last* normal window that is closed.
    // If its not the last window, we can still update the sidebar object
    // based on other open windows.
    if (
      aWinData.isPopup ||
      aWinData.isTaskbarTab ||
      aWinData.isZenUnsynced ||
      !isLastWindow
    ) {
      return;
    }
    this.log("Saving closed window session data into Zen session store");
    this.saveState({ windows: [aWinData] }, true);
  }

  /**
   * Collects session data for a given window.
   *
   * @param {object} aStateWindows The array of window state objects.
   */
  #collectWindowData(aStateWindows) {
    // We only want to collect the sidebar data once from
    // a single window, as all windows share the same
    // sidebar data.
    let sidebarData = this.#sidebar;
    if (!sidebarData) {
      sidebarData = {};
    }

    sidebarData.lastCollected = Date.now();
    this.#collectTabsData(sidebarData, aStateWindows);

    // Re-apply pending items so that items not yet created in the live
    // browser (e.g. a workspace received from sync that hasn't been rendered
    // yet) survive this saveState() cycle and aren't silently dropped.
    // The overlay keeps merging until applySyncData() sets
    // this.#pendingItems = null after the DOM update completes.
    if (this.#pendingItems) {
      if (this.#pendingItems.spaces?.length) {
        sidebarData.spaces = this.#mergeByKey(
          sidebarData.spaces || [],
          this.#pendingItems.spaces,
          "uuid"
        );
      }
      if (this.#pendingItems.tabs?.length) {
        sidebarData.tabs = this.#mergeTabs(sidebarData.tabs || [], this.#pendingItems.tabs);
      }
      if (this.#pendingItems.splitViewData?.length) {
        sidebarData.splitViewData = this.#pendingItems.splitViewData;
      }
      if (this.#pendingItems.folders?.length) {
        sidebarData.folders = this.#mergeByKey(
          sidebarData.folders || [],
          this.#pendingItems.folders,
          "id"
        );
      }
      if (this.#pendingItems.groups?.length) {
        sidebarData.groups = this.#mergeByKey(
          sidebarData.groups || [],
          this.#pendingItems.groups,
          "id"
        );
      }
    }

    this.#sidebar = sidebarData;
  }

  /**
   * Filters out tabs that are not useful to restore, such as empty tabs with no group association.
   * If removeUnpinnedTabs is true, it also filters out unpinned tabs.
   *
   * @param {Array} tabs - The array of tab data objects to filter.
   * @returns {Array} The filtered array of tab data objects.
   */
  #filterUnusedTabs(tabs) {
    return tabs.filter(tab => {
      // We need to ignore empty tabs with no group association
      // as they are not useful to restore.
      return !(tab.zenIsEmpty && !tab.groupId);
    });
  }

  /**
   * Collects session data for all tabs in a given window.
   *
   * @param {object} sidebarData The sidebar data object to populate.
   * @param {object} aStateWindows The array of window state objects.
   */
  #collectTabsData(sidebarData, aStateWindows) {
    const tabIdRelationMap = new Map();
    for (const window of aStateWindows) {
      // Only accept the tabs with `_zenIsActiveTab` set to true from
      // every window. We do this to avoid collecting tabs with invalid
      // state when multiple windows are open. Note that if we a tab without
      // this flag set in any other window, we just add it anyway.
      for (const tabData of window.tabs || []) {
        if (
          !tabIdRelationMap.has(tabData.zenSyncId) ||
          tabData._zenIsActiveTab
        ) {
          tabIdRelationMap.set(tabData.zenSyncId, tabData);
        }
      }
    }

    sidebarData.tabs = this.#filterUnusedTabs(
      Array.from(tabIdRelationMap.values())
    );

    let firstWindow = aStateWindows[0];
    sidebarData.folders = firstWindow.folders;
    sidebarData.splitViewData = firstWindow.splitViewData;
    sidebarData.groups = firstWindow.groups;
    sidebarData.spaces = firstWindow.spaces;
  }

  /**
   * Restores the sidebar data into a given window data object.
   * We do this in order to make sure all new window objects
   * have the same sidebar data.
   *
   * @param {object} aWindowData The window data object to restore into.
   */
  #restoreWindowData(aWindowData) {
    const sidebar = this.#sidebar;
    if (!sidebar) {
      return;
    }
    // If we should only sync the pinned tabs, we should only edit the unpinned
    // tabs in the window data and keep the pinned tabs from the window data,
    // as they should be the same as the ones in the sidebar.
    if (lazy.gSyncOnlyPinnedTabs) {
      let pinnedTabs = (sidebar.tabs || []).filter(tab => tab.pinned);
      let unpinedWindowTabs = [];
      if (!this.#shouldRestoreOnlyPinned) {
        unpinedWindowTabs = (aWindowData.tabs || []).filter(tab => !tab.pinned);
      }
      aWindowData.tabs = [...pinnedTabs, ...unpinedWindowTabs];

      // We restore ALL the split view data in the sidebar, if the group doesn't exist in the window,
      // it should be a no-op anyways.
      aWindowData.splitViewData = [
        ...(sidebar.splitViewData || []),
        ...(aWindowData.splitViewData || []),
      ];
      // Same thing with groups, we restore all the groups from the sidebar, if they don't have any
      // existing tabs in the window, they should be a no-op.
      aWindowData.groups = [
        ...(sidebar.groups || []),
        ...(aWindowData.groups || []),
      ];
    } else {
      aWindowData.tabs = sidebar.tabs || [];
      aWindowData.splitViewData = sidebar.splitViewData;
      aWindowData.groups = sidebar.groups;
    }

    // Folders are always pinned, so we dont need to check for the pinned state here.
    aWindowData.folders = sidebar.folders;
    aWindowData.spaces = sidebar.spaces;
    this.log("Restored sidebar data into window", {
      tabs: aWindowData.tabs?.length || 0,
      groups: aWindowData.groups?.length || 0,
      folders: aWindowData.folders?.length || 0,
      spaces: aWindowData.spaces?.length || 0,
    });
  }

  /**
   * Restores a new window with Zen session data. This should be called
   * not at startup, but when a new window is opened by the user.
   *
   * @param {Window} aWindow
   *        The window to restore.
   * @param {object} SessionStoreInternal
   *        The SessionStore module instance.
   * @param {boolean} fromClosedWindow
   *        Whether this new window is being restored from a closed window.
   */
  restoreNewWindow(aWindow, SessionStoreInternal, fromClosedWindow = false) {
    if (aWindow.gZenWorkspaces?.privateWindowOrDisabled) {
      return;
    }
    this.log("Restoring new window with Zen session data");
    const state = lazy.SessionStore.getCurrentState(true);
    const windows = (state.windows || []).filter(
      win =>
        !win.isPrivate &&
        !win.isPopup &&
        !win.isTaskbarTab &&
        !win.isZenUnsynced
    );
    let windowToClone = windows[0] || {};
    let newWindow = Cu.cloneInto(windowToClone, {});
    let shouldRestoreOnlyPinned =
      !lazy.gWindowSyncEnabled || lazy.gSyncOnlyPinnedTabs;
    if (windows.length < 2) {
      // We only want to restore the sidebar object if we found
      // only one normal window to clone from (which is the one
      // we are opening).
      this.log("Restoring sidebar data into new window");
      this.#restoreWindowData(newWindow);
      shouldRestoreOnlyPinned ||= this.#shouldRestoreOnlyPinned;
    }
    newWindow.tabs = this.#filterUnusedTabs(newWindow.tabs || []);
    if (shouldRestoreOnlyPinned) {
      // Don't bring over any unpinned tabs if window sync is disabled or if syncing only pinned tabs.
      this.#filterUnpinnedTabs(newWindow);
    }

    // These are window-specific from the previous window state that
    // we don't want to restore into the new window. Otherwise, new
    // windows would appear overlapping the previous one, or with
    // the same size and position, which should be decided by the
    // window manager.
    if (!fromClosedWindow) {
      delete newWindow.selected;
      delete newWindow.screenX;
      delete newWindow.screenY;
      delete newWindow.width;
      delete newWindow.height;
      delete newWindow.sizemode;
      delete newWindow.sizemodeBeforeMinimized;
      delete newWindow.zIndex;
      delete newWindow.workspaceID;
    }

    const newState = { windows: [newWindow] };
    this.log(`Cloning window with ${newWindow.tabs.length} tabs`);

    SessionStoreInternal._deferredInitialState = newState;
    SessionStoreInternal.initializeWindow(aWindow, newState);
  }

  /**
   * Called when a new empty session is created. For example,
   * when creating a new profile or when the user installed it for
   * the first time.
   *
   * @param {Window} aWindow
   */
  onNewEmptySession(aWindow) {
    this.log("Restoring empty session with Zen session data");
    aWindow.gZenWorkspaces.restoreWorkspacesFromSessionStore({
      spaces: this.#sidebar.spaces || [],
    });
  }

  /**
   * Gets the cloned spaces data from the sidebar object.
   * This is used during migration to restore spaces into
   * the initial session state.
   *
   * @returns {Array} The cloned spaces data.
   */
  getClonedSpaces() {
    const sidebar = this.#sidebar;
    if (!sidebar || !sidebar.spaces) {
      return [];
    }
    return Cu.cloneInto(sidebar.spaces, {});
  }

  /**
   * Returns a deep clone of the full sidebar object (spaces, tabs, folders, etc.).
   * Used by the ZenWorkspacesSync engine to build the sync payload.
   * Does NOT include _syncMeta (never sent outbound).
   *
   * @returns {object} A deep clone of the sidebar data.
   */
  getSidebarData() {
    const sidebar = this.#sidebar;
    if (!sidebar) {
      return {};
    }
    return JSON.parse(JSON.stringify(sidebar));
  }

  /**
   * Applies incoming sync data using conflict-resolution via syncMeta.
   * Reconciles each item type, updates local state, persists to disk,
   * and notifies all windows of the changes.
   *
   * @param {{ spaces: Array, tabs: Array, folders: Array, groups: Array, splitViewData: Array, containers: Array }} data
   */
  async applySyncData(data) {
    this.#insideSyncOperation = true;
    try {
      if (!data) {
        return;
      }

      let sidebar = { ...this.#sidebar };
      const syncMeta = this.#syncMeta;

      // 1. Reconcile containers first (so IDs exist before tabs reference them)
      const localContainers = lazy.ContextualIdentityService.getPublicIdentities().map((c) => ({
        userContextId: c.userContextId,
        name: c.name,
        icon: c.icon,
        color: c.color,
      }));
      const containerActions = nsZenSessionManager.reconcile(
        localContainers,
        syncMeta.containers || {},
        data.containers || [],
        "userContextId",
        "containers"
      );
      const containerResult = nsZenSessionManager.applyReconcileActions(containerActions);

      for (const container of containerResult.pulled) {
        if (!container.name) {
          continue;
        }
        const existsLocally = localContainers.some(
          (c) => String(c.userContextId) === String(container.userContextId)
        );
        if (existsLocally) {
          lazy.ContextualIdentityService.update(
            container.userContextId,
            container.name,
            container.icon,
            container.color
          );
        } else {
          lazy.ContextualIdentityService.create(
            container.name,
            container.icon,
            container.color,
            container.userContextId
          );
        }
        this.#setSyncMeta(
          "containers",
          String(container.userContextId),
          "synced",
          container.modifiedAt || 0
        );
      }
      for (const container of containerResult.deleted) {
        try {
          lazy.ContextualIdentityService.remove(container.userContextId);
        } catch (e) {
          /* ignore if container doesn't exist */
        }
      }

      // 2. Reconcile spaces
      const spaceActions = nsZenSessionManager.reconcile(
        sidebar.spaces || [],
        syncMeta.spaces || {},
        data.spaces || [],
        "uuid",
        "spaces"
      );
      const spaceResult = nsZenSessionManager.applyReconcileActions(spaceActions);
      sidebar.spaces = spaceResult.merged;
      for (const space of spaceResult.pulled) {
        this.#setSyncMeta("spaces", space.uuid, "synced", space.modifiedAt || 0);
      }

      // 3. Reconcile ALL tabs with zenSyncId
      const localTracked = (sidebar.tabs || []).filter((t) => t.zenSyncId);
      const localNoId = (sidebar.tabs || []).filter((t) => !t.zenSyncId);
      const tabActions = nsZenSessionManager.reconcile(
        localTracked,
        syncMeta.tabs || {},
        data.tabs || [],
        "zenSyncId",
        "tabs"
      );
      const tabResult = nsZenSessionManager.applyReconcileActions(tabActions);
      sidebar.tabs = [...localNoId, ...tabResult.merged];
      for (const tab of tabResult.pulled) {
        this.#setSyncMeta("tabs", tab.zenSyncId, "synced", tab.modifiedAt || 0);
      }

      // 4. Reconcile folders
      const folderActions = nsZenSessionManager.reconcile(
        sidebar.folders || [],
        syncMeta.folders || {},
        data.folders || [],
        "id",
        "folders"
      );
      const folderResult = nsZenSessionManager.applyReconcileActions(folderActions);
      sidebar.folders = folderResult.merged;
      for (const folder of folderResult.pulled) {
        this.#setSyncMeta("folders", String(folder.id), "synced", folder.modifiedAt || 0);
      }

      // 5. Groups — simple merge, no conflict tracking
      if (data.groups?.length) {
        sidebar.groups = this.#mergeByKey(sidebar.groups || [], data.groups, "id");
      }

      // 5b. splitViewData — simple replacement (items lack a stable key)
      if (data.splitViewData?.length) {
        sidebar.splitViewData = data.splitViewData;
      }

      // 6. Persist (include _syncMeta in file data)
      this.#sidebar = sidebar;
      this.#file.data = { ...sidebar, _syncMeta: syncMeta };
      this.#file.saveSoon();

      // 7. Build pending items from pulled results (items not yet in live browser)
      const pending = {
        spaces: spaceResult.pulled,
        tabs: tabResult.pulled,
        folders: folderResult.pulled,
        groups: data.groups || [],
        splitViewData: data.splitViewData || [],
      };
      const hasPending = Object.values(pending).some((a) => a.length > 0);
      if (hasPending) {
        this.#pendingItems = this.#pendingItems
          ? {
              spaces: this.#mergeByKey(this.#pendingItems.spaces || [], pending.spaces, "uuid"),
              tabs: this.#mergeTabs(this.#pendingItems.tabs || [], pending.tabs),
              folders: this.#mergeByKey(this.#pendingItems.folders || [], pending.folders, "id"),
              groups: this.#mergeByKey(this.#pendingItems.groups || [], pending.groups, "id"),
              splitViewData: pending.splitViewData,
            }
          : pending;
      }

      // 8. Build pulled and removals from reconcile results
      const pulled = {
        spaces: spaceResult.pulled,
        tabs: tabResult.pulled,
        folders: folderResult.pulled,
      };
      const removals = {
        spaces: spaceResult.deleted,
        tabs: tabResult.deleted,
        folders: folderResult.deleted,
        containers: containerResult.deleted,
      };

      // 9. Dispatch live changes to ONE window; ZenWindowSync propagates to others.
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      if (win?.gZenWorkspaces && !win.gZenWorkspaces.privateWindowOrDisabled) {
        await win.gZenWorkspaces._applySyncChanges(pulled, removals);
        this.#pendingItems = null; // DOM updated, pending overlay no longer needed
      }

      this.log("Applied sync data with conflict resolution");
    } catch (e) {
      console.error("ZenSessionManager: Failed to apply sync data:", e);
    } finally {
      this.#insideSyncOperation = false;
    }
  }

  /**
   * Merges two arrays of objects by a string key.
   * Incoming items update existing local items or are appended if new.
   * Local items not present in incoming are preserved unchanged.
   *
   * @param {Array} local     Local items.
   * @param {Array} incoming  Incoming items from sync.
   * @param {string} key      Property name to use as the unique key.
   * @returns {Array}
   */
  #mergeByKey(local, incoming, key) {
    let localMap = new Map(local.map((item) => [item[key], item]));
    for (let item of incoming) {
      if (!item[key]) {
        continue;
      }
      let existing = localMap.get(item[key]);
      localMap.set(item[key], existing ? { ...existing, ...item } : item);
    }
    return Array.from(localMap.values());
  }

  /**
   * Merges an array of incoming synced tabs into the local tab list.
   *
   * For each incoming tab (pinned or unpinned):
   *   - If a local tab with the same zenSyncId exists, its sync-portable
   *     metadata is updated while local browsing state is preserved.
   *   - If no local match exists, the tab is appended.
   *
   * Local tabs without a zenSyncId are always preserved without modification.
   *
   * @param {Array} localTabs       Full local tab list.
   * @param {Array} incomingTabs    Tabs from the sync payload.
   * @returns {Array}
   */
  #mergeTabs(localTabs, incomingTabs) {
    let localById = new Map();
    let localNoId = [];

    for (let tab of localTabs) {
      if (tab.zenSyncId) {
        localById.set(tab.zenSyncId, tab);
      } else {
        localNoId.push(tab);
      }
    }

    let merged = new Map(localById);
    for (let incoming of incomingTabs) {
      let id = incoming.zenSyncId;
      if (!id) {
        continue;
      }

      let existing = localById.get(id);
      if (existing) {
        if (existing.pinned) {
          // Pinned tab: update sync-portable metadata, preserve session state
          merged.set(id, {
            ...existing,
            groupId: incoming.groupId ?? existing.groupId,
            zenWorkspace: incoming.zenWorkspace ?? existing.zenWorkspace,
            zenEssential: incoming.zenEssential ?? existing.zenEssential,
            zenStaticLabel: incoming.zenStaticLabel ?? existing.zenStaticLabel,
            zenHasStaticIcon: incoming.zenHasStaticIcon ?? existing.zenHasStaticIcon,
            zenDefaultUserContextId:
              incoming.zenDefaultUserContextId ?? existing.zenDefaultUserContextId,
            zenPinnedIcon: incoming.zenPinnedIcon ?? existing.zenPinnedIcon,
            _zenPinnedInitialState:
              incoming._zenPinnedInitialState ?? existing._zenPinnedInitialState,
          });
        } else {
          // Unpinned tab: update sync-portable metadata, preserve browsing state
          merged.set(id, {
            ...existing,
            zenWorkspace: incoming.zenWorkspace ?? existing.zenWorkspace,
            groupId: incoming.groupId ?? existing.groupId,
            userContextId: incoming.userContextId ?? existing.userContextId,
            hidden: incoming.hidden ?? existing.hidden,
            zenIsEmpty: incoming.zenIsEmpty ?? existing.zenIsEmpty,
            zenLiveFolderItemId: incoming.zenLiveFolderItemId ?? existing.zenLiveFolderItemId,
          });
        }
      } else {
        merged.set(id, incoming);
      }
    }

    return [...localNoId, ...merged.values()];
  }
}

export const ZenSessionStore = new nsZenSessionManager();
