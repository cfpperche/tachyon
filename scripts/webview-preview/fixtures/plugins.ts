/**
 * spec 278 / 516 — as fixtures da aba Plugins para o harness de preview.
 *
 * Procedência: construídas pelo MESMO construtor puro que o host usa (`buildPluginsViewModel`), a
 * partir de catálogos escritos à mão. `webviewPreviewPluginsFixture.test.ts` reconstrói a partir dos
 * mesmos catálogos e compara, então uma mudança de forma do construtor quebra o CI em vez de fazer uma
 * captura de tela mentir devagar.
 *
 * 516 — as fixtures antigas eram um JSON capturado com seis estados de frescor (`update-available`,
 * `source-changed`, …). Nenhum deles existe: sem origem remota não há frescor a exibir. Sobraram os
 * três estados que a tela realmente tem — o que está instalado, o vazio, e uma pasta que não carrega.
 */
import type { PluginsViewModel } from "@tachyon/engine/plugins/viewModel.js";
import type { Fixture } from "../routes";

const installed: PluginsViewModel = {
  installed: [
    {
      name: "sdd",
      version: "2.0.0",
      description: "spec-driven development: intent before code, in living documents",
      docs: "https://github.com/cfpperche/tachyon-plugins",
      runtimes: ["claude", "codex", "grok", "pi"],
      capabilities: [
        { kind: "skill", names: ["sdd"], label: "1 skill" },
        { kind: "prompt", names: ["nova-spec"], label: "1 prompt" },
      ],
      requires: [],
    },
    {
      name: "visual-qa",
      version: "1.4.0",
      description: "render a surface and look at it before shipping",
      runtimes: ["claude", "codex", "grok"],
      capabilities: [
        { kind: "skill", names: ["visual-qa"], label: "1 skill" },
        { kind: "hooks", names: [], label: "hooks for claude, codex" },
        { kind: "mcp", names: [], label: "an MCP server" },
      ],
      // Uma medida e uma não: a tela precisa mostrar as duas sem afirmar nada sobre a segunda.
      requires: [{ name: "chromium", present: false }, { name: "ffmpeg" }],
    },
  ],
  broken: [],
};

export const pluginsFixtures: Record<string, Fixture<PluginsViewModel>> = {
  default: { provenance: "captured-host-vm", vm: installed },
  empty: { provenance: "captured-host-vm", vm: { installed: [], broken: [] } },
  // Uma pasta que não carrega aparece COM o motivo — sumir em silêncio faria o humano procurar um
  // plugin que está lá e não pôde ser lido.
  broken: {
    provenance: "captured-host-vm",
    vm: {
      installed: [installed.installed[0]!],
      broken: [{ dirName: "meio-baixado", errors: ["no tachyon-plugin.json — this directory is not a plugin"] }],
    },
  },
};
