# Agent Studio canonical field matrix

_Implemented by `t-be11d9` on 2026-07-23._

| Surface | New canonical agent | Existing canonical agent | Authority / disposition |
|---|---|---|---|
| name | writable until first save | rename lifecycle action | canonical identity transaction |
| runtime executable/adapter, role | writable | writable through revisioned CAS | authored profile |
| cwd | writable | writable through revisioned CAS | authored `workspace.cwd` |
| autostart, restart, attention, watch | writable | writable through revisioned CAS | authored `lifecycle` |
| worktree enabled, branch | writable | writable through revisioned CAS | authored `workspace.worktree` |
| transcript/config-home isolation | writable | writable through revisioned CAS | authored `isolation` |
| worktree setup, verification | shown but deferred/read-only | shown but deferred/read-only | require pinned setup/verification references and measured projection |
| persistent instructions | shown but deferred/read-only | shown but deferred/read-only | dedicated pinned instructions binding |
| Soul | dedicated action after save | dedicated lifecycle actions | Soul authority, never ordinary form CAS |
| Agent Evolution | dedicated action after save | approval/rejection actions | stable profile selector plus host freshness head |
| selected memory | no ordinary form control | provenance only | dedicated selected-memory protocol |
| capabilities/harness | legacy-only until binding is measured | counts/provenance only | capability references and grants |
| environment, secrets | not exposed as values | names/counts only | secrets and derived values never cross Studio snapshot |
| workspace guidance, plugins | not editable | provenance/external scope only | workspace-owned external dependencies |
| host authority/runtime projection | not editable | read-only cards | host/runtime custody |

The canonical mutation schema contains only the writable authored rows. Deferred, dedicated and
read-only rows cannot be serialized accidentally because they are absent from `editable`.
