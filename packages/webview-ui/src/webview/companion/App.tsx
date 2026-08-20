import { useEffect, useState } from "preact/hooks";
import type { CompanionSettings } from "../../sections/model";
import {
  formatCompanionPairClipboard,
  type CockpitAction,
  type CockpitStrings,
  type CompanionPairOffer,
} from "../shared/control/messages";
import { Badge, Button, EmptyState, PageChrome, Textarea } from "../shared/ui";
const hostsOf = (raw: string) => [
  ...new Set(
    raw
      .split(/[\n,]+/)
      .map((h) => h.trim())
      .filter(Boolean),
  ),
];
function PairCard({
  s,
  offer,
  post,
  wsHash,
}: {
  s: CockpitStrings;
  offer?: CompanionPairOffer;
  post: (a: CockpitAction) => void;
  wsHash: string;
}) {
  const [now, setNow] = useState(Date.now());
  const ok = offer?.ok ? offer : undefined;
  useEffect(() => {
    if (!ok?.expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ok?.expiresAt]);
  if (!offer)
    return (
      <section class="companion-pair-card">
        <p>{s.companionPairQrHint}</p>
        <Button
          variant="primary"
          data-testid="companion-show-pair-code"
          onClick={() => post({ type: "issueCompanionPairCode", wsHash })}
        >
          {s.companionShowPairCode}
        </Button>
      </section>
    );
  if (!ok)
    return (
      <section class="companion-pair-card" data-testid="companion-pair-offer">
        <p>{s.companionPairUnavailable}</p>
        <Button
          onClick={() => post({ type: "issueCompanionPairCode", wsHash })}
        >
          {s.companionNewCode}
        </Button>
      </section>
    );
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(ok.expiresAt) - now) / 1000),
  );
  const expired = seconds === 0;
  const countdown = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const copy = (text: string) => post({ type: "copyText", text });
  return (
    <section class="companion-pair-card" data-testid="companion-pair-offer">
      <div class="companion-pair-heading">
        <div>
          <h2>{s.companionShowPairCode}</h2>
          <p class="companion-muted">
            Scan the QR code or enter the code on the Companion sign-in screen.
          </p>
        </div>
        <span
          class={`companion-expiry ${expired ? "expired" : ""}`}
          data-testid="companion-pair-expires"
        >
          {expired
            ? s.companionPairExpired
            : `${s.companionPairExpires} ${countdown}`}
        </span>
      </div>
      <div class="companion-pair-content">
        {ok.qrDataUrl ? (
          <div class="companion-qr">
            <img
              src={ok.qrDataUrl}
              width={200}
              height={200}
              alt={s.companionPairQrLabel}
              data-testid="companion-pair-qr"
            />
            <span>{s.companionPairQrLabel}</span>
          </div>
        ) : null}
        <div class="companion-pair-details">
          <span class="companion-label">{s.companionPairCodeLabel}</span>
          <code data-testid="companion-pair-code">{ok.code}</code>
          <span class="companion-label">{s.companionPairUrlLabel}</span>
          <code>{ok.baseUrl}</code>
          <p class="companion-muted">{s.companionLanAccessHint}</p>
        </div>
      </div>
      <div class="companion-actions">
        <Button
          disabled={expired}
          onClick={() => copy(ok.code)}
          data-testid="companion-pair-copy-code"
        >
          {s.companionCopyCode}
        </Button>
        <Button
          disabled={expired}
          onClick={() => copy(ok.openUrl ?? ok.baseUrl)}
          data-testid="companion-pair-copy-url"
        >
          {s.companionCopyUrl}
        </Button>
        <Button
          disabled={expired}
          onClick={() => copy(formatCompanionPairClipboard(ok))}
          data-testid="companion-pair-copy-all"
        >
          {s.companionCopyAll}
        </Button>
        <Button
          onClick={() => post({ type: "issueCompanionPairCode", wsHash })}
          data-testid="companion-pair-new-code"
        >
          {s.companionNewCode}
        </Button>
      </div>
    </section>
  );
}
export function CompanionApp({
  companion,
  needsWorkspacePick,
  offer,
  s,
  post,
}: {
  companion?: CompanionSettings;
  needsWorkspacePick?: boolean;
  offer?: CompanionPairOffer;
  s: CockpitStrings;
  post: (a: CockpitAction) => void;
}) {
  const [hosts, setHosts] = useState(companion?.allowedHosts.join("\n") ?? "");
  useEffect(
    () => setHosts(companion?.allowedHosts.join("\n") ?? ""),
    [companion?.wsHash, companion?.allowedHosts.join("\n")],
  );
  return (
    <main class="ds-page companion-root">
      <PageChrome
        title="Companion"
        hint="Pair devices, manage access, and keep trusted connections in view."
      />
      {needsWorkspacePick ? (
        <EmptyState message={s.companionPickWorkspace} />
      ) : !companion ? (
        <EmptyState message={s.empty} />
      ) : (
        <>
          <section class="companion-overview">
            <div>
              <p class="companion-eyebrow">{companion.folderName}</p>
              <h1>Companion access</h1>
              <p class="companion-muted">
                Pair a phone or browser to use Tachyon from your local network.
              </p>
            </div>
            <Badge>
              {companion.paired ? s.companionPaired : s.companionNotPaired}
            </Badge>
          </section>
          <section class="companion-settings">
            <div class="companion-setting-copy">
              <strong>{s.companionTabTools}</strong>
              <span>{s.companionTabToolsHelp}</span>
            </div>
            <input
              type="checkbox"
              checked={companion.tabTools}
              data-testid="companion-tab-tools-toggle"
              onChange={(e) =>
                post({
                  type: "setCompanionTabTools",
                  wsHash: companion.wsHash,
                  enabled: (e.target as HTMLInputElement).checked,
                })
              }
            />
          </section>
          <section class="companion-settings companion-hosts">
            <div class="companion-setting-copy">
              <strong>{s.companionAllowedHosts}</strong>
              <span>{s.companionAllowedHostsHelp}</span>
            </div>
            <Textarea
              class="companion-hosts-input"
              rows={3}
              value={hosts}
              placeholder={s.companionAllowedHostsPlaceholder}
              data-testid="companion-allowed-hosts-input"
              onInput={(e) => setHosts((e.currentTarget as HTMLTextAreaElement).value)}
            />
            <Button
              disabled={
                hostsOf(hosts).join("\n") === companion.allowedHosts.join("\n")
              }
              onClick={() =>
                post({
                  type: "setCompanionAllowedHosts",
                  wsHash: companion.wsHash,
                  hosts: hostsOf(hosts),
                })
              }
              data-testid="companion-allowed-hosts-save"
            >
              {s.companionAllowedHostsSave}
            </Button>
          </section>
          <PairCard s={s} offer={offer} post={post} wsHash={companion.wsHash} />
          <section class="companion-devices">
            <div class="companion-section-heading">
              <div>
                <h2>{s.devicesTitle}</h2>
                <p class="companion-muted">{s.devicesHint}</p>
              </div>
              <span class="companion-count">{companion.devices.length}</span>
            </div>
            {companion.devices.length === 0 ? (
              <EmptyState message={s.devicesEmpty} />
            ) : (
              <ul>
                {companion.devices.map((d) => (
                  <li
                    class="companion-device"
                    data-testid="companion-device-row"
                    key={d.id}
                  >
                    <div>
                      <strong>{d.name}</strong>
                      {d.version ? (
                        <span class="companion-muted"> · {d.version}</span>
                      ) : null}
                      <div class="companion-device-meta">
                        <span>
                          {d.kind === "mobile"
                            ? s.devicesKindMobile
                            : s.devicesKindBrowser}
                        </span>
                        <span class="companion-status">
                          <i class={d.live ? "live" : "offline"} />
                          {d.live ? s.devicesLive : "Paired · offline"}
                        </span>
                        {d.pairedAt ? (
                          <span>
                            {s.devicesPairedAt}{" "}
                            {d.pairedAt.slice(0, 19).replace("T", " ")}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <Button
                      onClick={() =>
                        post({
                          type: "unpairCompanionDevice",
                          wsHash: companion.wsHash,
                          deviceId: d.id,
                        })
                      }
                      data-testid="companion-device-unpair"
                    >
                      {s.devicesUnpair}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
