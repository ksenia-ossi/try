const $ = (sel) => document.querySelector(sel);

const MAX_PHOTO_SIDE = 1536;
const MAX_GARMENTS = 11;
const RECOMMENDED_GARMENTS = 6;

const selected = new Set();

// ---------- вкладки ----------

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${btn.dataset.tab}`));
    chrome.storage.local.set({ activeTab: btn.dataset.tab });
  });
});

function showTab(name) {
  document.querySelector(`.tabs button[data-tab="${name}"]`)?.click();
}

// ---------- вещи ----------

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

async function renderImages() {
  const { images = [] } = await chrome.storage.local.get("images");
  const grid = $("#grid");
  grid.innerHTML = "";
  $("#empty").style.display = images.length ? "none" : "block";
  $("#count").textContent = images.length ? `Сохранено: ${images.length}` : "";
  for (const id of [...selected]) if (!images.some((i) => i.id === id)) selected.delete(id);

  for (const item of images) {
    const card = document.createElement("div");
    card.className = "card" + (selected.has(item.id) ? " selected" : "");
    card.innerHTML = `
      <img src="${item.src}" alt="" loading="lazy" />
      <div class="check">${selected.has(item.id) ? "✓" : ""}</div>
      <button class="del" title="Удалить">×</button>
      <a href="${item.pageUrl}" target="_blank" title="${item.pageUrl}">${hostOf(item.pageUrl)}</a>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".del, a")) return;
      toggleSelect(item.id);
    });
    card.querySelector(".del").addEventListener("click", () => removeImage(item.id));
    grid.appendChild(card);
  }
  renderSelectionBar();
}

function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id);
  else if (selected.size >= MAX_GARMENTS) return;
  else selected.add(id);
  renderImages();
}

function renderSelectionBar() {
  const bar = $("#tryon-bar");
  bar.classList.toggle("hidden", selected.size === 0);
  const n = selected.size;
  $("#selected-count").textContent =
    n > RECOMMENDED_GARMENTS ? `Выбрано: ${n} (рекомендуется до ${RECOMMENDED_GARMENTS})` : `Выбрано: ${n}`;
}

async function removeImage(id) {
  const { images = [] } = await chrome.storage.local.get("images");
  const next = images.filter((i) => i.id !== id);
  await chrome.storage.local.set({ images: next });
  chrome.action.setBadgeText({ text: next.length ? String(next.length) : "" });
}

$("#toggle").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "TOGGLE_PICKER_IN_TAB" });
  window.close();
});

$("#clear").addEventListener("click", async () => {
  if (!confirm("Удалить все сохранённые картинки?")) return;
  await chrome.storage.local.set({ images: [] });
  chrome.action.setBadgeText({ text: "" });
});

$("#export").addEventListener("click", async () => {
  const { images = [] } = await chrome.storage.local.get("images");
  downloadBlob(new Blob([JSON.stringify(images, null, 2)], { type: "application/json" }), "clothes-picker.json");
});

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- запуск примерки ----------

$("#start-tryon").addEventListener("click", async () => {
  const { profilePhoto, replicateToken } = await chrome.storage.local.get(["profilePhoto", "replicateToken"]);
  if (!replicateToken) { showTab("settings"); setTokenStatus("Сначала добавь API-токен Replicate", "err"); return; }
  if (!profilePhoto?.dataUrl) { showTab("tryon"); $("#photo-pick").focus(); return; }

  const btn = $("#start-tryon");
  btn.disabled = true;
  const res = await chrome.runtime.sendMessage({
    type: "START_TRYON",
    payload: { garmentIds: [...selected], prompt: $("#prompt").value.trim(), turbo: $("#turbo").checked },
  });
  btn.disabled = false;
  if (!res?.ok) { alert(res?.error || "Не удалось запустить примерку"); return; }
  selected.clear();
  renderImages();
  showTab("tryon");
});

// ---------- моё фото ----------

$("#photo-pick").addEventListener("click", () => $("#photo-input").click());
$("#photo-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file, MAX_PHOTO_SIDE);
    await chrome.storage.local.set({ profilePhoto: { dataUrl, name: file.name, updatedAt: Date.now() } });
  } catch (err) {
    alert("Не удалось обработать фото: " + err.message);
  }
});
$("#photo-remove").addEventListener("click", () => chrome.storage.local.remove("profilePhoto"));

async function resizeImage(file, maxSide) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.88);
}

async function renderPhoto() {
  const { profilePhoto } = await chrome.storage.local.get("profilePhoto");
  const preview = $("#photo-preview");
  if (profilePhoto?.dataUrl) {
    preview.innerHTML = `<img src="${profilePhoto.dataUrl}" alt="Моё фото" />`;
    $("#photo-pick").textContent = "Заменить фото";
    $("#photo-remove").classList.remove("hidden");
  } else {
    preview.innerHTML = `<span class="photo-placeholder">Нет фото</span>`;
    $("#photo-pick").textContent = "Загрузить фото";
    $("#photo-remove").classList.add("hidden");
  }
}

// ---------- результаты ----------

const STATUS_TEXT = {
  starting: "Запускаю…",
  uploading: "Загружаю фото…",
  processing: "Модель работает…",
  succeeded: "Готово",
  failed: "Ошибка",
  canceled: "Отменено",
};

async function renderResults() {
  const { tryons = [], images = [] } = await chrome.storage.local.get(["tryons", "images"]);
  const box = $("#results");
  box.innerHTML = "";
  $("#results-empty").style.display = tryons.length ? "none" : "block";
  for (const job of tryons) {
    const el = document.createElement("div");
    el.className = "result";
    const done = job.status === "succeeded";
    const failed = job.status === "failed" || job.status === "canceled";
    const busy = !done && !failed;
    el.innerHTML = `
      <div class="out">${done ? `<img src="${job.output}" alt="Результат" />` : failed ? "✕" : `<span class="spinner"></span>`}</div>
      <div class="meta">
        <div class="garments">${job.garments.map((g) => `<img src="${g.src}" alt="" title="${g.src}" />`).join("")}</div>
        <div class="status-line ${failed ? "err" : ""}">
          ${busy ? `<span class="spinner"></span>` : ""}${STATUS_TEXT[job.status] || job.status}${job.note ? ` · ${job.note}` : ""}
          ${failed && job.error ? `<br>${escapeHtml(job.error)}` : ""}
        </div>
        <div class="hint">${new Date(job.createdAt).toLocaleString()}</div>
        <div class="links"></div>
      </div>`;
    const links = el.querySelector(".links");
    if (done) {
      links.append(
        button("Открыть", () => chrome.tabs.create({ url: job.output })),
        button("Скачать", () => downloadResult(job)),
      );
    }
    if (failed) links.append(button("Повторить", () => retry(job, images)));
    links.append(button("Удалить", () => removeJob(job.id), "danger"));
    box.appendChild(el);
  }
}

function button(text, onClick, cls = "") {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function downloadResult(job) {
  try {
    const res = await fetch(job.output);
    const blob = await res.blob();
    downloadBlob(blob, `tryon-${job.id.slice(0, 8)}.${(blob.type.split("/")[1] || "png").replace("jpeg", "jpg")}`);
  } catch {
    chrome.tabs.create({ url: job.output });
  }
}

async function retry(job, images) {
  const ids = job.garments.map((g) => g.id).filter((id) => images.some((i) => i.id === id));
  if (!ids.length) { alert("Вещи этой примерки уже удалены"); return; }
  const res = await chrome.runtime.sendMessage({
    type: "START_TRYON",
    payload: { garmentIds: ids, prompt: job.prompt, turbo: $("#turbo").checked },
  });
  if (!res?.ok) alert(res?.error || "Не удалось запустить примерку");
}

async function removeJob(id) {
  const { tryons = [] } = await chrome.storage.local.get("tryons");
  await chrome.storage.local.set({ tryons: tryons.filter((t) => t.id !== id) });
}

// ---------- настройки ----------

function setTokenStatus(text, cls = "") {
  const s = $("#token-status");
  s.textContent = text;
  s.className = "status " + cls;
}

$("#token-save").addEventListener("click", async () => {
  const token = $("#token").value.trim();
  if (!token) {
    await chrome.storage.local.remove("replicateToken");
    setTokenStatus("Токен удалён");
    return;
  }
  setTokenStatus("Проверяю…");
  const res = await chrome.runtime.sendMessage({ type: "VERIFY_TOKEN", token });
  if (res?.ok) {
    await chrome.storage.local.set({ replicateToken: token });
    setTokenStatus(`Сохранено · аккаунт ${res.username}`, "ok");
  } else {
    setTokenStatus(res?.error || "Токен не подошёл", "err");
  }
});

async function renderSettings() {
  const { replicateToken } = await chrome.storage.local.get("replicateToken");
  if (replicateToken) {
    $("#token").value = replicateToken;
    setTokenStatus("Токен сохранён", "ok");
  }
}

// ---------- init ----------

chrome.storage.onChanged.addListener((changes) => {
  if (changes.images) renderImages();
  if (changes.profilePhoto) renderPhoto();
  if (changes.tryons || changes.images) renderResults();
});

(async () => {
  const { activeTab } = await chrome.storage.local.get("activeTab");
  if (activeTab) showTab(activeTab);
  renderImages();
  renderPhoto();
  renderResults();
  renderSettings();
})();
