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

async function withoutSyncedWindow(callback) {
  Object.defineProperty(ZenWindowSync, "firstSyncedWindow", {
    configurable: true,
    get: () => null,
  });
  try {
    return await callback();
  } finally {
    delete ZenWindowSync.firstSyncedWindow;
  }
}

// Items that need a browser window must not be reported as applied when no
// window is available, otherwise Sync marks the records done and the data is
// silently lost instead of being retried.
add_task(async function test_ApplyIncomingBatchWithoutWindow() {
  await gZenWorkspaces.promiseInitialized;

  const syncId = "test-incoming-no-window-tab";
  const applied = await withoutSyncedWindow(() =>
    ZenSyncStore.applyIncomingBatch(
      {
        ...EMPTY_BATCH,
        tabs: [
          {
            zenSyncId: syncId,
            pinned: true,
            entries: [{ url: "https://example.com/", title: "Example" }],
            index: 1,
          },
        ],
      },
      EMPTY_BATCH
    )
  );

  Assert.ok(
    !applied,
    "A batch with window bound items should not report success without a window"
  );
  Assert.equal(
    document.getElementById(syncId),
    null,
    "No tab should have been created"
  );
});

// Nothing window bound to apply is a success, not a retry.
add_task(async function test_ApplyEmptyBatchWithoutWindow() {
  const applied = await withoutSyncedWindow(() =>
    ZenSyncStore.applyIncomingBatch(EMPTY_BATCH, EMPTY_BATCH)
  );

  Assert.ok(applied, "A batch with no window bound items should be applied");
});
