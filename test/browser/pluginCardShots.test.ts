import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveChromeExecutable } from "./support/chrome";
import { startGateServer, type GateServer } from "./support/gateServer";
import { openPreview } from "./support/preview";

/**
 * 516 — o card do plugin, olhado.
 *
 * ÂNCORA: um card responde três perguntas em três níveis de leitura — QUEM é o plugin, O QUE ele faz,
 * O QUE ele traz — e nenhuma delas colada na outra. A primeira versão subiu sem folha de estilo: o
 * nome grudava na versão (`sddv2.0.0`) e os quatro runtimes viravam uma palavra só
 * (`claudecodexgrokpi`). Nada disso é visível numa asserção de DOM, porque `textContent` já era o
 * texto certo — a diferença estava só no espaço entre eles.
 *
 * Por isso este arquivo mede DISTÂNCIAS, além de tirar o retrato: dois elementos irmãos numa linha
 * têm de estar separados, e as ações têm de estar do outro lado do card.
 */
const OUT_DIR = path.resolve(__dirname, "../../.tachyon/visual-qa/516-plugin-card");
const WIDE = { w: 880, h: 700 };
const NARROW = { w: 360, h: 900 };

describe("516 — o card do plugin", () => {
  let server: GateServer;
  let browser: Browser;
  let page: Page;
  const written: string[] = [];

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    server = await startGateServer();
    browser = await puppeteer.launch({ executablePath: resolveChromeExecutable(), headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (written.length) {
      writeFileSync(path.join(OUT_DIR, "README.md"),
        `# O card do plugin (spec 516)\n\nRenderizado por \`test/browser/pluginCardShots.test.ts\` do bundle real.\n\n` +
        `## Âncora\n\nQuem é o plugin, o que faz, o que traz — três níveis de leitura, nenhum colado no outro.\n\n` +
        `Regerar:\n\n\`\`\`sh\nnpm run build\nnpx vitest run --config vitest.browser.config.ts test/browser/pluginCardShots.test.ts\n\`\`\`\n\n` +
        `${written.map((f) => `- \`${f}\``).join("\n")}\n`, "utf8");
    }
  });

  async function shoot(name: string, fixture: string, { w, h }: { w: number; h: number }): Promise<void> {
    await page.setViewport({ width: w + 40, height: h + 40, deviceScaleFactor: 2 });
    const surface = await openPreview(page, server.origin, { query: { view: "plugins", fixture }, width: w, height: h });
    await surface.waitForFunction(() => document.querySelectorAll(".pcard").length > 0, { timeout: 8000 });

    const measured = await surface.evaluate(() => {
      const gapBetween = (a: Element | null, b: Element | null): number => {
        if (!a || !b) return -1;
        const left = a.getBoundingClientRect();
        const right = b.getBoundingClientRect();
        return Math.round(right.left - left.right);
      };
      const card = document.querySelector(".pcard")!;
      const runtimes = [...card.querySelectorAll(".prt")];
      return {
        nameToVersion: gapBetween(card.querySelector(".pname"), card.querySelector(".pver")),
        betweenRuntimes: runtimes.length > 1 ? gapBetween(runtimes[0]!, runtimes[1]!) : -1,
        // As ações vivem do outro lado: a distância entre a versão e o primeiro botão é grande.
        versionToActions: gapBetween(card.querySelector(".pver"), card.querySelector(".pcard-actions")),
        cardWidth: Math.round(card.getBoundingClientRect().width),
        overflow: [...document.querySelectorAll(".pcard *")]
          .filter((e) => e.scrollWidth > e.clientWidth + 1)
          .filter((e) => getComputedStyle(e).textOverflow !== "ellipsis")
          .map((e) => (e.className || e.tagName).toString().slice(0, 40)),
      };
    });

    expect(measured.nameToVersion, `${name}: nome e versão colados`).toBeGreaterThanOrEqual(4);
    if (measured.betweenRuntimes >= 0) {
      expect(measured.betweenRuntimes, `${name}: runtimes colados`).toBeGreaterThanOrEqual(2);
    }
    expect(measured.versionToActions, `${name}: ações disputando a linha do nome`).toBeGreaterThan(24);
    expect(measured.overflow, `${name}: conteúdo estourando o card`).toEqual([]);
    expect(measured.cardWidth, `${name}: card não coube em ${w}px`).toBeLessThanOrEqual(w);

    const file = path.join(OUT_DIR, `${name}.png`);
    await (await page.$("#frame"))!.screenshot({ path: file as `${string}.png` });
    expect(statSync(file).size).toBeGreaterThan(1000);
    written.push(path.basename(file));
  }

  it("desenha os cards instalados a 880", async () => { await shoot("installed-880", "default", WIDE); });
  it("desenha os cards instalados a 360", async () => { await shoot("installed-360", "default", NARROW); });
  it("desenha uma pasta quebrada a 880", async () => { await shoot("broken-880", "broken", WIDE); });
});
