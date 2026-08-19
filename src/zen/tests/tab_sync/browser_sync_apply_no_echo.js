/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenSyncStore } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSyncManager.sys.mjs"
);
const { ZenWindowSync } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenWindowSync.sys.mjs"
);

const EMPTY_BATCH = {
  spaces: [],
  tabs: [],
  folders: [],
  containers: [],
  splits: [],
};

// Applying an incoming sync batch dispatches tab events (TabOpen, TabPinned,
// TabMove, ...) that ZenWindowSync processes through a deferred queue. Those
// events must not mark the applied items as locally changed, otherwise every
// pull would immediately be echoed back to Sync.
add_task(async function test_ApplyIncomingBatchDoesNotEcho() {
  await gZenWorkspaces.promiseInitialized;

  const syncId = "test-incoming-echo-tab";
  const incomingTab = {
    zenSyncId: syncId,
    pinned: true,
    zenEssential: false,
    entries: [{ url: "https://example.com/", title: "Example" }],
    index: 1,
    image: "",
    userContextId: 0,
  };

  const changedItems = [];
  const observer = subject => {
    changedItems.push(subject.wrappedJSObject);
  };
  Services.obs.addObserver(observer, "zen-workspace-item-changed");

  try {
    await ZenSyncStore.applyIncomingBatch(
      { ...EMPTY_BATCH, tabs: [incomingTab] },
      EMPTY_BATCH
    );

    const tab = document.getElementById(syncId);
    Assert.ok(tab, "The incoming tab should have been created");
    Assert.ok(tab.pinned, "The incoming tab should be pinned");

    // Give any deferred events dispatched by the apply a chance to be
    // processed, then flush the changed-items map to observers.
    await ZenWindowSync.waitForEventQueueToDrain();
    await TestUtils.waitForTick();
    ZenSyncStore.notifyAboutChanges();

    const echoed = changedItems.filter(item => item?.id === syncId);
    Assert.deepEqual(
      echoed,
      [],
      "Applying an incoming tab should not mark it as locally changed"
    );
  } finally {
    Services.obs.removeObserver(observer, "zen-workspace-item-changed");
    const tab = document.getElementById(syncId);
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});
