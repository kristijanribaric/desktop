/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ZenSyncStore } = ChromeUtils.importESModule(
  "resource:///modules/zen/ZenSyncManager.sys.mjs"
);

function collectChangedItems() {
  const changed = [];
  const observer = subject => changed.push(subject.wrappedJSObject);
  Services.obs.addObserver(observer, "zen-workspace-item-changed");
  return {
    changed,
    stop: () =>
      Services.obs.removeObserver(observer, "zen-workspace-item-changed"),
  };
}

// zen.window-sync.enabled only controls mirroring tabs between windows on this
// machine. Turning it off must not stop tracking changes for other devices.
add_task(async function test_ChangesTrackedWithoutWindowMirroring() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.window-sync.enabled", false]],
  });
  await gZenWorkspaces.promiseInitialized;

  const tab = gBrowser.addTrustedTab("https://example.com/", {
    inBackground: true,
  });
  const collector = collectChangedItems();

  try {
    const pinned = BrowserTestUtils.waitForEvent(tab, "TabPinned");
    gBrowser.pinTab(tab);
    await pinned;
    await TestUtils.waitForTick();

    ZenSyncStore.notifyAboutChanges();

    Assert.ok(
      collector.changed.some(item => item?.id === tab.id),
      "Pinning a tab should still be tracked when window mirroring is off"
    );
  } finally {
    collector.stop();
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});

// on_TabPinned/on_TabUnpinned normally maintain _zenPinnedInitialState, the
// "home" entry a pinned tab syncs and resets to. That must still happen
// with window mirroring off, even though those handlers never run.
add_task(async function test_PinnedInitialStateWithoutWindowMirroring() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.window-sync.enabled", false]],
  });
  await gZenWorkspaces.promiseInitialized;

  const tab = gBrowser.addTrustedTab("https://example.com/", {
    inBackground: true,
  });

  try {
    const pinned = BrowserTestUtils.waitForEvent(tab, "TabPinned");
    gBrowser.pinTab(tab);
    await pinned;

    await TestUtils.waitForCondition(
      () => tab._zenPinnedInitialState,
      "Waiting for the pinned initial state to be set"
    );
    Assert.ok(
      tab._zenPinnedInitialState?.entry?.url,
      "Pinning without mirroring should still record the initial state"
    );

    const unpinned = BrowserTestUtils.waitForEvent(tab, "TabUnpinned");
    gBrowser.unpinTab(tab);
    await unpinned;

    Assert.ok(
      !tab._zenPinnedInitialState,
      "Unpinning without mirroring should clear the stale initial state"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});
