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
    const metaSnapshot = lazy.ZenSessionStore.getSyncMetaSnapshot();

    // Sync spaces, ALL tabs with zenSyncId, folders, and containers.
    // Strip syncStatus (internal only) and stamp modifiedAt from syncMeta.
    let spaces = (sidebar.spaces || []).map(({ syncStatus: _s, ...rest }) => ({
      ...rest,
      modifiedAt: metaSnapshot.spaces?.[rest.uuid]?.modifiedAt ?? 0,
    }));

    let tabs = (sidebar.tabs || [])
      .filter((tab) => tab.zenSyncId && !(tab.zenIsEmpty && !tab.groupId))
      .map((tab) => {
        // Strip heavy session state and internal runtime flags.
        const {
          syncStatus: _s,
          scroll: _sc,
          formdata: _fd,
          selected: _sel,
          _zenIsActiveTab: _a,
          _zenContentsVisible: _c,
          _zenChangeLabelFlag: _cl,
          ...rest
        } = tab;
        // For unpinned tabs, trim entries to just the active entry
        if (!tab.pinned && rest.entries?.length) {
          const idx = typeof rest.index === "number" ? Math.max(0, rest.index - 1) : 0;
          const entry = rest.entries[idx] || rest.entries[0];
          rest.entries = entry ? [entry] : [];
          rest.index = 1;
        }
        return {
          ...rest,
          modifiedAt: metaSnapshot.tabs?.[rest.zenSyncId]?.modifiedAt ?? 0,
        };
      });

    let folders = (sidebar.folders || []).map(({ syncStatus: _s, ...rest }) => ({
      ...rest,
      modifiedAt: metaSnapshot.folders?.[String(rest.id)]?.modifiedAt ?? 0,
    }));

    let groups = sidebar.groups || [];

    let splitViewData = sidebar.splitViewData || [];

    let containers = lazy.ContextualIdentityService.getPublicIdentities().map((c) => ({
      userContextId: c.userContextId,
      name: c.name,
      icon: c.icon,
      color: c.color,
      modifiedAt: metaSnapshot.containers?.[String(c.userContextId)]?.modifiedAt ?? 0,
    }));

    record.cleartext = {
      id: lazy.ZEN_WORKSPACES_GUID,
      spaces,
      tabs,
      folders,
      groups,
      splitViewData,
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
    // Pass all data (including containers) to applySyncData which now handles
    // container reconciliation internally via ContextualIdentityService.
    await lazy.ZenSessionStore.applySyncData({
      spaces: data.spaces || [],
      tabs: data.tabs || data.pinnedTabs || [],
      folders: data.folders || [],
      groups: data.groups || [],
      splitViewData: data.splitViewData || [],
      containers: data.containers || [],
    });
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

  async _syncFinish() {
    await super._syncFinish();
    lazy.ZenSessionStore.markAllItemsSynced();
  }
}
