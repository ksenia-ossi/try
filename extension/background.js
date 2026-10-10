// Service worker: контекстное меню, горячая клавиша, сохранение картинок, примерка через Replicate

import {
  toInputUrl,
  reuploadRemoteImage,
  createPrediction,
  waitForPrediction,
  firstOutputUrl,
  verifyToken,
} from "./replicate.js";

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
    saveImage(msg.payload).then(sendResponse);
    return true;
  }
  if (msg.type === "TOGGLE_PICKER_IN_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PICKER" }).catch(() => {});
    });
  }
  if (msg.type === "START_TRYON") {
    startTryOn(msg.payload).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === "VERIFY_TOKEN") {
    verifyToken(msg.token).then(
      (acc) => sendResponse({ ok: true, username: acc.username }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
});

// ---------- сохранение картинок ----------

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

// ---------- примерка ----------

async function updateJob(id, patch) {
  const { tryons = [] } = await chrome.storage.local.get("tryons");
  const idx = tryons.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tryons[idx] = { ...tryons[idx], ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ tryons });
}

const SLOTS = ["top", "bottom", "shoes"];

async function startTryOn({ slots = {}, prompt, turbo }) {
  const { images = [], profilePhoto, replicateToken, tryons = [] } = await chrome.storage.local.get([
    "images",
    "profilePhoto",
    "replicateToken",
    "tryons",
  ]);
  if (!replicateToken) return { ok: false, error: "Нет API-токена Replicate — добавь его в настройках" };
  if (!profilePhoto?.dataUrl) return { ok: false, error: "Сначала загрузи своё фото" };
  // по одной вещи на слот (Верх / Низ / Обувь), от 1 до 3 вещей
  const garments = [];
  for (const slot of SLOTS) {
    if (!slots[slot]) continue;
    const item = images.find((i) => i.id === slots[slot]);
    if (!item) return { ok: false, error: `Вещь для слота «${slot}» не найдена` };
    if (garments.some((g) => g.id === item.id)) return { ok: false, error: "Одна вещь не может занимать два слота" };
    garments.push({ ...item, slot });
  }
  if (!garments.length) return { ok: false, error: "Выбери хотя бы одну вещь" };

  const job = {
    id: crypto.randomUUID(),
    status: "starting",
    garments: garments.map((g) => ({ id: g.id, src: g.src, slot: g.slot })),
    prompt: prompt || "",
    output: null,
    error: null,
    predictionId: null,
    createdAt: Date.now(),
  };
  tryons.unshift(job);
  await chrome.storage.local.set({ tryons });

  runTryOn(job, { token: replicateToken, personDataUrl: profilePhoto.dataUrl, turbo }).catch((e) =>
    updateJob(job.id, { status: "failed", error: e.message })
  );
  return { ok: true, jobId: job.id };
}

async function runTryOn(job, { token, personDataUrl, turbo }) {
  await updateJob(job.id, { status: "uploading" });
  const personUrl = await toInputUrl(token, personDataUrl, "person.jpg");

  const makeInput = (garmentUrls) => {
    const input = { person_image: personUrl, garment_images: garmentUrls };
    if (job.prompt) input.prompt = job.prompt;
    if (turbo) input.turbo = true;
    return input;
  };

  let prediction;
  try {
    prediction = await runOnce(job, token, makeInput(job.garments.map((g) => g.src)));
  } catch (e) {
    if (!looksLikeFetchProblem(e)) throw e;
    // Магазин не отдал картинку Replicate (hotlink-защита) — скачиваем сами и заливаем
    await updateJob(job.id, { status: "uploading", note: "Перезаливаю картинки вещей…" });
    const urls = [];
    for (const g of job.garments) urls.push(await reuploadRemoteImage(token, g.src));
    prediction = await runOnce(job, token, makeInput(urls));
  }

  const output = firstOutputUrl(prediction.output);
  if (!output) throw new Error("Модель не вернула картинку");
  await updateJob(job.id, { status: "succeeded", output, note: null, metrics: prediction.metrics || null });
}

async function runOnce(job, token, input) {
  await updateJob(job.id, { status: "processing" });
  let prediction = await createPrediction(token, input);
  await updateJob(job.id, { predictionId: prediction.id });
  prediction = await waitForPrediction(token, prediction, (p) => updateJob(job.id, { status: p.status }));
  if (prediction.status !== "succeeded") {
    throw new Error(prediction.error || `Статус: ${prediction.status}`);
  }
  return prediction;
}

function looksLikeFetchProblem(e) {
  return /download|fetch|403|404|forbidden|not found|timed? ?out|unsupported|could not|invalid image|cannot identify/i.test(
    e.message || ""
  );
}
