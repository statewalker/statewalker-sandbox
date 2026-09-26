import "../../src/browser/style/mount-form.css";
import {
  AbstractDialog,
  type DialogError,
  type DialogMode,
  DialogProps,
} from "@theia/core/lib/browser/dialogs";
import { validateMountForm } from "../common/mount-form";
import type { MountField, MountType } from "../common/mount-types";

/** What the form gives back: the mount's name, path (key), config and secrets. */
export interface MountFormResult {
  name: string;
  key: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
}

export class MountFormDialogProps extends DialogProps {
  readonly type!: MountType;
  /** Keys already used (other mounts, remembered ones, reserved). */
  readonly taken!: readonly string[];
  readonly editing!: boolean;
  /** Prefilled values; `config` may hold values no field shows (a local folder's handle id). */
  readonly initial?: { name?: string; key?: string; config?: Record<string, string> };
  /** Editing a type with an interactive step: pick again (e.g. another folder). */
  readonly chooseAgain?: () => Promise<
    { config: Record<string, string>; name?: string } | undefined
  >;
}

/**
 * One form per mount: the name, the mount path (the workspace folder's name,
 * following the name until edited) and the type's own fields. The Mount
 * button stays disabled until the form is valid; errors show under each field.
 */
export class MountFormDialog extends AbstractDialog<MountFormResult> {
  protected readonly nameInput = document.createElement("input");
  protected readonly keyInput = document.createElement("input");
  protected readonly fieldInputs = new Map<string, HTMLInputElement>();
  protected readonly errorNodes = new Map<string, HTMLElement>();
  protected readonly touched = new Set<string>();
  protected keyEdited: boolean;
  /** The values the form last derived, to tell a user's edit from its own. */
  protected readonly derived = new Map<string, string>();
  protected config: Record<string, string>;

  constructor(protected override readonly props: MountFormDialogProps) {
    super(props);
    this.addClass("mount-form-dialog");
    this.config = { ...(props.initial?.config ?? {}) };
    this.keyEdited = props.initial?.key !== undefined;

    this.addRow("name", "Name shown in the explorer", this.nameInput, "mount-form-name");
    this.nameInput.value = props.initial?.name ?? "";
    this.addRow("key", "Mount path (the workspace folder)", this.keyInput, "mount-form-key");
    this.keyInput.value = props.initial?.key ?? "";
    for (const field of props.type.fields) {
      const input = document.createElement("input");
      input.dataset.field = field.name;
      input.type = field.kind === "secret" ? "password" : "text";
      if (field.kind === "secret" && props.editing)
        input.placeholder = "Leave empty to keep the current value";
      if (field.kind !== "secret") input.value = this.config[field.name] ?? "";
      this.addRow(
        `field:${field.name}`,
        field.label + (field.required ? "" : " (optional)"),
        input,
        "mount-form-field",
      );
      this.fieldInputs.set(field.name, input);
    }
    this.followDefaults();

    if (props.editing && props.chooseAgain) {
      const again = this.appendButton("Choose another folder…", false);
      again.classList.add("mount-form-choose");
      again.addEventListener("click", () => void this.pickAgain());
    }
    this.appendCloseButton("Cancel");
    this.appendAcceptButton(props.editing ? "Save" : "Mount");
  }

  get value(): MountFormResult {
    const { key } = this.check();
    const config: Record<string, string> = { ...this.config };
    const secrets: Record<string, string> = {};
    for (const field of this.props.type.fields) {
      const value = (this.fieldInputs.get(field.name)?.value ?? "").trim();
      if (field.kind === "secret") {
        if (value) secrets[field.name] = value;
        delete config[field.name];
      } else if (value) config[field.name] = value;
      else delete config[field.name];
    }
    return { name: this.nameInput.value.trim(), key, config, secrets };
  }

  protected check() {
    const fields: Record<string, string> = {};
    for (const [name, input] of this.fieldInputs) fields[name] = input.value;
    return validateMountForm(
      this.props.type,
      { name: this.nameInput.value, key: this.keyInput.value, keyEdited: this.keyEdited, fields },
      { taken: this.props.taken, editing: this.props.editing },
    );
  }

  protected override isValid(_value: MountFormResult, mode: DialogMode): DialogError {
    this.followDefaults();
    const { errors, valid } = this.check();
    const all = mode === "open";
    this.showError("name", errors.name, all);
    this.showError("key", errors.key, all);
    for (const field of this.props.type.fields) {
      this.showError(`field:${field.name}`, errors.fields[field.name], all);
    }
    if (valid) return "";
    if (!all) return { message: "", result: false };
    return errors.name ?? errors.key ?? Object.values(errors.fields)[0] ?? "Check the form.";
  }

  /**
   * The mount path follows the name, and fields with a computed default follow
   * the path — until the user changes them: a value that differs from what the
   * form last derived is the user's.
   */
  protected followDefaults(): void {
    if (!this.keyEdited && this.isUserValue("key", this.keyInput)) this.keyEdited = true;
    if (!this.keyEdited) this.derive("key", this.keyInput, this.check().key);
    if (this.props.editing) return;
    const mount = { key: this.keyInput.value.trim(), name: this.nameInput.value.trim() };
    for (const field of this.props.type.fields) {
      const input = this.fieldInputs.get(field.name);
      const fallback = defaultOf(field, mount);
      if (!input || fallback === undefined || this.isUserValue(`field:${field.name}`, input))
        continue;
      this.derive(`field:${field.name}`, input, fallback);
    }
  }

  protected isUserValue(id: string, input: HTMLInputElement): boolean {
    return input.value !== "" && input.value !== (this.derived.get(id) ?? "");
  }

  protected derive(id: string, input: HTMLInputElement, value: string): void {
    input.value = value;
    this.derived.set(id, value);
  }

  protected async pickAgain(): Promise<void> {
    const picked = await this.props.chooseAgain?.();
    if (!picked) return;
    this.config = { ...this.config, ...picked.config };
    if (picked.name && !this.touched.has("name")) this.nameInput.value = picked.name;
    this.update();
  }

  protected addRow(id: string, label: string, input: HTMLInputElement, className: string): void {
    const row = document.createElement("label");
    row.className = "mount-form-row";
    const caption = document.createElement("span");
    caption.textContent = label;
    input.classList.add("theia-input", className);
    input.addEventListener("input", () => {
      this.touched.add(id);
      this.update();
    });
    const error = document.createElement("div");
    error.className = "mount-form-error";
    this.errorNodes.set(id, error);
    row.append(caption, input, error);
    this.contentNode.appendChild(row);
  }

  protected showError(id: string, message: string | undefined, all: boolean): void {
    const node = this.errorNodes.get(id);
    if (node) node.textContent = message && (all || this.touched.has(id)) ? message : "";
  }

  protected override onAfterAttach(
    msg: Parameters<AbstractDialog<MountFormResult>["onAfterAttach"]>[0],
  ): void {
    super.onAfterAttach(msg);
    this.update();
  }

  protected override onActivateRequest(
    msg: Parameters<AbstractDialog<MountFormResult>["onActivateRequest"]>[0],
  ): void {
    super.onActivateRequest(msg);
    this.nameInput.focus();
  }
}

function defaultOf(field: MountField, mount: { key: string; name: string }): string | undefined {
  if (field.default === undefined) return undefined;
  return typeof field.default === "function" ? field.default(mount) : field.default;
}
