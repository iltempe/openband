// Publishing in the Release tab (G6): the accounts (keys or a sign-in, kept by the local OpenBand), the
// platforms to send the song to, progress and what went out; and the confirmation every publish waits for.
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useT } from "../i18n";
import { useBridge, onPublishAuthorized } from "../bridge";
import { runCommand } from "../commands";
import { LICENSES, type LicenseCode } from "../publish/license";
import { platformById, ccTargets } from "../publish/check";
import { releaseOf } from "../publish/release";
import {
  SUPPORTED,
  usePublish,
  refreshTargets,
  saveCredentials,
  forgetAccount,
  authorizeUrl,
  type ServerTarget,
} from "../publish/publish";

const notify = (e: unknown) => useStore.getState().notify((e as Error).message);

function Account({ t: target }: { t: ServerTarget }) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(!target.configured);
  return (
    <li className="pub-account">
      <b>{target.name}</b>{" "}
      <span className={`en-badge ${target.authorized ? "lic-yes" : "lic-no"}`}>
        {target.authorized
          ? t("pub.ready")
          : target.configured
            ? t("pub.signIn")
            : t("pub.notSet")}
      </span>{" "}
      <button className="mini" onClick={() => setOpen(!open)}>
        {open ? t("pub.hide") : t("pub.edit")}
      </button>
      {open && (
        <div className="pub-fields">
          {target.fields.map((f) => (
            <label key={f.key} className="rel-field">
              {f.label}
              <input
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={f.set ? (f.secret ? "••••••" : f.value) : ""}
                defaultValue={f.secret ? "" : f.value}
                onChange={(e) =>
                  setValues({ ...values, [f.key]: e.target.value })
                }
                onKeyDown={(e) => e.stopPropagation()}
              />
            </label>
          ))}
          {target.redirect_uri && (
            <p className="ca-note">
              {t("pub.redirect")} <code>{target.redirect_uri}</code>
            </p>
          )}
          <div className="row">
            <button
              className="btn"
              onClick={() =>
                saveCredentials(target.id, values).then(
                  () => setValues({}),
                  notify,
                )
              }
            >
              {t("pub.save")}
            </button>
            {target.auth === "oauth" && target.configured && (
              <button
                className="btn"
                onClick={() =>
                  authorizeUrl(target.id).then(
                    (u) => window.open(u, "_blank", "width=720,height=800"),
                    notify,
                  )
                }
              >
                {t("pub.signInBtn")}
              </button>
            )}
            {target.configured && (
              <button
                className="mini"
                onClick={() => forgetAccount(target.id).catch(notify)}
              >
                {t("pub.forget")}
              </button>
            )}
            <a
              className="ca-note"
              href={target.help}
              target="_blank"
              rel="noreferrer"
            >
              {t("pub.where")}
            </a>
          </div>
        </div>
      )}
    </li>
  );
}

export function PublishSection() {
  const t = useT();
  const available = useBridge((s) => s.publish);
  const { targets, progress } = usePublish();
  const project = useStore((s) => s.project);
  const [chosen, setChosen] = useState<string[]>([]);
  const [privacy, setPrivacy] = useState<'public' | 'unlisted' | 'private'>('public');
  useEffect(() => {
    if (!available) return;
    void refreshTargets().catch(() => {});
    return onPublishAuthorized(
      (m) => !m.ok && notify(new Error(m.error ?? "Sign-in failed")),
    );
  }, [available]);
  const license = releaseOf(project).license as LicenseCode;
  const pubs = project.publications ?? [];
  if (!available) return <p className="ca-note">{t("pub.needsLocal")}</p>;
  const ready = (id: string) => !!targets?.find((x) => x.id === id)?.authorized;
  return (
    <div className="rel-publish">
      <h4>{t("pub.accounts")}</h4>
      <ul className="rel-material">
        {targets?.map((x) => (
          <Account key={x.id} t={x} />
        ))}
      </ul>
      <h4>{t("pub.publish")}</h4>
      {SUPPORTED.map((id) => (
        <label key={id} className="pub-choice">
          <input
            type="checkbox"
            checked={chosen.includes(id)}
            disabled={!ready(id)}
            onChange={(e) =>
              setChosen(
                e.target.checked
                  ? [...chosen, id]
                  : chosen.filter((x) => x !== id),
              )
            }
          />{" "}
          {platformById(id)!.name}
          {progress[id] && (
            <span className="ca-note">
              {" "}
              {progress[id].error
                ? `✗ ${progress[id].error}`
                : progress[id].url
                  ? "✓"
                  : `${Math.round(progress[id].fraction * 100)} %`}
            </span>
          )}
        </label>
      ))}
      <div className="row">
        {LICENSES[license]?.cc && (
          <button
            className="mini"
            onClick={() =>
              setChosen(
                ccTargets(license).filter(
                  (id) =>
                    (SUPPORTED as readonly string[]).includes(id) && ready(id),
                ),
              )
            }
          >
            {t("pub.inCc")}
          </button>
        )}
        <select value={privacy} onChange={(e) => setPrivacy(e.target.value as typeof privacy)} title={t("pub.privacyHint")}>
          <option value="public">{t("pub.public")}</option>
          <option value="unlisted">{t("pub.unlisted")}</option>
          <option value="private">{t("pub.private")}</option>
        </select>
        <button
          className="btn primary"
          disabled={!chosen.length}
          onClick={() =>
            void runCommand("publish", { platforms: chosen, privacy }, "ui").catch(
              notify,
            )
          }
        >
          {t("pub.go")}
        </button>
      </div>
      <p className="ca-note">{t("pub.later")}</p>
      {pubs.length > 0 && (
        <>
          <h4>{t("pub.done")}</h4>
          <ul className="rel-material">
            {pubs.map((x) => (
              <li key={x.platform + x.id}>
                <b>{platformById(x.platform)?.name ?? x.platform}</b>{" "}
                <a href={x.url} target="_blank" rel="noreferrer">
                  {x.url}
                </a>{" "}
                <span className="ca-note">
                  {new Date(x.at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The confirmation every publish waits for: shown wherever the studio is. */
export function PublishConfirm() {
  const t = useT();
  const c = usePublish((s) => s.confirm);
  const project = useStore((s) => s.project);
  if (!c) return null;
  const r = releaseOf(project);
  const lic = LICENSES[r.license as LicenseCode];
  return (
    <div className="modal-scrim">
      <div
        className="modal pub-confirm"
        role="dialog"
        aria-label={t("pub.confirmTitle")}
      >
        <div className="modal-head">
          <div className="lib-title">{t("pub.confirmTitle")}</div>
        </div>
        <div className="pub-confirm-body">
          <p>
            <b>{r.title}</b>
            {r.artist ? ` — ${r.artist}` : ""} · {lic?.name ?? r.license}
          </p>
          <ul>
            {c.platforms.map((id) => (
              <li key={id}>
                <b>{platformById(id)?.name ?? id}</b>
                {id === "archive" && (
                  <div className="ca-note">{t("pub.archiveWarn")}</div>
                )}
                {id === "wikimedia" && (
                  <div className="ca-note">{t("pub.commonsWarn")}</div>
                )}
                {id === "youtube" && (
                  <div className="ca-note">{t("pub.youtubeWarn", { privacy: t(`pub.${c.privacy ?? "public"}` as never) })}</div>
                )}
                {id === "soundcloud" && (
                  <div className="ca-note">{t("pub.soundcloudWarn", { privacy: t(`pub.${c.privacy === "public" ? "public" : "private"}` as never) })}</div>
                )}
                {id === "mixcloud" && (
                  <div className="ca-note">{t("pub.mixcloudWarn")}</div>
                )}
              </li>
            ))}
          </ul>
          {lic?.cc && <p className="ca-note">{t("pub.ccWarn")}</p>}
          <div className="row">
            <button className="btn" onClick={() => c.resolve(false)}>
              {t("pub.cancel")}
            </button>
            <button className="btn primary" onClick={() => c.resolve(true)}>
              {t("pub.confirm")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
