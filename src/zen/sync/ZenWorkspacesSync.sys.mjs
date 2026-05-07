/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  Store,
  SyncEngine,
  Tracker,
} from "resource://services-sync/engines.sys.mjs";
import { CryptoWrapper } from "resource://services-sync/record.sys.mjs";
import { SCORE_INCREMENT_XLARGE } from "resource://services-sync/constants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenSyncStore: "resource:///modules/zen/ZenSyncManager.sys.mjs",
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
});

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

export class ZenWorkspacesRecord extends CryptoWrapper {
  _logName = "Sync.Record.ZenWorkspaces";
}

ZenWorkspacesRecord.prototype.type = "workspaces";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRecordId(id) {
  const sep = id.indexOf("~");
  if (sep === -1) {
    return null;
  }
  const prefix = id.slice(0, sep);
  const key = id.slice(sep + 1);
  const typeMap = {
    s: "space",
    c: "container",
  };
  return { type: typeMap[prefix] || prefix, key };
}

/**
 * Strips the sync-envelope fields (`id` and `type`) from incoming record data
 * and restores the item's real identity key where needed
 *
 * @param data
 */
function stripSyncFields(data) {
  const { id: _recordId, type: _recordType, ...rest } = data;

  return rest;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class ZenWorkspacesStore extends Store {
  constructor(name, engine) {
    super(name, engine);
  }

  async getAllIDs() {
    const ids = {};
    const sidebar = lazy.ZenSyncStore.getCurrentSidebarData();

    for (const space of sidebar.spaces || []) {
      if (space.uuid) {
        ids[`s~${space.uuid}`] = true;
      }
    }

    for (const c of lazy.ContextualIdentityService.getPublicIdentities()) {
      ids[`c~${c.userContextId}`] = true;
    }

    return ids;
  }

  async itemExists(id) {
    const parsed = parseRecordId(id);
    if (!parsed) {
      return false;
    }
    const sidebar = lazy.ZenSyncStore.getCurrentSidebarData();

    switch (parsed.type) {
      case "space":
        return (sidebar.spaces || []).some(s => s.uuid === parsed.key);
      case "container":
        return lazy.ContextualIdentityService.getPublicIdentities().some(
          c => String(c.userContextId) === parsed.key,
        );
      default:
        return false;
    }
  }

  async createRecord(id, collection) {
    const record = new ZenWorkspacesRecord(collection, id);
    const parsed = parseRecordId(id);
    if (!parsed) {
      record.deleted = true;
      return record;
    }

    const sidebar = lazy.ZenSyncStore.getCurrentSidebarData();

    switch (parsed.type) {
      case "space": {
        const spaces = sidebar.spaces || [];
        const idx = spaces.findIndex(s => s.uuid === parsed.key);
        if (idx === -1) {
          record.deleted = true;
          return record;
        }
        const { syncStatus: _sx, ...rest } = spaces[idx];
        record.cleartext = { id, type: "space", ...rest, position: idx };
        break;
      }

      case "container": {
        const container =
          lazy.ContextualIdentityService.getPublicIdentities().find(
            c => String(c.userContextId) === parsed.key,
          );
        if (!container) {
          record.deleted = true;
          return record;
        }
        record.cleartext = {
          id,
          type: "container",
          userContextId: container.userContextId,
          name: container.name,
          icon: container.icon,
          color: container.color,
        };
        break;
      }

      default:
        record.deleted = true;
    }

    return record;
  }

  async applyIncomingBatch(records, countTelemetry) {
    const pulled = { spaces: [], containers: [] };
    const removals = { spaces: [], containers: [] };

    for (const record of records) {
      if (record.deleted) {
        this._collectRemoval(record.id, removals);
        continue;
      }
      const data = record.cleartext;
      if (!data?.type) {
        continue;
      }
      const clean = stripSyncFields(data);
      switch (data.type) {
        case "space":
          pulled.spaces.push(clean);
          break;
        case "container":
          pulled.containers.push(clean);
          break;
      }
    }

    // Suppress change tracking while applying incoming data to prevent
    // feedback loops where applied items get re-uploaded immediately.
    // TODO: KR Check if needed
    this.engine._tracker.ignoreAll = true;
    try {
      await lazy.ZenSyncStore.applyIncomingBatch(pulled, removals);
    } finally {
      this.engine._tracker.ignoreAll = false;
    }
    return [];
  }

  _collectRemoval(id, removals) {
    const parsed = parseRecordId(id);
    if (!parsed) {
      return;
    }
    switch (parsed.type) {
      case "space":
        removals.spaces.push({ uuid: parsed.key });
        break;
      case "container":
        removals.containers.push({ userContextId: parsed.key });
        break;
    }
  }

  async create(record) {
    await this._applySingle(record);
  }

  async update(record) {
    await this._applySingle(record);
  }

  async _applySingle(record) {
    // TODO: KR Check if needed
    this.engine._tracker.ignoreAll = true;
    try {
      if (record.deleted) {
        const removals = { spaces: [], containers: [] };
        this._collectRemoval(record.id, removals);
        await lazy.ZenSyncStore.applyIncomingBatch(
          { spaces: [], containers: [] },
          removals);
        return;
      }
      const data = record.cleartext;
      if (!data?.type) {
        return;
      }
      const clean = stripSyncFields(data);
      const pulled = { spaces: [], containers: [] };
      switch (data.type) {
        case "space":
          pulled.spaces.push(clean);
          break;
        case "container":
          pulled.containers.push(clean);
          break;
      }
      await lazy.ZenSyncStore.applyIncomingBatch(
        pulled,
        { spaces: [], containers: [] });
    } finally {
      this.engine._tracker.ignoreAll = false;
    }
  }

  async remove() {
    // No-op: never delete user data on wipe
  }

  async wipe() {
    // No-op: never delete user data on wipe
  }

  changeItemID() {
    // No-op
  }
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

class ZenWorkspacesTracker extends Tracker {
  _changedIDs = {};
  _ignoreAll = false;

  get ignoreAll() {
    return this._ignoreAll;
  }

  set ignoreAll(value) {
    this._ignoreAll = value;
  }

  onStart() {
    Services.obs.addObserver(this, "zen-workspace-item-changed");
    Services.obs.addObserver(this, "contextual-identity-created");
    Services.obs.addObserver(this, "contextual-identity-updated");
    Services.obs.addObserver(this, "contextual-identity-deleted");
  }

  onStop() {
    Services.obs.removeObserver(this, "zen-workspace-item-changed");
    Services.obs.removeObserver(this, "contextual-identity-created");
    Services.obs.removeObserver(this, "contextual-identity-updated");
    Services.obs.removeObserver(this, "contextual-identity-deleted");
  }

  observe(subject, topic, data) {
    if (this._ignoreAll) {
      return;
    }
    if (topic === "zen-workspace-item-changed") {
      this._trackChange(data);
    } else if (topic.startsWith("contextual-identity-")) {
      const id = subject?.wrappedJSObject?.userContextId;
      if (id) {
        this._trackChange(`c~${id}`);
      }
    }
  }

  _trackChange(id) {
    this._changedIDs[id] = Date.now() / 1000;
    this.score += SCORE_INCREMENT_XLARGE;
  }

  async getChangedIDs() {
    return { ...this._changedIDs };
  }

  async addChangedID(id, when) {
    this._changedIDs[id] = when;
    return true;
  }

  async removeChangedID(...ids) {
    for (const id of ids) {
      delete this._changedIDs[id];
    }
    return true;
  }

  clearChangedIDs() {
    this._changedIDs = {};
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
    return 2;
  }

  get syncPriority() {
    return 6;
  }

  get allowSkippedRecord() {
    return false;
  }
}
