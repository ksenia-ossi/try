const grid = document.getElementById("grid");
const empty = document.getElementById("empty");
const count = document.getElementById("count");

async function render() {
  const { images = [] } = await chrome.storage.local.get("images");
  grid.innerHTML = "";
  empty.style.display = images.length ? "none" : "block";
  count.textContent = images.length ? `Сохранено: ${images.length}` : "";
  for (const item of images) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <img src="${item.src}" alt="" loading="lazy" />
      <button class="del" title="Удалить">×</button>
      <a href="${item.pageUrl}" target="_blank" title="${item.pageUrl}">${hostOf(item.pageUrl)}</a>`;
    card.querySelector(".del").addEventListener("click", () => remove(item.id));
    grid.appendChild(card);
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

async function remove(id) {
  const { images = [] } = await chrome.storage.local.get("images");
  const next = images.filter((i) => i.id !== id);
  await chrome.storage.local.set({ images: next });
  chrome.action.setBadgeText({ text: next.length ? String(next.length) : "" });
  render();
}

document.getElementById("toggle").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "TOGGLE_PICKER_IN_TAB" });
  window.close();
});

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Удалить все сохранённые картинки?")) return;
  await chrome.storage.local.set({ images: [] });
  chrome.action.setBadgeText({ text: "" });
  render();
});

document.getElementById("export").addEventListener("click", async () => {
  const { images = [] } = await chrome.storage.local.get("images");
  const blob = new Blob([JSON.stringify(images, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "clothes-picker.json"; a.click();
  URL.revokeObjectURL(url);
});

chrome.storage.onChanged.addListener(render);
render();
