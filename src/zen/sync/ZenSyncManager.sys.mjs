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
  _lastSnapshot = null;

  getSidebarData() {
    return lazy.ZenSessionStore.getSidebarData();
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
            `s~${uuid}`,
          );
        }
      }

      for (const uuid of prev.spaces.keys()) {
        if (!snapshot.spaces.has(uuid)) {
          Services.obs.notifyObservers(
            null,
            "zen-workspace-item-changed",
            `s~${uuid}`,
          );
        }
      }
    }

    this._lastSnapshot = snapshot;
  }

  async applyIncomingBatch(pulled, removals) {
    try {
      let sidebar = lazy.ZenSessionStore.getSidebarData();

      this.#applyIncomingContainers(
        pulled.containers || [],
        removals.containers || [],
      );
      this.#removeDeletedItems(sidebar, removals);
      this.#mergeIncomingItems(sidebar, pulled);


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
        c => String(c.userContextId) === String(container.userContextId),
      );

      if (existsLocally) {
        lazy.ContextualIdentityService.update(
          container.userContextId,
          container.name,
          container.icon,
          container.color,
        );
        continue;
      }

      const createdIdentity = lazy.ContextualIdentityService.create(
        container.name,
        container.icon,
        container.color,
        container.userContextId,
      );
      if (
        createdIdentity &&
        String(createdIdentity.userContextId) !==
        String(container.userContextId)
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

    if (removedSpaceIds.size) {
      sidebar.spaces = (sidebar.spaces || []).filter(
        space => !removedSpaceIds.has(space.uuid),
      );
    }
  }

  #mergeIncomingItems(sidebar, pulled) {
    if (pulled.spaces?.length) {
      const spaceMap = new Map(
        (sidebar.spaces || []).map(space => [space.uuid, space]),
      );
      for (const space of pulled.spaces) {
        if (!space.uuid) {
          continue;
        }
        const existing = spaceMap.get(space.uuid);
        spaceMap.set(space.uuid, existing ? { ...existing, ...space } : space);
      }
      sidebar.spaces = Array.from(spaceMap.values());
      sidebar.spaces.sort(
        (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity),
      );
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

    return { spaces };
  }
}

export const ZenSyncStore = new ZenSyncManager();
