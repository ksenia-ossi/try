// Service worker: контекстное меню + горячая клавиша + сохранение в storage

const MENU_ID = "clothes-picker-save";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Сохранить картинку в Clothes Picker",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && info.srcUrl) {
    saveImage({ src: info.srcUrl, pageUrl: info.pageUrl || tab?.url, title: tab?.title });
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-picker" && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PICKER" }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SAVE_IMAGE") {
    saveImage(msg.payload).then((result) => sendResponse(result));
    return true; // асинхронный ответ
  }
  if (msg.type === "TOGGLE_PICKER_IN_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PICKER" }).catch(() => {});
    });
  }
});

async function saveImage({ src, pageUrl, title, alt }) {
  if (!src) return { ok: false, reason: "no-src" };
  const { images = [] } = await chrome.storage.local.get("images");
  if (images.some((i) => i.src === src)) return { ok: false, reason: "duplicate" };
  const item = {
    id: crypto.randomUUID(),
    src,
    pageUrl: pageUrl || "",
    title: title || "",
    alt: alt || "",
    savedAt: Date.now(),
  };
  images.unshift(item);
  await chrome.storage.local.set({ images });
  chrome.action.setBadgeText({ text: String(images.length) });
  return { ok: true, item };
}

chrome.storage.local.get("images").then(({ images = [] }) => {
  chrome.action.setBadgeText({ text: images.length ? String(images.length) : "" });
});
