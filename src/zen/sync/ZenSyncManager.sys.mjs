/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
});

function normalizeUserContextId(value) {
  const normalized = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    return null;
  }
  return normalized;
}

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
      throw e;
    }
  }

  #applyIncomingContainers(pulledContainers, removedContainers) {
    const localContainersById = new Map(
      lazy.ContextualIdentityService
        .getPublicIdentities()
        .map(container => [container.userContextId, container]),
    );

    for (const container of pulledContainers) {
      if (!container.name) {
        continue;
      }

      const userContextId = normalizeUserContextId(container.userContextId);
      if (userContextId === null) {
        console.warn(
          "ZenSyncManager: Ignoring incoming container with invalid userContextId",
          { container },
        );
        continue;
      }

      const existsLocally = localContainersById.has(userContextId);

      if (existsLocally) {
        lazy.ContextualIdentityService.update(
          userContextId,
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
        userContextId,
      );
      if (createdIdentity) {
        localContainersById.set(createdIdentity.userContextId, createdIdentity);
      }
      if (
        createdIdentity &&
        createdIdentity.userContextId !== userContextId
      ) {
        console.warn("ZenSyncManager: Container sync created unexpected ID", {
          requestedId: userContextId,
          createdId: createdIdentity.userContextId,
          name: container.name,
        });
      }
    }

    for (const container of removedContainers) {
      const userContextId = normalizeUserContextId(container.userContextId);
      if (userContextId === null) {
        console.warn(
          "ZenSyncManager: Ignoring container removal with invalid userContextId",
          { container },
        );
        continue;
      }

      if (!localContainersById.has(userContextId)) {
        continue;
      }

      try {
        lazy.ContextualIdentityService.remove(userContextId);
        localContainersById.delete(userContextId);
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
