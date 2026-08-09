/**
 * Companion Mobile one-QR dogfood (minimal).
 *
 * Prereq: pointer armed at a checkout that serves /companion/app/* + openUrl QR
 * (worktree companion-mobile-one-qr or main once merged), fixture with lanAccess: true,
 * and Tailscale up on the host (`tailscale ip -4`) so pair uses the mesh URL.
 * The phone step rewrites openUrl to 127.0.0.1 for local Chromium (same host as EDH).
 *
 *   scripts/dev-host/cli.sh point --worktree <wt> --fixture companion-track --spec 422 --slug companion-mobile-one-qr
 *   TACHYON_ENGINE_CHANNEL=dev npm run build --prefix <wt>
 *   node scripts/dev-host/headless-interactive.mjs --scenario scripts/dev-host/scenarios/companion-one-qr.mjs
 *
 * Flow: Control → Settings → Show pair code → open openUrl in a mobile viewport page → assert Connected.
 * Skips camera: openUrl is what the phone camera would open. Loopbacks the host so dogfood
 * works without LAN reachability from Chromium.
 */

function toLoopbackOpenUrl(openUrl) {
  const u = new URL(openUrl);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const hash = u.hash || "";
  if (!hash.startsWith("#pair=")) {
    return `http://127.0.0.1:${port}${u.pathname}${u.search}${hash}`;
  }
  let payload;
  try {
    payload = JSON.parse(decodeURIComponent(hash.slice("#pair=".length)));
  } catch {
    return `http://127.0.0.1:${port}/companion/app/${hash}`;
  }
  const loop = `http://127.0.0.1:${port}`;
  payload.baseUrl = loop;
  if (Array.isArray(payload.baseUrls)) {
    payload.baseUrls = [loop, ...payload.baseUrls.filter((x) => x && !/127\.0\.0\.1/.test(x))].slice(0, 8);
  } else {
    payload.baseUrls = [loop];
  }
  return `${loop}/companion/app/#pair=${encodeURIComponent(JSON.stringify(payload))}`;
}

export async function run(ctx) {
  const asserts = [];
  const check = (id, ok, detail) => {
    asserts.push({ id, ok: !!ok, detail: detail ?? "" });
    ctx.log(`${ok ? "ok  " : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
  };

  const clickText = (frame, text) =>
    frame.evaluate((t) => {
      const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim().includes(t));
      if (!el) return { ok: false };
      el.click();
      return { ok: true };
    }, text);

  await ctx.command("Tachyon: Open Control");
  await ctx.sleep(4000);
  const control = await ctx.findWebviewFrame(
    "!!document.querySelector('.ck-tabs') || !!document.querySelector('.ck-root')",
  );
  check("control-open", !!control);
  if (!control) {
    await ctx.shot("no-control");
    return { asserts };
  }

  await clickText(control, "Settings");
  await ctx.sleep(2000);
  await ctx.shot("01-settings");

  // Prefer programmatic click — more reliable than text match races.
  const showed = await control.evaluate(() => {
    const btn = document.querySelector("[data-testid='companion-show-pair-code']");
    if (!btn) return { ok: false, reason: "no show-pair-code button" };
    btn.click();
    return { ok: true };
  });
  check("show-pair-code", showed.ok, showed.reason);
  await ctx.sleep(3000);

  const offer = await control.evaluate(() => {
    const openUrl = document.querySelector("[data-testid='companion-pair-open-url']")?.textContent?.trim();
    const code = document.querySelector("[data-testid='companion-pair-code']")?.textContent?.trim();
    const hasQr = !!document.querySelector("[data-testid='companion-pair-qr'] img");
    return { openUrl: openUrl || null, code: code || null, hasQr };
  });
  check("openUrl-present", !!offer.openUrl?.includes("/companion/app/#pair="), offer.openUrl?.slice(0, 100) ?? "missing");
  check("qr-png", offer.hasQr, offer.hasQr ? "img present" : "no qr img");
  check("pair-code", !!offer.code && offer.code.length >= 6, offer.code ?? "none");
  await ctx.shot("02-pair-offer");
  if (!offer.openUrl) return { asserts };

  const phoneUrl = toLoopbackOpenUrl(offer.openUrl);
  ctx.log(`phoneUrl: ${phoneUrl.slice(0, 160)}…`);

  // EDH Electron CDP cannot createTarget — launch host Chrome as the "phone" (puppeteer-core dep).
  let chrome;
  let phone;
  try {
    const { default: puppeteer } = await import("puppeteer-core");
    const chromeBin =
      process.env.TACHYON_DEV_HOST_CHROME ||
      process.env.CHROME_PATH ||
      "/usr/bin/google-chrome-stable";
    chrome = await puppeteer.launch({
      executablePath: chromeBin,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    phone = await chrome.newPage();
    await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await phone.setUserAgent(
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    );
    const res = await phone.goto(phoneUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    check("pwa-http", !!res && res.status() < 400, res ? `status ${res.status()}` : "no response");
    await ctx.sleep(8000);

    const body = await phone.evaluate(() => (document.body?.innerText || "").slice(0, 1500));
    const connected =
      /\bConnected\b/i.test(body) ||
      /Paired with/i.test(body) ||
      !!body.match(/Unpair/);
    const failed = /Auto-pair from QR failed|Pair link missing|Invalid pair/i.test(body);
    check("auto-pair", connected && !failed, connected ? "Connected/Unpair visible" : body.slice(0, 200).replace(/\s+/g, " "));

    const phoneShot = `${ctx.outDir}/03-phone-pwa.png`;
    await phone.screenshot({ path: phoneShot });
    ctx.log(`shot: ${phoneShot}`);
  } catch (err) {
    check("phone-page", false, err instanceof Error ? err.message : String(err));
  } finally {
    try {
      await phone?.close();
    } catch {
      /* ignore */
    }
    try {
      await chrome?.close();
    } catch {
      /* ignore */
    }
  }

  return { asserts };
}
