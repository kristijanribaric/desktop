/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ZenSessionStore: "resource:///modules/zen/ZenSessionManager.sys.mjs",
});

class ZenSyncManager {
  getCurrentSidebarData() {
    return lazy.ZenSessionStore.getCurrentSidebarData();
  }

  async applyIncomingBatch(pulled, removals, meta) {
    return lazy.ZenSessionStore.applyMultiRecordSync(pulled, removals, meta);
  }
}

export const ZenSyncStore = new ZenSyncManager();
