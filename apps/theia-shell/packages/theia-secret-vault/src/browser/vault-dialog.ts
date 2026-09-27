import {
  AbstractDialog,
  type DialogError,
  type DialogMode,
  DialogProps,
} from "@theia/core/lib/browser/dialogs";

export type VaultDialogMode = "unlock" | "create" | "change";

export class VaultDialogProps extends DialogProps {
  readonly mode!: VaultDialogMode;
  /** Shown above the fields. */
  readonly message?: string;
  /**
   * Runs on accept, before the dialog closes: the vault operation itself.
   * Resolves to an error to show in the dialog (e.g. "Wrong password"), or ""
   * on success — so the dialog closes only once the vault is really unlocked.
   */
  readonly submit?: (result: VaultDialogResult) => Promise<string>;
}

export interface VaultDialogResult {
  password: string;
  remember: boolean;
}

/** Asks for the vault password: to unlock, to create the vault (twice), or a new one. */
export class VaultPasswordDialog extends AbstractDialog<VaultDialogResult> {
  protected readonly password = document.createElement("input");
  protected readonly confirm = document.createElement("input");
  protected readonly rememberBox = document.createElement("input");

  constructor(protected override readonly props: VaultDialogProps) {
    super(props);
    this.addClass("vault-dialog");
    if (props.message) {
      const message = document.createElement("p");
      message.className = "vault-message";
      message.textContent = props.message;
      this.contentNode.appendChild(message);
    }
    this.password.type = "password";
    this.password.className = "theia-input vault-password";
    this.password.placeholder = props.mode === "unlock" ? "Password" : "New password";
    this.contentNode.appendChild(this.password);
    if (props.mode !== "unlock") {
      this.confirm.type = "password";
      this.confirm.className = "theia-input vault-password-confirm";
      this.confirm.placeholder = "Repeat the password";
      this.contentNode.appendChild(this.confirm);
    }
    if (props.mode !== "change") {
      const label = document.createElement("label");
      this.rememberBox.type = "checkbox";
      this.rememberBox.className = "vault-remember";
      label.append(this.rememberBox, " Remember on this device");
      this.contentNode.appendChild(label);
    }
    this.appendCloseButton(props.mode === "change" ? "Cancel" : "Skip");
    this.appendAcceptButton({ unlock: "Unlock", create: "Create", change: "Change" }[props.mode]);
  }

  get value(): VaultDialogResult {
    return { password: this.password.value, remember: this.rememberBox.checked };
  }

  protected override async isValid(
    value: VaultDialogResult,
    mode: DialogMode,
  ): Promise<DialogError> {
    // While typing, an empty password only disables the button; on Enter it is said.
    if (!value.password)
      return mode === "open" ? "Enter a password." : { message: "", result: false };
    if (this.props.mode !== "unlock" && value.password !== this.confirm.value) {
      return mode === "open" || this.confirm.value
        ? "The passwords do not match."
        : { message: "", result: false };
    }
    if (mode === "open" && this.props.submit) return this.props.submit(value);
    return "";
  }

  protected override onAfterAttach(
    msg: Parameters<AbstractDialog<VaultDialogResult>["onAfterAttach"]>[0],
  ): void {
    super.onAfterAttach(msg);
    this.addUpdateListener(this.password, "input");
    this.addUpdateListener(this.confirm, "input");
  }

  protected override onActivateRequest(
    msg: Parameters<AbstractDialog<VaultDialogResult>["onActivateRequest"]>[0],
  ): void {
    super.onActivateRequest(msg);
    this.password.focus();
  }
}
