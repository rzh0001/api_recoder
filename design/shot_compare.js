const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const exe = "C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe";
const file = path.resolve(__dirname, "detail-preview.html");
const url = "file:///" + file.replace(/\\/g, "/");

(async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  const modal = await page.$("#jsonMaxModal");
  const mcls = await page.evaluate(() => document.getElementById("jsonMaxModal").className);
  console.log("modal class:", mcls);
  await modal.screenshot({ path: path.resolve(__dirname, "shot_compare_open.png") });

  const box = async (sel) => {
    const el = await page.$(sel);
    if (!el) return null;
    const b = await el.boundingBox();
    return b;
  };
  const left = await box("#jsonMaxBody");
  const right = await box("#jsonMaxCompareView");
  console.log("LEFT height=", left && left.height, "RIGHT height=", right && right.height);

  // 同步滚动验证：左栏滚到底，右栏应同步
  await page.evaluate(() => {
    const a = document.getElementById("jsonMaxBody");
    a.scrollTop = 9999;
    a.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(150);
  const sync = await page.evaluate(() => {
    const a = document.getElementById("jsonMaxBody");
    const b = document.getElementById("jsonMaxCompareView");
    return { aTop: a.scrollTop, bTop: b.scrollTop };
  });
  console.log("SYNC after left scroll:", JSON.stringify(sync));

  await page.screenshot({ path: path.resolve(__dirname, "shot_compare_full.png") });
  console.log("ERRORS:", errors.length ? errors : "none");
  await browser.close();
})();
