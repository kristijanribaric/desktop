/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenSessionStore: "resource:///modules/zen/ZenSessionManager.sys.mjs",
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
});

class ZenSyncManager {
  // Runtime-only tab fields excluded from sync hashing. This mirrors the
  // sync record cleanup plus lastAccessed, which changes on every tab switch.
  static #HASH_STRIP_TAB_FIELDS = [
    "syncStatus",
    "scroll",
    "formdata",
    "selected",
    "_zenIsActiveTab",
    "_zenContentsVisible",
    "_zenChangeLabelFlag",
    "lastAccessed",
  ];

  _lastSnapshot = null;

  getCurrentSidebarData() {
    return lazy.ZenSessionStore.getCurrentSidebarData();
  }

  seedSnapshot(sidebar) {
    this._lastSnapshot = this.#buildSnapshot(sidebar || {});
  }

  noteSidebarDataChanged(sidebar) {
    const snapshot = this.#buildSnapshot(sidebar || {});
    const prev = this._lastSnapshot;

    if (prev) {
      for (const [uuid, hash] of snapshot.spaces) {
        if (prev.spaces.get(uuid) !== hash) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `s~${uuid}`
          );
        }
      }

      for (const uuid of prev.spaces.keys()) {
        if (!snapshot.spaces.has(uuid)) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `s~${uuid}`
          );
        }
      }

      for (const [id, hash] of snapshot.tabs) {
        if (prev.tabs.get(id) !== hash) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `t~${id}`
          );
        }
      }

      for (const id of prev.tabs.keys()) {
        if (!snapshot.tabs.has(id)) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `t~${id}`
          );
        }
      }

      for (const [id, hash] of snapshot.folders) {
        if (prev.folders.get(id) !== hash) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `f~${id}`
          );
        }
      }

      for (const id of prev.folders.keys()) {
        if (!snapshot.folders.has(id)) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `f~${id}`
          );
        }
      }

      if (prev.metaHash !== snapshot.metaHash) {
        Services.obs.notifyObservers(
          null,
          "zen-workspace-item-changed",
          "meta~global"
        );
      }
    }

    this._lastSnapshot = snapshot;
  }

  async applyIncomingBatch(pulled, removals, meta) {
    try {
      let sidebar = lazy.ZenSessionStore.getSidebarData();

      this.#applyIncomingContainers(pulled.containers || [], removals.containers || []);
      this.#removeDeletedItems(sidebar, removals);
      this.#mergeIncomingItems(sidebar, pulled);

      if (meta) {
        sidebar.groups = meta.groups;
        sidebar.splitViewData = meta.splitViewData;
      }

      lazy.ZenSessionStore.replaceSidebarData(sidebar, true);
      this.seedSnapshot(sidebar);

      const win = Services.wm.getMostRecentWindow("navigator:browser");
      if (win?.gZenWorkspaces && !win.gZenWorkspaces.privateWindowOrDisabled) {
        await win.gZenWorkspaces._applySyncChanges(pulled, removals);
      }
    } catch (e) {
      console.error("ZenSyncManager: Failed to apply incoming sync data:", e);
    }
  }

  #applyIncomingContainers(pulledContainers, removedContainers) {
    const localContainers =
      lazy.ContextualIdentityService.getPublicIdentities();

    for (const container of pulledContainers) {
      if (!container.name) {
        continue;
      }

      const existsLocally = localContainers.some(
        c => String(c.userContextId) === String(container.userContextId)
      );

      if (existsLocally) {
        lazy.ContextualIdentityService.update(
          container.userContextId,
          container.name,
          container.icon,
          container.color
        );
        continue;
      }

      const createdIdentity = lazy.ContextualIdentityService.create(
        container.name,
        container.icon,
        container.color,
        container.userContextId
      );
      if (
        createdIdentity &&
        String(createdIdentity.userContextId) !== String(container.userContextId)
      ) {
        console.warn("ZenSyncManager: Container sync created unexpected ID", {
          requestedId: container.userContextId,
          createdId: createdIdentity.userContextId,
          name: container.name,
        });
      }
    }

    for (const container of removedContainers) {
      try {
        lazy.ContextualIdentityService.remove(container.userContextId);
      } catch {
        // Container may already be gone locally.
      }
    }
  }

  #removeDeletedItems(sidebar, removals) {
    const removedSpaceIds = new Set((removals.spaces || []).map(s => s.uuid));
    const removedTabIds = new Set((removals.tabs || []).map(t => t.zenSyncId));
    const removedFolderIds = new Set(
      (removals.folders || []).map(f => String(f.id))
    );

    if (removedSpaceIds.size) {
      sidebar.spaces = (sidebar.spaces || []).filter(
        space => !removedSpaceIds.has(space.uuid)
      );
    }

    if (removedTabIds.size) {
      sidebar.tabs = (sidebar.tabs || []).filter(
        tab => !removedTabIds.has(tab.zenSyncId)
      );
    }

    if (removedFolderIds.size) {
      sidebar.folders = (sidebar.folders || []).filter(
        folder => !removedFolderIds.has(String(folder.id))
      );
    }
  }

  #mergeIncomingItems(sidebar, pulled) {
    if (pulled.spaces?.length) {
      const spaceMap = new Map((sidebar.spaces || []).map(space => [space.uuid, space]));
      for (const space of pulled.spaces) {
        if (!space.uuid) {
          continue;
        }
        const existing = spaceMap.get(space.uuid);
        spaceMap.set(space.uuid, existing ? { ...existing, ...space } : space);
      }
      sidebar.spaces = Array.from(spaceMap.values());
      sidebar.spaces.sort(
        (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity)
      );
    }

    if (pulled.tabs?.length) {
      const tabMap = new Map();
      const noIdTabs = [];

      for (const tab of sidebar.tabs || []) {
        if (tab.zenSyncId) {
          tabMap.set(tab.zenSyncId, tab);
        } else {
          noIdTabs.push(tab);
        }
      }

      for (const tab of pulled.tabs) {
        if (!tab.zenSyncId) {
          continue;
        }
        const existing = tabMap.get(tab.zenSyncId);
        tabMap.set(tab.zenSyncId, existing ? { ...existing, ...tab } : tab);
      }

      const syncedTabs = Array.from(tabMap.values());
      syncedTabs.sort((a, b) => {
        const aPosition =
          typeof a.position === "number" ? a.position : Number.POSITIVE_INFINITY;
        const bPosition =
          typeof b.position === "number" ? b.position : Number.POSITIVE_INFINITY;
        return aPosition - bPosition;
      });
      sidebar.tabs = [...noIdTabs, ...syncedTabs];
    }

    if (pulled.folders?.length) {
      const folderMap = new Map(
        (sidebar.folders || []).map(folder => [String(folder.id), folder])
      );
      for (const folder of pulled.folders) {
        if (!folder.id) {
          continue;
        }
        const existing = folderMap.get(String(folder.id));
        folderMap.set(
          String(folder.id),
          existing ? { ...existing, ...folder } : folder
        );
      }
      sidebar.folders = Array.from(folderMap.values());
    }
  }

  #buildSnapshot(sidebar) {
    const spaces = new Map();
    const spaceList = sidebar.spaces || [];
    for (let i = 0; i < spaceList.length; i++) {
      const space = spaceList[i];
      if (space.uuid) {
        spaces.set(space.uuid, JSON.stringify({ ...space, _pos: i }));
      }
    }

    const tabs = new Map();
    const tabList = sidebar.tabs || [];
    for (let i = 0; i < tabList.length; i++) {
      const tab = tabList[i];
      if (tab.zenSyncId && !(tab.zenIsEmpty && !tab.groupId)) {
        const cleaned = { ...tab, _pos: i };
        for (const field of ZenSyncManager.#HASH_STRIP_TAB_FIELDS) {
          delete cleaned[field];
        }
        tabs.set(tab.zenSyncId, JSON.stringify(cleaned));
      }
    }

    const folders = new Map();
    for (const folder of sidebar.folders || []) {
      if (folder.id) {
        const { syncStatus: _ignored, ...rest } = folder;
        folders.set(String(folder.id), JSON.stringify(rest));
      }
    }

    const metaHash = JSON.stringify({
      g: sidebar.groups || [],
      sv: sidebar.splitViewData || [],
    });

    return { spaces, tabs, folders, metaHash };
  }
}

export const ZenSyncStore = new ZenSyncManager();
