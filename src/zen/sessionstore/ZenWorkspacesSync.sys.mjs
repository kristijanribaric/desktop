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
  ZenWindowSync: "resource:///modules/zen/ZenWindowSync.sys.mjs",
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
    this._log.info("ZenWorkspacesStore initialized");
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
    let sidebarData = lazy.ZenSessionStore.getSidebarData();
    record.cleartext = await this._buildPayload(sidebarData);
    return record;
  }

  async _buildPayload(sidebarData) {
    let allIdentities = lazy.ContextualIdentityService.getPublicIdentities();
    let containerIdToName = new Map();
    for (let identity of allIdentities) {
      containerIdToName.set(identity.userContextId, identity.name);
    }

    // Map spaces - convert containerTabId to containerName
    let spaces = (sidebarData.spaces || []).map(space => ({
      uuid: space.uuid,
      name: space.name,
      icon: space.icon,
      theme: space.theme,
      containerName: containerIdToName.get(space.containerTabId) ?? null,
      position: space.position,
    }));

    // Filter pinned tabs (exclude empty tabs)
    let pinnedTabs = (sidebarData.tabs || []).filter(
      tab => tab.pinned && !tab.zenIsEmpty
    );

    let pins = pinnedTabs.map(tab => ({
      uuid: tab.zenSyncId,
      title: tab.entries?.[tab.index - 1]?.title ?? tab.entries?.[0]?.title ?? "",
      url: tab.entries?.[tab.index - 1]?.url ?? tab.entries?.[0]?.url ?? "",
      icon: tab.image ?? null,
      isEssential: tab.zenEssential ?? false,
      workspaceUuid: tab.zenWorkspace ?? null,
      containerName: containerIdToName.get(tab.userContextId) ?? null,
      position: tab.position ?? 0,
      editedTitle: tab.zenStaticLabel ?? null,
      staticLabel: tab.zenStaticLabel ?? null,
      staticIcon: tab.zenHasStaticIcon ? (tab.image ?? null) : null,
    }));

    // Filter out live folders
    let folders = (sidebarData.folders || [])
      .filter(folder => !folder.isLiveFolder)
      .map(folder => ({
        uuid: folder.uuid,
        label: folder.label,
        icon: folder.icon ?? null,
        isCollapsed: folder.isCollapsed ?? false,
        pinned: folder.pinned ?? false,
        position: folder.position ?? 0,
      }));

    // Build container list (unique containers referenced)
    let containerNamesSet = new Set();
    for (let space of spaces) {
      if (space.containerName) containerNamesSet.add(space.containerName);
    }
    for (let pin of pins) {
      if (pin.containerName) containerNamesSet.add(pin.containerName);
    }
    let containers = allIdentities
      .filter(id => containerNamesSet.has(id.name))
      .map(id => ({
        name: id.name,
        icon: id.icon,
        color: id.color,
      }));

    return {
      id: lazy.ZEN_WORKSPACES_GUID,
      version: 1,
      spaces,
      pins,
      folders,
      containers,
      lastModified: Date.now(),
    };
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

    // Step 1: Ensure containers exist, build name→id map
    let containerNameToId = await this._ensureContainers(data.containers || []);

    // Step 2: Remap spaces containerName → containerTabId
    let spaces = (data.spaces || []).map(space => ({
      uuid: space.uuid,
      name: space.name,
      icon: space.icon,
      theme: space.theme,
      containerTabId: containerNameToId.get(space.containerName) ?? 0,
      position: space.position,
    }));

    // Step 3: Merge pinned tabs
    let currentSidebar = lazy.ZenSessionStore.getSidebarData();
    let currentTabs = currentSidebar.tabs || [];

    // Build a map of existing tabs by zenSyncId
    let existingTabMap = new Map();
    for (let tab of currentTabs) {
      if (tab.zenSyncId) {
        existingTabMap.set(tab.zenSyncId, tab);
      }
    }

    // Build the set of incoming pin UUIDs
    let incomingPinUuids = new Set((data.pins || []).map(pin => pin.uuid));

    // Keep unpinned tabs as-is; update or add pinned tabs
    let unpinnedTabs = currentTabs.filter(tab => !tab.pinned);

    let mergedPinnedTabs = (data.pins || []).map(pin => {
      let existing = existingTabMap.get(pin.uuid);
      if (existing) {
        // Update existing tab
        return {
          ...existing,
          zenEssential: pin.isEssential,
          zenWorkspace: pin.workspaceUuid,
          userContextId: containerNameToId.get(pin.containerName) ?? (existing.userContextId ?? 0),
          image: pin.icon ?? existing.image,
          zenHasStaticIcon: pin.staticIcon != null,
          zenStaticLabel: pin.staticLabel ?? undefined,
          position: pin.position,
        };
      }
      // New tab from remote
      let newTab = {
        zenSyncId: pin.uuid,
        pinned: true,
        zenEssential: pin.isEssential ?? false,
        zenWorkspace: pin.workspaceUuid ?? null,
        entries: [{ url: pin.url, title: pin.title }],
        index: 1,
        image: pin.icon ?? null,
        zenHasStaticIcon: pin.staticIcon != null,
        userContextId: containerNameToId.get(pin.containerName) ?? 0,
        zenStaticLabel: pin.staticLabel ?? undefined,
        position: pin.position ?? 0,
      };
      return newTab;
    });

    // Drop pinned tabs that are no longer in the incoming data
    let tabs = [...mergedPinnedTabs, ...unpinnedTabs];

    // Step 4: Folders (already filtered on the sender side, no live folders)
    let folders = (data.folders || []).map(folder => ({
      uuid: folder.uuid,
      label: folder.label,
      icon: folder.icon ?? null,
      isCollapsed: folder.isCollapsed ?? false,
      pinned: folder.pinned ?? false,
      position: folder.position ?? 0,
    }));

    // Step 5: Write to session store
    lazy.ZenSessionStore.applySyncData({ spaces, tabs, folders });

    // Step 6: Propagate workspace changes to open windows for immediate UI update
    try {
      lazy.ZenWindowSync.propagateWorkspacesToAllWindows(spaces);
    } catch (e) {
      this._log.warn("Failed to propagate workspaces to windows", e);
    }
  }

  async _ensureContainers(containers) {
    let allIdentities = lazy.ContextualIdentityService.getPublicIdentities();
    let existingByName = new Map();
    for (let identity of allIdentities) {
      existingByName.set(identity.name, identity.userContextId);
    }

    let nameToId = new Map();
    for (let container of containers) {
      if (!container.name) continue;
      if (existingByName.has(container.name)) {
        nameToId.set(container.name, existingByName.get(container.name));
      } else {
        // Create missing container
        try {
          let newIdentity = lazy.ContextualIdentityService.create(
            container.name,
            container.icon || "circle",
            container.color || "blue"
          );
          nameToId.set(container.name, newIdentity.userContextId);
          this._log.info("Created missing container:", container.name);
        } catch (e) {
          this._log.warn("Failed to create container:", container.name, e);
        }
      }
    }
    return nameToId;
  }

  async remove() {
    // No-op: never delete user data on wipe
  }

  async wipe() {
    // No-op: never delete user data on wipe
  }

  changeItemID() {
    // No-op: single record, ID never changes
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
