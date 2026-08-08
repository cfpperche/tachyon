# Agent approval as merge authority?

**Task:** `t-8a3d9e`  
**Author:** approvalscan (second wave; first pass: `docs/research/agent-to-trunk-governed-land-ades-t-f85593.md` / `t-f85593`)  
**Date:** 2026-08-08  
**Scope:** research only — no product code, no open SDD  

**Evidence discipline.** Each claim is tagged **Verified** (primary vendor docs, platform docs, or Tachyon source in this tree) or **Marketing / secondary** (blog, roundup, forum, engineering essay). An explicit **Não verificado** list is at the end. Marketing describes intent; it does not prove runtime behavior.

---

## Resposta direta (pergunta central)

**Não achei** arranjo em produção, documentado com evidência primária, em que a **aprovação de um agente de IA** seja o que **autoriza** o merge (i.e. o `APPROVE` do bot conta como *required reviewing approval* e desbloqueia o tronco). Produtos **podem** emitir `APPROVE` (OpenHands, Factory Droid). A plataforma GitHub **pode** fazer o approve de um App/usuário-máquina contar para branch protection se a org permitir. O que falta é o elo do meio: org real que **escolha** o AI bot como reviewer obrigatório. A orientação de engenharia pública em 2026 empurra o contrário: AI review = advisory; humano (ou check determinístico) = gate.

---

## 0. O que o primeiro passe deixou aberto (e o que este doc ataca)

O primeiro passe (`t-f85593`) concluiu que toda AI code review *medida* é **advisory** relativa a branch protection: Copilot é Comment-only e não conta como approval obrigatório; Claude Code Review check é neutro; Cursor Bugbot comenta; OpenHands *pode* emitir `APPROVE`/`REQUEST_CHANGES`, e só bloqueia se a política do forge tratar aquele bot como reviewer obrigatório.

Este passe **não re-mede** esses produtos. Ataca:

1. **Item 9** — o APPROVE de bot (OpenHands e análogos) é usado como reviewer **obrigatório** em orgs reais?  
2. **Item 11 + extras do brief** — seis produtos não medidos no primeiro passe: Factory (Droids), Amp (Sourcegraph spin-out), Google Jules, Google Antigravity, Graphite Diamond / Graphite Agent, Windsurf.  
3. **Pergunta nova** — existe **autoridade graduada** (trivial auto-land; substantivo exige humano)?

**Contexto de produto Tachyon (Verified, este tree):** `src/worktree/land.ts` checa pré-condições e **mostra** o comando; o produto se recusa a executar merge. A pergunta aberta de `t-7cb971` é se o produto deveria apertar o botão sob comando humano.

---

## 1. Item 9 — bot APPROVE como reviewer obrigatório em orgs reais?

### 1.1 O que a plataforma permite (Verified)

| Camada | Comportamento | Evidência |
|--------|---------------|-----------|
| **Copilot code review** | Sempre deixa *Comment*; **não** conta para required approvals; **não** bloqueia merge | [GitHub Copilot code review docs](https://docs.github.com/copilot/using-github-copilot/code-review/using-copilot-code-review) |
| **Required reviews** (branch protection) | Precisa de N approving reviews de reviewers com write | [About protected branches](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches) |
| **github-actions[bot] + `GITHUB_TOKEN`** | Aprovações desse actor **não** contam para required reviews (proteção contra self-approve via workflow). Org pode ter tido/ainda tem setting histórico "Allow GitHub Actions reviews to count towards required approval" — o default e o naming mudaram ao longo do tempo | [GitHub changelog 2022-01-13](https://github.blog/changelog/2022-01-13-github-actions-prevent-github-actions-from-approving-pull-requests/); [community #181487](https://github.com/orgs/community/discussions/181487) (**M** no detalhe de UI atual, **V** no intent de segurança) |
| **GitHub App / machine user + PAT** | Reviews *podem* contar para merge requirements se a identidade tiver write e a org não desabilitar o caminho | Community staff-style replies em #181487 (**M**); padrão documentado em changelog: o perigo que a política tenta fechar é exatamente “bot approve conta” |

**Leitura:** a plataforma **não proíbe** que um bot com identidade própria (App ou user machine) seja o approving review que desbloqueia o merge. Ela **dificulta** o caminho barato (`GITHUB_TOKEN` / `github-actions[bot]`) e trata Copilot como cão de guarda sem dente de approval.

### 1.2 O que os produtos de AI review *oferecem* (Verified)

| Produto | Emite `APPROVE`? | O produto *afirma* que isso autoriza merge? |
|---------|------------------|---------------------------------------------|
| **OpenHands** (GHA + Automation) | **Sim** — prompt de automation: `APPROVE` / `REQUEST_CHANGES` / `COMMENT`; bot account dedicado | **Não.** O produto oferece o *evento*; a política do forge decide se conta. Docs ensinam a pedir o bot como *reviewer* (on-demand), não como CODEOWNERS obrigatório | V: [OpenHands automated code review](https://docs.openhands.dev/openhands/usage/use-cases/code-review) |
| **Factory Droid Review** | **Sim** — “Submits an approval when no issues are found” | **Não.** Documenta comments + approval; não documenta “configure-me as required reviewer” | V: [Factory automated code review](https://docs.factory.ai/software-factory/code-review-ci) |
| **Copilot / Claude Code Review / Bugbot / Windsurf PR Reviews / Graphite AI reviews** | Não (Comment / neutral check / comments) ou não documentado como approval event | Explicitamente advisory ou silêncio sobre required review | V (primeiro passe + docs desta rodada) |

OpenHands ainda documenta, no skill de guidelines customizadas, **quando** o modelo *deveria* APPROVE (config, docs-only, test-only) vs COMMENT — isso é **graduação de veredito do modelo**, não autoridade de forge.

### 1.3 Orgs reais: o que procurei e o que **não** achei

**Procurei (queries + fontes):**

- `CODEOWNERS` + OpenHands / openhands-agent / Factory / Droid / Claude bot / AI  
- Engineering posts “AI bot as required reviewer”  
- Branch protection screenshots/public policies naming an AI bot as the sole required approval  
- FullStory-class “bot is the only member of the reviewer team” patterns, filtered for *AI* judgment  

**Achei (padrão pré-AI / não-AI judgment):**

- **FullStory (2020):** bot como único membro de times CODEOWNERS — o bot desbloqueia *routing* de review, não julga qualidade de diff com LLM. **M:** [How We Tamed GitHub CODEOWNERS With Bots](https://www.fullstory.com/blog/taming-github-codeowners-with-bots/).  
- **Dependabot / Renovate auto-merge:** bots *executam* merge de classes de mudança (patch/minor) após checks — autoridade é **classe de mudança + CI**, não “o modelo APPROVE-ou”. **M** (ecosystem patterns amplamente documentados).  
- **Community workflows:** “dois bots: um abre, outro aprova” para contornar self-approve — automation theatre, não AI review. **M:** [community #14866](https://github.com/orgs/community/discussions/14866).

**Achei (orientação *contra* AI-as-required-approver):**

- Setup guides de Claude-as-PR-reviewer: *“Don’t let claude[bot] count as a required reviewer… AI review is advisory; the merge gate is human.”* **M:** [sph.sh Claude PR reviewer setup](https://sph.sh/en/posts/claude-code-action-pr-reviewer-setup/).  
- Third-party Factory writeup: *“Keep human merge authority… Resist auto-merge based on review droid approval alone.”* **M:** [digitalapplied Factory review 2026](https://www.digitalapplied.com/blog/factory-ai-multi-agent-coding-platform-review).  
- GitHub community feature request on hybrid human/AI review: *“AI agents cannot count as human reviewers”* (compliance framing). **M:** [discussion #197170](https://github.com/orgs/community/discussions/197170).

**Não achei:**

- Repositório público com `CODEOWNERS` listando `openhands-agent`, Factory Droid App, ou Claude bot como owner *obrigatório* com branch protection “require code owner review”.  
- Post-mortem ou engineering blog de empresa nomeada: “we made the AI bot our required approver and that is our merge gate.”  
- Política de org open-source grande (Kubernetes, etc.) tratando AI APPROVE como approval de merge.

### 1.4 Veredito no item 9

| Afirmação | Status |
|-----------|--------|
| Produtos de AI review *podem* emitir eventos de approve | **Verified** (OpenHands, Factory) |
| GitHub *pode* contar approve de App/machine user | **Verified** (plataforma) / parcialmente **M** nos detalhes de setting atual |
| Orgs reais usam AI APPROVE como *required* reviewer em produção | **Não achei** |
| Orgs *deveriam* (marketing / blog) | **M** e frequentemente **contra** |

**Isso é um achado, não um buraco silencioso:** a *capability* existe; a *prática documentada* de usá-la como autoridade de merge para AI **não**. O primeiro passe estava certo no padrão; este passe fecha o “mas e se alguém configurar?” com: **tecnicamente possível, empiricamente não documentado como prática, e a cultura de eng em 2026 desaconselha.**

**Refutação em voz alta:** se amanhã uma org publica CODEOWNERS + App do Factory como único required approver, *esse* caso derruba a recomendação de “nunca tratar AI approve como gate”. Até lá, o peso da evidência não autoriza construir Tachyon em cima de “AI approved → safe to land.”

---

## 2. Seis produtos novos — as mesmas cinco perguntas

Legend: **V** = primary docs; **M** = marketing/secondary; **—** = not verified.

### 2.1 Tabela resumo

| Tool | Who runs merge? | What is asserted before merge is offered / safe? | Agent review: block or advise? | Conflict behavior | Work always a PR? |
|------|-----------------|--------------------------------------------------|--------------------------------|-------------------|-------------------|
| **Factory (Droids)** | Human merges (forge or local). Product surfaces “review the diff, and merge” — does **not** claim product-owned trunk mutation as the default land door. **V** quickstart + **M** marketing | Review droid posts inline comments; **approves when clean**. Normal forge rules apply if PR exists. **V** | Review is **advise** by default; **can** post GitHub approval event. Blocking only if forge policy treats that identity as required. Product does **not** document “we are your required reviewer.” **V** + **M** | Not primary-doc measured as auto-resolve. **—** | Code droid produces **merge-ready diffs / PRs** as the delivery story; local CLI also works. “Always PR” not fully verified. **M/V** mix |
| **Amp** (ex-Sourcegraph; ampcode.com) | **Configurable:** Changes Workflow **Ship** = commit+push to `origin/main`; **Push to Branch** = branch (+ PR URL on GitHub); **Custom Ship**. Human configures; agent can *execute* the ship path. **V** | Local/agent: `amp review`, checks, Oracle, tests per `AGENTS.md`. No Tachyon-style tree-keyed verify. Forge protection still applies if you use PR path. **V** | Code review (`amp review` / CRA GitHub) is **advise**. Ship-to-main is **not** “AI approved the PR” — it is **skip the PR gate** by project policy. **V** | Not primary-doc measured. **—** | **No.** Ship can go straight to main; PR is one of three workflow modes. **V** |
| **Google Jules** | **Human** merges the PR on GitHub. Marketing: “Approve the PR, merge…” **V** (product site) | Plan + diff shown to human; cloud VM + tests (product claims). Forge CI on the PR. **V/M** | Jules is primarily an **author** agent, not a required approver. Third-party “Jules PR Reviewer” Action can post comments and optionally gate via **status check** (not required-reviewer APPROVE). **M** for marketplace action | Not primary-doc measured. **—** | **Yes in the product story** — async task → PR. Issue label `jules` assigns work. **V** |
| **Google Antigravity** | Local IDE/agent platform; human owns git / PR / merge in measured docs. **V** artifacts + artifact-review docs | **Artifacts** (plans, task lists, walkthroughs, screenshots, recordings) for human review. Artifact Review Policy: Request Review (halt) vs Always Proceed. **V** | **Human-in-the-loop on plans/edits**, not forge required-reviewer. AI does not become GitHub approving authority. **V** | Local agent can be steered; forge conflict path **—** | **Not necessarily.** Local agent-first IDE; PR is a later human step in secondary writeups. **M/V** |
| **Graphite Diamond → Graphite Agent** | Human / Graphite merge queue merges under forge rules. Graphite is a **PR workflow** platform (stack + merge queue). **V/M** | AI reviews every PR; comments + suggested fixes. Stack readiness / merge queue. **V** | **Advise.** Graphite publicly framed Diamond as not replacing human code review (**M** press). No primary doc that Diamond APPROVE satisfies required reviews. | Stack-aware merge queue reduces conflict friction; ordinary conflict auto-resolve **—** | **Yes** — product is PR/stack-centric. **V** |
| **Windsurf** (Cascade + PR Reviews; Cognition/Devin family) | Human. Cascade: per-step **diff staging** before disk. PR Reviews: comments on GitHub. Docs now **recommend Devin Review** for AI PR review. **V** | Local: staged diffs. PR Reviews: comment feedback. Devin Review (sibling): mergeability + required checks (first pass). **V** | **Advise** (GitHub review comments). Limits: 50 files/PR, 500 reviews/org/month (beta). **V** | Not primary-doc measured for Cascade. **—** | Cascade can stay local; cloud/PR reviews are opt-in. **V/M** |

### 2.2 Factory (Droids) — deep enough for the five questions

**Verified** from [docs.factory.ai automated code review](https://docs.factory.ai/software-factory/code-review-ci) and [Factory App quickstart](https://docs.factory.ai/factory-app/quickstart):

1. **Merge executor:** Human. Quickstart: “review the diff, and merge from the App or your terminal.” No “Droid clicks Merge for you as principal” as the documented default.  
2. **Asserted:** Review workflow on PR open/sync: bug/security/correctness analysis; inline comments; **approval when no issues**. Draft PRs skipped. Depth `deep`/`shallow`. Not: tree-keyed local verify.  
3. **Agent review:** Posts as Factory Droid GitHub App (or caller token). Approval event exists. **Does not** document itself as required branch-protection reviewer. Secondary writeups explicitly warn against auto-merge on droid approval alone (**M**).  
4. **Conflict:** **—** not measured in primary docs this session.  
5. **PR always?:** Delivery story is PR/MR-oriented for CI review; local `/review` exists pre-push. Exact “always open PR” **not fully verified**.

**Between agent and trunk:** same forge-PR sandwich as peers, with a Review Droid that is unusually honest about submitting **Approve** when clean — still **policy-gated**, not product-as-authority.

### 2.3 Amp

**Verified** from [ampcode.com/manual](https://ampcode.com/manual):

1. **Merge executor:** Depends on **Changes Workflow**. **Ship** pushes to `origin/main` — the *agent executes* the land that other tools refuse or leave to forge Merge. That is **execution authority under human project config**, not “AI review authorized the merge.”  
2. **Asserted:** Whatever the human put in `AGENTS.md`, checks under `.agents/checks/`, Oracle review, tests. No product-owned fail-closed land probe like Tachyon.  
3. **Review:** `amp review` / CRA GitHub app: **advise**.  
4. **Conflict:** **—**  
5. **PR:** Optional. Three modes: Ship main / Push branch (+PR URL) / Custom.

**Implication for Tachyon:** Amp is the clearest measured peer of “agent can touch trunk” — and it does it by **bypassing** the PR-approval metaphor, not by making AI approval *mean* merge authority.

### 2.4 Google Jules

**Verified** from [jules.google](https://jules.google/):

1. Human merges PR.  
2. Plan → human “Continue” → diff → PR → human approve/merge.  
3. Author agent, not required approver. Marketplace “Jules PR Reviewer” (**M**) can post comments + optional **status check** gate — same pattern as Claude neutral check / “wire your own gate.”  
4. Conflict **—**  
5. Product story ends at **PR**.

### 2.5 Google Antigravity

**Verified** from [Artifact Review docs](https://antigravity.google/docs/artifact-review) and [Artifacts](https://antigravity.google/docs/artifacts):

1. Human remains principal for land; platform is local agent IDE.  
2. Artifacts + optional halt before edits. **Always Proceed** removes mid-flight review, not forge required-reviewer.  
3. Advisory / human gate on artifacts — **not** GitHub APPROVE-as-authority.  
4. Conflict **—**  
5. PR not mandatory in product model (**M** for “Human review + PR + merge” tutorials).

### 2.6 Graphite Diamond / Graphite Agent

**Verified** [graphite.com/docs/ai-reviews](https://graphite.com/docs/ai-reviews); **M** press (Diamond launch: “AI will never replace human code review”); brand shift Diamond → Graphite Agent after Cursor acquisition (**M**).

1. Human + merge queue under forge.  
2. AI comments on every PR; stack/merge-queue mechanics.  
3. **Advise.**  
4. Stack merge queue; ordinary conflict auto-resolve **—**  
5. **Always PR/stack.**

### 2.7 Windsurf

**Verified** [Windsurf PR Reviews](https://docs.devin.ai/desktop/windsurf-reviews/windsurf-reviews) (now points teams to **Devin Review**):

1. Human.  
2. Comments on PR; Cascade stages local diffs for human accept.  
3. **Advise** only in measured docs.  
4. **—**  
5. Local default for Cascade; PR review is org-installed bot.

---

## 3. Autoridade graduada — existe?

**Pergunta:** algum produto permite o agente landar mudança **trivial** sozinho (docs, lockfile, bump) e exige humano para mudança **substantiva**? Ou é tudo-ou-nada?

### 3.1 O que existe (e o que *não* é)

| Padrão | Gradua o quê? | É “AI APPROVE autoriza merge”? | Evidência |
|--------|---------------|--------------------------------|-----------|
| **Dependabot / Renovate auto-merge** por severidade (patch/minor) | Classe de *mudança de dependência* + CI verde | **Não** — bot de supply-chain, não AI code-review authority | **M** (ecosystem) |
| **Amp Changes Workflow** Ship vs Branch vs Custom | **Projeto inteiro** (ou custom prompt) — não “se for docs, ship; se for auth, PR” no produto | **Não** — é execute-or-PR, não approve-or-not | **V** Amp manual |
| **Antigravity** Fast vs Planning; Request Review vs Always Proceed | *Como* o agente edita localmente | **Não** — não é gate de merge no forge | **V** |
| **OpenHands custom review guidelines** “APPROVE docs/config/tests” | Veredito do *reviewer* agent | Só vira autoridade se a org tornar o bot required — **não achei** org que faça | **V** guidelines capability; **não achei** production required-reviewer use |
| **Path-based CODEOWNERS** (human teams) | Quem *humano* deve aprovar por path | Não é AI | **V** GitHub platform |
| **gitStream / policy engines** (terceiros) | Automações approve+merge em regras (e.g. Dependabot) | Automation, não AI judgment as principal | **M** |
| **“AI review as required status check”** (generic CI guides) | Check passa/falha | **Sim parcialmente** — mas o gate é **check/CI**, não o *review event* “APPROVE” de um reviewer. O humano (ou auto-merge) ainda pressiona merge quando o check está verde | **M** (guides) + **V** pattern de Claude “parse severity in your CI” (primeiro passe) |

### 3.2 Veredito em autoridade graduada

**Não achei** produto ADE medido nesta rodada que, como *feature de primeira classe documentada*, diga:

> o agente pode landar sozinho mudanças triviais; mudanças substantivas exigem humano — e isso é enforced pelo produto.

O que existe é:

1. **Tudo-ou-nada por projeto** (Amp Ship main vs PR).  
2. **Graduação de *revisão local*** (Antigravity halt vs proceed).  
3. **Graduação de *classe de mudança* por bots não-LLM** (Dependabot).  
4. **Graduação de *veredito* no prompt** (OpenHands “when to APPROVE”) sem enforcement de forge.  
5. **Graduação via status check** (AI CI job required) — o gate é o check, não o reviewer identity.

Para Tachyon / `t-7cb971`: se o produto quiser autoridade graduada, **não há um concorrente honesto para copiar**. Teria que inventar a regra (ex.: paths allowlisted + verify record + human-only for `src/`) — e ainda assim isso é **política local de land**, não “AI approved.”

---

## 4. O primeiro passe estava errado em algum lugar?

**Refutação em voz alta.**

| Afirmação do primeiro passe | Esta rodada |
|-----------------------------|-------------|
| Toda AI review *medida* é advisory relativa a branch protection | **Mantém.** Acrescenta: Factory e OpenHands *emitem* APPROVE, mas isso não vira autoridade sem config de forge que **não achei** em produção documentada. |
| Blocking é sempre config extra (required check / required human / required bot) | **Mantém.** Required *status check* de AI é o caminho semi-real de “AI can block”; required *reviewer identity* de AI **não achei** em uso documentado. |
| “AI approved → safe to land” é theatre ou mentira | **Mantém**, com nuance: **Ship-to-main** (Amp) e **auto-merge Dependabot** são caminhos reais de trunk mutation sem human click no merge box — mas o principal ainda é **política humana pré-configurada**, não o julgamento do modelo no momento do approve. |
| Vale copiar delivery inbox + evidence, não AI-as-required-approver | **Mantém.** Nenhum dos seis produtos novos inverte isso. Amp’s Ship is the closest “agent touches trunk,” and it *avoids* the approval metaphor. |

**Único achado que *poderia* ter derrubado a recomendação:** org pública com AI bot como required CODEOWNERS/approver. **Não achei.**

**Achado próximo (não derruba):** Factory e OpenHands documentam APPROVE events — a *arma* existe. A *política de não usá-la como unique gate* parece ser a norma.

---

## 5. Implicação para Tachyon (`t-7cb971`)

| Opção de produto | O que a indústria faz | Risco se Tachyon copiar mal |
|------------------|----------------------|-----------------------------|
| **Human always principal; product never merges** (hoje) | Minoria; Tachyon e a maioria dos agents *locais* | Friction; owner dependence for logistics (first pass) |
| **Human click Merge via forge API** (Devin/Cursor pattern) | Maioria ADE cloud | Esquece primary-on-trunk / tree-keyed verify |
| **Agent Ship to main** (Amp option) | Minority product mode | Remove review object entirely; needs trust in agent+config |
| **AI APPROVE as required reviewer** | **Capability exists; production use not found** | Theatre de compliance; self-approve laundering; contradiz orientação eng 2026 |
| **AI as required *status check*** | Documented pattern | Honest if the check is deterministic enough; still not “approval authority” of a reviewer |
| **Graduated land by path/risk** | Dependabot-class only for deps; not ADE-native for general code | Open design problem — no clean competitor blueprint |

**Bottom line for the open product question:** nothing measured in this wave forces Tachyon to treat agent approval as merge authority. The honest competitive options remain: better **human delivery door** (evidence + one act), optional **advisory** AI review, or a deliberate **human-configured** auto-land policy (Amp-like Ship) that does **not** pretend the model “approved.”

---

## 6. Não verificado (lista explícita)

1. Live branch protection JSON / settings of any named company with OpenHands, Factory Droid, or Claude bot as **required** reviewer or CODEOWNER.  
2. Whether Factory Droid GitHub App approvals **currently count** toward required reviews on a default org (depends on identity + org Actions settings; not re-probed live).  
3. Whether OpenHands Cloud Automation bot accounts are commonly added to CODEOWNERS in private orgs (private by definition — **não achei** public proof).  
4. Exact GitHub org setting string names as of today for “Actions may approve PRs” after UI renames (changelog history is Verified; live UI not clicked).  
5. Amp **Ship** to `origin/main` behavior under real branch protection (does push fail? does it open PR fallback?) — manual documents the setting; live protection interaction **—**.  
6. Google Jules internal auto-merge or required-check product features beyond marketing site + third-party Actions.  
7. Antigravity 2.0 multi-agent deploy claims as land authority (marketing / forum only).  
8. Graphite Agent (post-Diamond) submitting formal GitHub `APPROVE` events vs comments-only.  
9. Windsurf Cascade auto-push to default branch without human accept of staged diffs.  
10. Replit Agent (named in board task text; **not** in the six-product brief table) — **not measured** this session.  
11. Frequency statistics (“X% of orgs use bot required reviewers”) — **não inventei número; não achei**.  
12. Live click of any Merge / Ship / Approve path on vendor accounts (docs only, as first pass).  
13. Whether any product tree-keys CI the way Tachyon tree-keys verify records (still open from first pass).  
14. Cost models for any of the six products as decision inputs.

---

## 7. Fontes (primárias primeiro)

| Source | Use |
|--------|-----|
| This tree: `src/worktree/land.ts` | Tachyon refuse-to-merge baseline |
| First pass: `docs/research/agent-to-trunk-governed-land-ades-t-f85593.md` | Do not re-measure; frame holes |
| [OpenHands automated code review](https://docs.openhands.dev/openhands/usage/use-cases/code-review) | APPROVE/REQUEST_CHANGES capability; bot account |
| [Factory Droid automated code review](https://docs.factory.ai/software-factory/code-review-ci) | Approval when clean; inline comments |
| [Factory App quickstart](https://docs.factory.ai/factory-app/quickstart) | Human merge stance |
| [Amp Owner’s Manual](https://ampcode.com/manual) | Ship / Push to Branch / review / checks |
| [Jules product site](https://jules.google/) | PR delivery; human merge |
| [Antigravity Artifact Review](https://antigravity.google/docs/artifact-review) | Request Review vs Always Proceed |
| [Graphite AI reviews](https://graphite.com/docs/ai-reviews) | Advisory AI reviews |
| [Windsurf PR Reviews](https://docs.devin.ai/desktop/windsurf-reviews/windsurf-reviews) | Comment reviews; Devin Review pointer |
| [GitHub Copilot code review](https://docs.github.com/copilot/using-github-copilot/code-review/using-copilot-code-review) | Comment-only; does not count |
| [GitHub protected branches](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches) | Required reviews model |
| [GitHub changelog: prevent Actions approving PRs](https://github.blog/changelog/2022-01-13-github-actions-prevent-github-actions-from-approving-pull-requests/) | Platform refuses cheap bot self-approve |
| Community #181487, #197170; FullStory CODEOWNERS bots; sph.sh Claude reviewer guide; digitalapplied Factory essay | **M** — culture + workarounds, not production proof of AI-as-required-approver |

---

## 8. One-paragraph bottom line

A autoridade de merge continua com **humano + política de forge/CI** (ou com **política humana pré-configurada** que manda o agente shipar para main, como Amp). Dois produtos (OpenHands, Factory) **sabem dizer APPROVE**; a plataforma GitHub **pode** contar esse APPROVE se a identidade e a org cooperarem. **Não achei** org de produção que documente o AI bot como o reviewer obrigatório que *autoriza* o merge. Autoridade **graduada** por trivial-vs-substantivo **não** é feature nativa dos ADEs medidos — só ecoa em Dependabot-class automation e em settings everything-or-nothing. A recomendação do primeiro passe sobre não copiar “AI approved → safe to land” **não foi refutada**; o achado novo é que a *arma* APPROVE existe e a *prática* de usá-la como unique gate **não** (publicamente).
