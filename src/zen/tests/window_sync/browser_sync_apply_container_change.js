/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenSyncStore } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSyncManager.sys.mjs"
);

const EMPTY_BATCH = {
  spaces: [],
  tabs: [],
  folders: [],
  containers: [],
  splits: [],
};

// A browser's container (userContextId) is fixed at creation, so applying an
// incoming container change must recreate the tab in the new container while
// keeping its sync ID.
add_task(async function test_ApplyIncomingContainerChange() {
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.userContext.enabled", true]],
  });
  await gZenWorkspaces.promiseInitialized;

  const syncId = "test-incoming-container-tab";
  const makeIncomingTab = userContextId => ({
    zenSyncId: syncId,
    pinned: true,
    zenEssential: false,
    entries: [{ url: "https://example.com/", title: "Example" }],
    index: 1,
    image: "",
    userContextId,
  });

  await ZenSyncStore.applyIncomingBatch(
    { ...EMPTY_BATCH, tabs: [makeIncomingTab(1)] },
    EMPTY_BATCH
  );
  let tab = document.getElementById(syncId);
  Assert.ok(tab, "The incoming tab should have been created");
  Assert.equal(
    tab.userContextId,
    1,
    "The incoming tab should be in the requested container"
  );

  await ZenSyncStore.applyIncomingBatch(
    { ...EMPTY_BATCH, tabs: [makeIncomingTab(2)] },
    EMPTY_BATCH
  );
  tab = document.getElementById(syncId);
  Assert.ok(tab, "The tab should still exist after the container change");
  Assert.equal(
    tab.userContextId,
    2,
    "The tab should have been recreated in the new container"
  );
  Assert.ok(tab.pinned, "The recreated tab should still be pinned");

  BrowserTestUtils.removeTab(tab);
});
