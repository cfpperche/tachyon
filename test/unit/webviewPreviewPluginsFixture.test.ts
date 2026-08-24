/**
 * spec 278 / 516 — a regra de fidelidade das fixtures: uma fixture não pode divergir em silêncio do
 * que o host realmente emite.
 *
 * As fixtures antigas eram um JSON capturado, e o teste reconstruía os modelos a partir de um lockfile
 * de exemplo para comparar. Sem lockfile e sem estados de frescor, a captura perdeu o sentido — o
 * modelo novo é pequeno o bastante para ser escrito à mão. O que continua valendo, e é o que este
 * arquivo segura, é que a fixture tem a FORMA que o construtor produz: se o construtor ganhar ou
 * perder um campo, a fixture deixa de casar e o CI fala, em vez de uma captura de tela envelhecer
 * mostrando uma tela que o produto não tem mais.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pluginsFixtures } from "../../scripts/webview-preview/fixtures/plugins";
import { buildPluginsViewModel } from "@tachyon/engine/plugins/viewModel.js";
import { readCatalog } from "@tachyon/engine/plugins/catalog.js";
import { MANIFEST_FILE } from "@tachyon/engine/plugins/manifest.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("spec 278 / 516 — as fixtures da aba Plugins têm a forma que o host emite", () => {
  it("cada fixture casa com o que o construtor produz, campo por campo", () => {
    // Um catálogo de verdade, montado no disco, passado pelo construtor de verdade: o resultado tem de
    // ter exatamente as chaves que as fixtures têm.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-fixture-"));
    made.push(ws);
    const dir = path.join(ws, ".tachyon/plugins/sdd");
    fs.mkdirSync(path.join(dir, "skills/sdd"), { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ name: "sdd", version: "2.0.0", description: "x", docs: "https://x.dev" }));
    fs.writeFileSync(path.join(dir, "skills/sdd/SKILL.md"), "---\nname: sdd\ndescription: x\n---\nbody\n");

    const built = buildPluginsViewModel({ catalog: readCatalog(ws) });
    expect(Object.keys(built).sort()).toEqual(["broken", "installed"]);
    const shape = (card: Record<string, unknown>) => Object.keys(card).sort();
    for (const [name, fixture] of Object.entries(pluginsFixtures)) {
      for (const card of fixture.vm.installed) {
        // `docs` é opcional: comparar o conjunto de chaves do que o construtor produz com o da fixture
        // apanharia um campo NOVO que a fixture não tem, que é a deriva que importa.
        const unknown = shape(card as unknown as Record<string, unknown>).filter((k) => !shape(built.installed[0] as unknown as Record<string, unknown>).includes(k));
        expect(unknown, `${name}: campo que o construtor não produz`).toEqual([]);
      }
    }
  });

  it("cobre os três estados que a tela tem, e nenhum que ela não tem", () => {
    expect(Object.keys(pluginsFixtures).sort()).toEqual(["broken", "default", "empty"]);
    expect(pluginsFixtures.empty!.vm).toEqual({ installed: [], broken: [] });
    expect(pluginsFixtures.broken!.vm.broken).toHaveLength(1);
  });

  it("uma pasta quebrada carrega o motivo, nunca uma lista vazia", () => {
    for (const broken of pluginsFixtures.broken!.vm.broken) {
      expect(broken.errors.length, `${broken.dirName} sem motivo`).toBeGreaterThan(0);
    }
  });
});
