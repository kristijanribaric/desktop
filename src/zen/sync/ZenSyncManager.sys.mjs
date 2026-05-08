/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
});

class ZenSyncManager {
  
  async applyIncomingBatch(pulled, removals) {
    try {

      this.#applyIncomingContainers(
        pulled.containers || [],
        removals.containers || [],
      );

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

}

export const ZenSyncStore = new ZenSyncManager();
