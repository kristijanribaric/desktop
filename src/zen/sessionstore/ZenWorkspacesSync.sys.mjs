/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Store, SyncEngine, Tracker } from "resource://services-sync/engines.sys.mjs";
import { CryptoWrapper } from "resource://services-sync/record.sys.mjs";
import { SCORE_INCREMENT_XLARGE } from "resource://services-sync/constants.sys.mjs";
import { CommonUtils } from "resource://services-common/utils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenSessionStore: "resource:///modules/zen/ZenSessionManager.sys.mjs",
  ContextualIdentityService: "resource://gre/modules/ContextualIdentityService.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "ZEN_WORKSPACES_GUID", () =>
  CommonUtils.encodeBase64URL(Services.appinfo.ID)
);

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

export class ZenWorkspacesRecord extends CryptoWrapper {
  _logName = "Sync.Record.ZenWorkspaces";
}

ZenWorkspacesRecord.prototype.type = "workspaces";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class ZenWorkspacesStore extends Store {
  constructor(name, engine) {
    super(name, engine);
  }

  async getAllIDs() {
    return { [lazy.ZEN_WORKSPACES_GUID]: true };
  }

  async itemExists(id) {
    return id === lazy.ZEN_WORKSPACES_GUID;
  }

  async createRecord(id, collection) {
    let record = new ZenWorkspacesRecord(collection, id);
    if (id !== lazy.ZEN_WORKSPACES_GUID) {
      record.deleted = true;
      return record;
    }

    let sidebar = lazy.ZenSessionStore.getSidebarData();

    // Only sync spaces, pinned/essential tabs, folders, and containers.
    // Regular browsing tabs are device-local and are never synced (for now)
    let spaces = sidebar.spaces || [];
    let pinnedTabs = (sidebar.tabs || []).filter((tab) => tab.pinned);
    let folders = sidebar.folders || [];

    let groups = sidebar.groups || [];

    let containers = lazy.ContextualIdentityService.getPublicIdentities().map((c) => ({
      userContextId: c.userContextId,
      name: c.name,
      icon: c.icon,
      color: c.color,
    }));

    record.cleartext = {
      id: lazy.ZEN_WORKSPACES_GUID,
      spaces,
      pinnedTabs,
      folders,
      groups,
      containers,
    };
    return record;
  }

  async create(record) {
    await this._applyIncoming(record.cleartext);
  }

  async update(record) {
    await this._applyIncoming(record.cleartext);
  }

  async _applyIncoming(data) {
    if (!data) {
      return;
    }

    // Sync containers immediately - they must exist before the next startup
    // so that pinned tabs with a userContextId open in the right container, also cuz workspaces depend on them.
    await this._syncContainers(data.containers || []);

    // Apply workspaces/tabs/folders/groups immediately.
    await lazy.ZenSessionStore.applySyncData({
      spaces: data.spaces || [],
      pinnedTabs: data.pinnedTabs || [],
      folders: data.folders || [],
      groups: data.groups || [],
    });
  }

  /**
   * Ensures every incoming container exists locally with the same userContextId.
   * Creates missing ones (with explicit ID so both devices share the same numeric
   * value) and updates existing ones. Never removes containers.
   *
   * @param {Array<{userContextId, name, icon, color}>} incoming
   */
  async _syncContainers(incoming) {
    try {
      let local = lazy.ContextualIdentityService.getPublicIdentities();
      let localById = new Map(local.map((c) => [c.userContextId, c]));

      for (let container of incoming) {
        if (!container.name) {
          continue;
        }
        if (localById.has(container.userContextId)) {
          lazy.ContextualIdentityService.update(
            container.userContextId,
            container.name,
            container.icon,
            container.color
          );
        } else {
          // Pass explicit ID so both devices share the same numeric userContextId. Made possible my patching the create method on ContextualIdentityService to accept an explicit ID. ( Fuck incremental ID generation!)
          lazy.ContextualIdentityService.create(
            container.name,
            container.icon,
            container.color,
            container.userContextId
          );
        }
      }
    } catch (e) {
      console.error("ZenWorkspacesSync: Error syncing containers:", e);
    }
  }

  async remove() {
    // No-op: never delete user data on wipe
  }

  async wipe() {
    // No-op: never delete user data on wipe
    // We might reconsider this behavior in the future if we want to wipe everyhting because underlying payload structure changed, but for now it doesn't make you lose any data.
  }

  changeItemID() {
    // No-op: single-record engine, ID never changes
  }
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

class ZenWorkspacesTracker extends Tracker {
  constructor(name, engine) {
    super(name, engine);
    this._modified = false;
  }

  onStart() {
    Services.obs.addObserver(this, "zen-workspace-state-changed");
  }

  onStop() {
    Services.obs.removeObserver(this, "zen-workspace-state-changed");
  }

  observe(subject, topic) {
    if (topic === "zen-workspace-state-changed") {
      this._modified = true;
      this.score += SCORE_INCREMENT_XLARGE;
    }
  }

  clearChangedIDs() {
    this._modified = false;
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ZenWorkspacesEngine extends SyncEngine {
  static get name() {
    return "Workspaces";
  }

  constructor(service) {
    super("Workspaces", service);
  }

  get _storeObj() {
    return ZenWorkspacesStore;
  }

  get _trackerObj() {
    return ZenWorkspacesTracker;
  }

  get _recordObj() {
    return ZenWorkspacesRecord;
  }

  get version() {
    return 1;
  }

  get syncPriority() {
    return 6;
  }

  get allowSkippedRecord() {
    return false;
  }

  async getChangedIDs() {
    if (this._tracker._modified) {
      return { [lazy.ZEN_WORKSPACES_GUID]: 0 };
    }
    return {};
  }
}
