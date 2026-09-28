import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import * as React from "@theia/core/shared/react";
import { renderMarkdown } from "@theia-shell/theia-markdown/lib/common/markdown-render";
import type { SetupStage } from "../common/chat-setup";
import type { ChatMessage } from "../common/core/sessions";
import { ChatService } from "./chat-service";

/**
 * The chat: a list of conversations, the current thread and a composer, over
 * the mesh's LLM service or a custom OpenAI-compatible endpoint.
 *
 * A reply is rendered as Markdown through the Markdown extension's renderer
 * (raw HTML escaped, then DOMPurify): model output is data, never code on
 * this origin (HTTPeers security model §2).
 */
@injectable()
export class ChatWidget extends ReactWidget {
  static readonly ID = "llm-chat";
  static readonly LABEL = "LLM Chat";

  @inject(ChatService) protected readonly chat!: ChatService;

  protected draft = "";
  protected keyDraft = "";
  protected endpointDraft = { baseUrl: "", apiKey: "" };
  protected threadEnd: HTMLDivElement | null = null;

  @postConstruct()
  protected init(): void {
    this.id = ChatWidget.ID;
    this.title.label = ChatWidget.LABEL;
    this.title.caption = "Chat with an LLM: the mesh's, or any OpenAI-compatible endpoint";
    this.title.iconClass = "codicon codicon-comment-discussion";
    this.title.closable = true;
    this.addClass("llm-chat-widget");
    this.toDispose.push(this.chat.onDidChange(() => this.update()));
    this.chat.start();
    this.update();
  }

  protected override onActivateRequest(
    msg: import("@theia/core/shared/@lumino/messaging").Message,
  ): void {
    super.onActivateRequest(msg);
    this.node
      .querySelector<HTMLElement>(".llm-chat-composer textarea, .llm-chat-setup input")
      ?.focus();
  }

  protected override onUpdateRequest(
    msg: import("@theia/core/shared/@lumino/messaging").Message,
  ): void {
    super.onUpdateRequest(msg);
    this.threadEnd?.scrollIntoView({ block: "end" });
  }

  protected send(): void {
    const text = this.draft.trim();
    if (text === "" || this.chat.controller.getState().isRunning) return;
    this.draft = "";
    void this.chat.controller.send(text);
    this.update();
  }

  protected render(): React.ReactNode {
    const { source, stage } = this.chat.setup.state();
    return (
      <div className="llm-chat">
        <aside className="llm-chat-list" aria-label="Chats">
          <button type="button" className="theia-button" onClick={() => void this.chat.newChat()}>
            New chat
          </button>
          <ul>
            {this.chat.summaries.map((summary) => (
              <li
                key={summary.id}
                className={
                  summary.id === this.chat.controller.getState().session?.id ? "active" : ""
                }
              >
                <button
                  type="button"
                  className="llm-chat-open"
                  onClick={() => void this.chat.controller.open(summary.id)}
                >
                  {summary.title}
                </button>
                <button
                  type="button"
                  className="llm-chat-delete codicon codicon-trash"
                  title="Delete this chat"
                  aria-label={`Delete ${summary.title}`}
                  onClick={() => void this.chat.deleteChat(summary.id)}
                />
              </li>
            ))}
          </ul>
        </aside>
        <section className="llm-chat-main">
          <header className="llm-chat-header">
            <select
              className="theia-select"
              aria-label="Endpoint"
              value={source}
              onChange={(e) => void this.chat.setSource(e.target.value as "mesh" | "custom")}
            >
              <option value="mesh">Mesh LLM (hub)</option>
              <option value="custom">Custom endpoint</option>
            </select>
            {stage.kind === "ready" && (
              <>
                <select
                  className="theia-select"
                  aria-label="Model"
                  value={stage.config.defaultModel ?? ""}
                  onChange={(e) => void this.chat.setup.chooseModel(e.target.value)}
                >
                  {stage.config.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="theia-button secondary"
                  onClick={() => this.chat.setup.reconfigure()}
                >
                  {source === "mesh" ? "Change key" : "Change endpoint"}
                </button>
                {stage.admin && stage.dashboardUrl != null && (
                  <a href={stage.dashboardUrl} target="_blank" rel="noopener noreferrer">
                    LiteLLM dashboard
                  </a>
                )}
              </>
            )}
          </header>
          {stage.kind === "ready" ? this.renderThread() : this.renderSetup(stage)}
        </section>
      </div>
    );
  }

  protected renderSetup(stage: SetupStage): React.ReactNode {
    switch (stage.kind) {
      case "mesh-offline":
        return (
          <p className="llm-chat-setup" role="status">
            Join a mesh (the <b>Mesh</b> view) to chat with its LLM service, or choose a custom
            endpoint.
          </p>
        );
      case "finding":
        return (
          <p className="llm-chat-setup" role="status">
            Finding the mesh's LLM service…
          </p>
        );
      case "loading-models":
        return (
          <p className="llm-chat-setup" role="status">
            Listing the models…
          </p>
        );
      case "unavailable":
        return (
          <div className="llm-chat-setup">
            <p role="alert">{stage.message}</p>
            <button
              type="button"
              className="theia-button"
              onClick={() => void this.chat.setup.retry()}
            >
              Try again
            </button>
          </div>
        );
      case "key":
        return (
          <form
            className="llm-chat-setup"
            aria-label="Key"
            onSubmit={(e) => {
              e.preventDefault();
              void this.chat.setup.submitKey(this.keyDraft);
              this.keyDraft = "";
            }}
          >
            <p>
              The mesh's LLM service needs a key of its own. Paste the key an admin gave you
              {stage.canRequest ? ", or request one if you are an admin" : ""}.
            </p>
            <input
              className="theia-input"
              type="password"
              autoComplete="off"
              aria-label="Key"
              value={this.keyDraft}
              onChange={(e) => {
                this.keyDraft = e.target.value;
                this.update();
              }}
            />
            {stage.error != null && <p role="alert">{stage.error}</p>}
            <div className="llm-chat-actions">
              {stage.canRequest && (
                <button
                  type="button"
                  className="theia-button secondary"
                  onClick={() => void this.chat.setup.requestKey()}
                >
                  Request a key
                </button>
              )}
              <button type="submit" className="theia-button" disabled={this.keyDraft.trim() === ""}>
                Use key
              </button>
            </div>
          </form>
        );
      case "endpoint":
        return (
          <form
            className="llm-chat-setup"
            aria-label="Endpoint settings"
            onSubmit={(e) => {
              e.preventDefault();
              void this.chat.setup.submitEndpoint(this.endpointDraft);
            }}
          >
            <p>Any OpenAI-compatible API: its base URL (ending in /v1) and a key.</p>
            <label>
              Base URL
              <input
                className="theia-input"
                placeholder="https://api.openai.com/v1"
                value={this.endpointDraft.baseUrl || stage.baseUrl}
                onChange={(e) => {
                  this.endpointDraft = { ...this.endpointDraft, baseUrl: e.target.value };
                  this.update();
                }}
              />
            </label>
            <label>
              API key
              <input
                className="theia-input"
                type="password"
                autoComplete="off"
                value={this.endpointDraft.apiKey}
                onChange={(e) => {
                  this.endpointDraft = { ...this.endpointDraft, apiKey: e.target.value };
                  this.update();
                }}
              />
            </label>
            {stage.error != null && <p role="alert">{stage.error}</p>}
            <div className="llm-chat-actions">
              <button type="submit" className="theia-button">
                Connect
              </button>
            </div>
          </form>
        );
      default:
        return null;
    }
  }

  protected renderThread(): React.ReactNode {
    const { session, isRunning, error } = this.chat.controller.getState();
    const messages = session?.messages ?? [];
    const lastAssistant = messages.length > 0 && messages[messages.length - 1].role === "assistant";
    return (
      <>
        <div className="llm-chat-thread" aria-label="Conversation" role="log">
          {messages.length === 0 && <p className="llm-chat-empty">Ask anything.</p>}
          {messages.map((message, index) =>
            this.renderMessage(message, index, isRunning && index === messages.length - 1),
          )}
          {error != null && (
            <div className="llm-chat-error" role="alert">
              {error.message}
              {error.hint != null && <span> {error.hint}</span>}
              <button
                type="button"
                className="theia-button secondary"
                onClick={() => this.chat.controller.dismissError()}
              >
                Dismiss
              </button>
            </div>
          )}
          <div
            ref={(el) => {
              this.threadEnd = el;
            }}
          />
        </div>
        <form
          className="llm-chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            this.send();
          }}
        >
          <textarea
            className="theia-input"
            aria-label="Message"
            placeholder="Message (Enter to send, Shift+Enter for a new line)"
            rows={3}
            value={this.draft}
            onChange={(e) => {
              this.draft = e.target.value;
              this.update();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                this.send();
              }
            }}
          />
          <div className="llm-chat-actions">
            {!isRunning && lastAssistant && (
              <button
                type="button"
                className="theia-button secondary"
                onClick={() => void this.chat.controller.regenerate()}
              >
                Regenerate
              </button>
            )}
            {isRunning ? (
              <button
                type="button"
                className="theia-button secondary"
                onClick={() => this.chat.controller.cancel()}
              >
                Stop
              </button>
            ) : (
              <button type="submit" className="theia-button" disabled={this.draft.trim() === ""}>
                Send
              </button>
            )}
          </div>
        </form>
      </>
    );
  }

  protected renderMessage(
    message: ChatMessage,
    index: number,
    streaming: boolean,
  ): React.ReactNode {
    const className = `llm-chat-message ${message.role}${streaming ? " streaming" : ""}`;
    if (message.role === "assistant") {
      return (
        <div
          key={index}
          className={`${className} markdown-preview`}
          // renderMarkdown escapes raw HTML and sanitizes the result with DOMPurify.
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        />
      );
    }
    return (
      <div key={index} className={className}>
        {message.content}
      </div>
    );
  }
}
