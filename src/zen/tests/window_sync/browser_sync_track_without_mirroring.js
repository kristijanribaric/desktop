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
