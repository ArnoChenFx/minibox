import { ANSWER_MAX, answerProblem, orderQuestions } from "../lib/agent.js";
import { api, enc } from "../lib/api.js";
import { esc } from "../lib/dom.js";
import { dateTime } from "../lib/format.js";
import { t } from "../lib/i18n.js";
import { icon } from "../lib/icons.js";
import { pollWhileDown, subscribe } from "../lib/live.js";
import { confirmDialog, toast, toastError, withBusy } from "../lib/ui.js";

/** How often the questions are read again while the live stream is down. */
const FALLBACK_MS = 4000;
/** A burst of events reads the questions once, after it has settled. */
const REFRESH_DEBOUNCE_MS = 300;
/** The events that change what the card shows. */
const CARD_OPS = new Set(["self.ask", "question.answer", "box.self.revoke"]);
/** Answered questions the card lists. The box's activity keeps the rest. */
const ANSWERED_SHOWN = 5;

function questionHtml(question, draft) {
  const reply = question.options.length
    ? `<div class="agent-choices">${question.options
        .map(
          (option) =>
            `<button type="button" class="btn btn-sm" data-agent-answer="${esc(option)}">${esc(option)}</button>`,
        )
        .join("")}</div>`
    : `<form class="agent-reply" data-agent-reply>
        <input class="input" name="answer" maxlength="${ANSWER_MAX}" autocomplete="off" value="${esc(draft)}" placeholder="${esc(t("ag.replyPlaceholder"))}" aria-label="${esc(t("ag.reply"))}" />
        <button type="submit" class="btn btn-primary btn-sm">${icon("check")}${esc(t("ag.reply"))}</button>
      </form>`;
  return `<li class="agent-question" data-question="${esc(question.id)}">
      <div class="agent-message">${esc(question.message)}</div>
      <div class="subtle">${esc(t("ag.asked", { time: dateTime(question.askedAt) }))}</div>
      ${reply}
      <div class="error-text" data-agent-error></div>
    </li>`;
}

/** An error about one answer shows on the card of that question. */
function setError(card, message) {
  const slot = card?.querySelector("[data-agent-error]");
  if (slot) slot.textContent = message;
}

function answeredHtml(question) {
  return `<li class="agent-answered">
      <div class="agent-message">${esc(question.message)}</div>
      <div><strong>${esc(question.answer ?? "")}</strong> <span class="subtle">${esc(t("ag.answeredAt", { time: dateTime(question.answeredAt) }))}</span></div>
    </li>`;
}

/**
 * The agent card's markup: whether the box has a self token, the questions still waiting for a person with their replies,
 * and the latest answered ones. Every question and answer is escaped, so the agent's text never runs as markup.
 */
export function agentCardHtml({ selfToken, pending, answered, drafts = new Map(), loadError = "" }) {
  const badge = `<span class="badge${selfToken ? " badge-success" : ""}">${esc(t(selfToken ? "ag.tokenOn" : "ag.tokenOff"))}</span>`;
  const revoke = selfToken
    ? `<button type="button" class="btn btn-sm" data-agent-action="revoke">${icon("key")}${esc(t("ag.revoke"))}</button>`
    : "";
  const waiting = pending.length
    ? `<ul class="agent-list">${pending.map((question) => questionHtml(question, drafts.get(question.id) ?? "")).join("")}</ul>`
    : `<p class="subtle">${esc(t("ag.nonePending"))}</p>`;
  const latest = answered.slice(0, ANSWERED_SHOWN);
  return `<div class="card">
    <div class="card-head"><h3>${esc(t("ag.section"))} ${badge}</h3><div class="startup-actions">${revoke}</div></div>
    <div class="card-body stack">
      <p class="help">${esc(t(selfToken ? "ag.help" : "ag.helpRevoked"))}</p>
      ${loadError ? `<div class="callout danger">${icon("alert")}<span>${esc(loadError)}</span></div>` : ""}
      ${waiting}
      ${latest.length ? `<span class="label">${esc(t("ag.answered"))}</span><ul class="agent-list">${latest.map(answeredHtml).join("")}</ul>` : ""}
    </div>
  </div>`;
}

/**
 * The agent card on the overview tab. A question its agent asked waits here for a person, who answers it with one of its
 * choices or in free text. The card reads the questions again when the agent asks one or someone answers, and while the
 * live stream is down. It stays hidden for a box with no self token and no questions. Revoking the token turns the self
 * token off for the box, and its questions stay.
 */
export function mountAgentCard(container, { box }) {
  let pending = [];
  let answered = [];
  let loadError = "";
  let disposed = false;
  let shownKey = null;
  let timer = null;
  const drafts = new Map();

  const paint = () => {
    if (disposed) return;
    const selfToken = box().selfToken === true;
    const hidden = !selfToken && pending.length === 0 && answered.length === 0;
    const key = JSON.stringify({ selfToken, hidden, pending, answered: answered.slice(0, ANSWERED_SHOWN), loadError });
    if (key === shownKey) return;
    shownKey = key;
    container.innerHTML = hidden ? "" : agentCardHtml({ selfToken, pending, answered, drafts, loadError });
  };

  const refresh = async () => {
    if (disposed) return;
    try {
      const { questions } = await api(`/api/boxes/${enc(box().id)}/questions`);
      if (disposed) return;
      ({ pending, answered } = orderQuestions(questions));
      loadError = "";
    } catch (err) {
      if (disposed) return;
      loadError = err.message;
    }
    paint();
  };

  const scheduleRefresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  };

  const answer = async (card, text, button) => {
    const id = card?.dataset.question ?? "";
    const question = pending.find((item) => item.id === id);
    if (!question) return;
    const problem = answerProblem(question, text);
    if (problem) {
      setError(card, t(problem === "empty" ? "ag.answerEmpty" : "ag.answerOption"));
      return;
    }
    setError(card, "");
    await withBusy(button, async () => {
      try {
        await api(`/api/questions/${enc(id)}/answer`, { method: "POST", body: { answer: text.trim() } });
        drafts.delete(id);
        toast(t("ag.answeredToast"), { message: box().name });
      } catch (err) {
        if (disposed) return;
        toastError(t("ag.answerFailed"), err);
      }
      await refresh();
    });
  };

  const revoke = async (button) => {
    const current = box();
    const confirmed = await confirmDialog({
      title: t("ag.revokeTitle", { name: current.name }),
      message: esc(t("ag.revokeText")),
      confirmText: t("ag.revoke"),
      danger: true,
    });
    if (!confirmed || disposed) return;
    await withBusy(button, async () => {
      try {
        await api(`/api/boxes/${enc(current.id)}/self-token`, { method: "DELETE" });
        toast(t("ag.revoked"), { message: t("ag.revokedText", { name: current.name }) });
      } catch (err) {
        if (disposed) return;
        toastError(t("ag.revokeFailed"), err);
      }
      await refresh();
    });
  };

  const onClick = (event) => {
    const action = event.target.closest?.("[data-agent-action]");
    if (action) {
      if (action.dataset.agentAction === "revoke") void revoke(action);
      return;
    }
    const choice = event.target.closest?.("[data-agent-answer]");
    if (choice) void answer(choice.closest("[data-question]"), choice.dataset.agentAnswer ?? "", choice);
  };

  const onSubmit = (event) => {
    const form = event.target.closest?.("[data-agent-reply]");
    if (!form) return;
    event.preventDefault();
    const input = form.querySelector("input");
    void answer(form.closest("[data-question]"), input?.value ?? "", form.querySelector("button[type=submit]"));
  };

  const onInput = (event) => {
    if (!event.target.matches?.("[data-agent-reply] input")) return;
    const card = event.target.closest("[data-question]");
    drafts.set(card.dataset.question, event.target.value);
    setError(card, "");
  };

  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  container.addEventListener("input", onInput);
  const offEvents = subscribe("event", (event) => {
    if (CARD_OPS.has(event.op)) scheduleRefresh();
  });
  const offSync = subscribe("sync", () => void refresh());
  const stopFallback = pollWhileDown(() => void refresh(), FALLBACK_MS);
  void refresh();

  return {
    onBoxChange() {
      paint();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      container.removeEventListener("click", onClick);
      container.removeEventListener("submit", onSubmit);
      container.removeEventListener("input", onInput);
      offEvents();
      offSync();
      stopFallback();
    },
  };
}
