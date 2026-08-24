/**
 * 516 — o que de um plugin pode ser concedido a um agente, e sob que nome.
 *
 * ## O ponto onde o sistema novo encosta no que já existe
 *
 * A entrega não é escrita aqui e nem deveria: o `HarnessManager` já sabe materializar uma capacidade
 * na home de cada runtime, e sabe fazê-lo pelo mecanismo de cada um — argv explícito no pi,
 * supressão por path no codex, `[compat.*]` fechado no grok. O que faltava era só isto: dizer, para
 * um plugin instalado, QUAIS entradas de `references` um perfil precisaria carregar para receber
 * cada pedaço dele.
 *
 * Por isso este módulo é um mapa e não um motor. Um motor novo aqui competiria com a entrega que já
 * funciona, e a spec 515 gastou uma fatia inteira desfazendo exatamente esse tipo de competição.
 *
 * ## Grant sim, grant não — e por que a divisão não é nossa
 *
 * `extensions` e `packages` do pi exigem um grant custodiado pelo host, como skills, MCP e hooks:
 * são CÓDIGO que passa a rodar dentro do agente. `prompts` e `themes` não exigem — são um `.md` e um
 * JSON, validados pela forma e entregues como dado. A divisão está no `agentProfileResolver`
 * (`addPi(..., "prompts", undefined, ...)` passa `undefined` como kind de grant, de propósito), e
 * repeti-la aqui seria criar uma segunda opinião sobre a mesma pergunta. Este módulo só relata.
 *
 * ## A porta de perfil do grok é só de skills, e este mapa tem de dizer isso
 *
 * O `agentProfileResolver` recusa pelo nome todo grant de MCP ou hook num perfil grok:
 * *"Grok profile projection supports exact captured skills only; MCP, hooks and Pi resources have
 * separate runtime doors"*. Este módulo oferecia os dois assim mesmo, então o Agent Studio mostrava
 * ao humano uma concessão que o launch ia sempre reter. Não era falha silenciosa — a retenção tem
 * diagnóstico visível — mas era uma promessa que a outra camada não cumpre, e escolher entre relatar
 * e prometer não é escolha: este módulo relata.
 *
 * Medido em 2026-08-24 varrendo os três runtimes com hook: claude entrega e dispara, codex entrega e
 * dispara (depois da correção de ordem do TOML no mesmo dia), grok recusa. Quando a porta de perfil
 * do grok aprender MCP e hook, é `GROK_PROFILE_DOOR_KINDS` que muda — e o caso de unidade que trava
 * este acordo falha até que as duas camadas voltem a concordar.
 */
import { inspectCapabilitySourceAtRoot } from "../config/agentCapabilitySource.js";
import { CAPABILITY_KINDS, type CapabilityKind, type LoadedPlugin, type Runtime } from "./manifest.js";
import { PLUGINS_REL } from "./catalog.js";

/** Os `kind` que uma entrada de `references` num perfil de agente aceita, para o que um plugin traz. */
export type ReferenceKind = "skill" | "mcp" | "hook" | "pi-extension" | "pi-prompt" | "pi-theme" | "pi-package";

/**
 * O que a porta de PERFIL do grok aceita hoje, espelhando `agentProfileResolver`.
 *
 * Não é preferência nossa: é o que aquela camada implementa. Ligar um destes aqui sem ensinar a
 * porta correspondente reintroduz exatamente a promessa não cumprida que isto veio remover.
 */
const GROK_PROFILE_DOOR_KINDS = { mcp: false, hook: false } as const;

const REFERENCE_KIND_OF: Record<CapabilityKind, ReferenceKind> = {
  skill: "skill",
  extension: "pi-extension",
  prompt: "pi-prompt",
  theme: "pi-theme",
  package: "pi-package",
};

/** Uma capacidade que um perfil pode declarar para receber. */
export interface GrantableReference {
  /** o id estável dentro do perfil — o nome da capacidade. */
  id: string;
  kind: ReferenceKind;
  /** `plugin:<nome>`, que é como a tela sabe que a concessão veio de um plugin e de qual. */
  owner: string;
  /** caminho relativo à raiz do workspace. */
  path: string;
  /** os runtimes que sabem consumir esta capacidade. */
  runtimes: Runtime[];
}

/** Tudo o que este plugin oferece, em ordem estável. */
export function grantableReferences(plugin: LoadedPlugin): GrantableReference[] {
  const owner = `plugin:${plugin.manifest.name}`;
  const rel = (inner: string) => `${PLUGINS_REL}/${plugin.manifest.name}/${inner}`;
  const served = new Set(plugin.runtimes);
  const narrow = (runtimes: readonly Runtime[]): Runtime[] => runtimes.filter((rt) => served.has(rt));

  const out: GrantableReference[] = [];
  for (const capability of plugin.capabilities) {
    const runtimes = narrow(CAPABILITY_KINDS[capability.kind].runtimes);
    if (runtimes.length === 0) continue; // o autor estreitou `runtimes` e deixou esta família de fora
    out.push({
      id: capability.name,
      kind: REFERENCE_KIND_OF[capability.kind],
      owner,
      path: rel(capability.rel),
      runtimes,
    });
  }
  for (const [runtime, hookRel] of Object.entries(plugin.hooks) as Array<[Runtime, string]>) {
    if (!served.has(runtime)) continue;
    if (!GROK_PROFILE_DOOR_KINDS.hook && runtime === "grok") continue;
    out.push({ id: `${plugin.manifest.name}-hooks-${runtime}`, kind: "hook", owner, path: rel(hookRel), runtimes: [runtime] });
  }
  if (plugin.mcp) {
    const runtimes = narrow(GROK_PROFILE_DOOR_KINDS.mcp ? ["claude", "codex", "grok"] : ["claude", "codex"]);
    if (runtimes.length > 0) out.push({ id: `${plugin.manifest.name}-mcp`, kind: "mcp", owner, path: rel("mcp.json"), runtimes });
  }
  return out;
}

/**
 * O digest que uma reference fixada precisa declarar.
 *
 * **Não é um número nosso.** A primeira versão deste arquivo calculava o próprio hash da árvore, o
 * que teria produzido uma concessão que a autorização recusaria no launch por `digest-mismatch` —
 * um plugin instalado e nunca entregue, com a mensagem apontando para o lugar errado. O número que
 * vale é o de `inspectCapabilitySourceAtRoot`, porque é ele que o launch recalcula e compara.
 *
 * A custódia recusa symlink por desenho, então o caminho é resolvido pelo chamador antes de chegar
 * aqui, não aqui — quem resolve tem de saber o que está resolvendo.
 */
export function digestOf(workspaceRoot: string, referencePath: string): string {
  return inspectCapabilitySourceAtRoot(workspaceRoot, referencePath).sha256;
}
