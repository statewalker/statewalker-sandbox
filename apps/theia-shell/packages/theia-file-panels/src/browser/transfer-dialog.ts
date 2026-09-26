import { AbstractDialog, type DialogError, DialogProps } from "@theia/core/lib/browser/dialogs";
import type { Message } from "@theia/core/lib/browser/widgets/widget";
import type URI from "@theia/core/lib/common/uri";
import { Messages } from "../common/file-panels-nls";
import {
  type ClashPolicy,
  dropOptions,
  freeName,
  type TransferOp,
  type TransferSource,
  validateName,
} from "../common/transfer-planner";

export interface TransferChoice {
  op: TransferOp;
  name?: string;
  clash: ClashPolicy;
}

export class TransferDialogProps extends DialogProps {
  sources!: TransferSource[];
  target!: URI;
  targetName!: string;
  existing!: ReadonlySet<string>;
  preferCopy!: boolean;
}

export class TransferDialog extends AbstractDialog<TransferChoice> {
  protected op: TransferOp;
  protected clash: ClashPolicy = "keepBoth";
  protected readonly nameInput?: HTMLInputElement;
  protected readonly warning = document.createElement("div");
  protected readonly options: ReturnType<typeof dropOptions>;

  constructor(protected override readonly props: TransferDialogProps) {
    super(props);
    this.addClass("file-panels-transfer-dialog");
    const { sources, target, existing, preferCopy } = props;
    this.options = dropOptions(sources, target, existing);
    this.op = this.options.allInTarget ? "copy" : preferCopy ? "copy" : "move";

    const to = document.createElement("div");
    to.className = "file-panels-target";
    to.textContent = Messages.targetFolder(props.targetName);
    this.contentNode.appendChild(to);

    this.contentNode.appendChild(
      this.radios(
        "file-panels-op",
        this.options.ops.map((op) => [op, this.opLabel(op)]),
        this.op,
        (op) => {
          this.op = op as TransferOp;
          this.prefillName();
          void this.validate();
        },
      ),
    );

    if (sources.length === 1) {
      const label = document.createElement("label");
      label.className = "file-panels-name-label";
      label.textContent = Messages.nameLabel();
      const input = document.createElement("input");
      input.className = "theia-input file-panels-name";
      input.spellcheck = false;
      label.appendChild(input);
      this.contentNode.appendChild(label);
      this.nameInput = input;
      this.addUpdateListener(input, "input");
      this.prefillName();
    } else if (this.options.clashing.length > 0) {
      const count = document.createElement("div");
      count.textContent = Messages.clashCount(this.options.clashing.length);
      this.contentNode.appendChild(count);
      this.contentNode.appendChild(
        this.radios(
          "file-panels-clash",
          [
            ["overwrite", Messages.clashOverwrite()],
            ["keepBoth", Messages.clashKeepBoth()],
            ["skip", Messages.clashSkip()],
          ],
          this.clash,
          (clash) => {
            this.clash = clash as ClashPolicy;
          },
        ),
      );
    }

    this.warning.className = "file-panels-warning";
    this.contentNode.appendChild(this.warning);
    this.appendCloseButton();
    this.appendAcceptButton();
  }

  get value(): TransferChoice {
    return { op: this.op, name: this.nameInput?.value, clash: this.clash };
  }

  protected override isValid(value: TransferChoice): DialogError {
    this.warning.textContent = "";
    if (value.name === undefined) return "";
    const problem = validateName(value.name);
    if (problem === "empty") return Messages.nameEmpty();
    if (problem === "dots") return Messages.nameDots();
    if (problem === "slash") return Messages.nameSlash();
    const [source] = this.props.sources;
    const sameFolder = source.uri.parent.isEqual(this.props.target);
    if (sameFolder && value.name === source.uri.path.base) return Messages.nameUnchanged();
    if (this.props.existing.has(value.name))
      this.warning.textContent = Messages.nameExists(value.name);
    return "";
  }

  protected override onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    void this.validate();
  }

  protected override onActivateRequest(): void {
    if (this.nameInput) {
      this.nameInput.focus();
      const dot = this.nameInput.value.indexOf(".", 1);
      this.nameInput.setSelectionRange(0, dot > 0 ? dot : this.nameInput.value.length);
    } else {
      this.controlPanel.querySelector<HTMLButtonElement>(".theia-button.main")?.focus();
    }
  }

  protected prefillName(): void {
    if (!this.nameInput) return;
    const [source] = this.props.sources;
    const name = source.uri.path.base;
    const sameFolder = source.uri.parent.isEqual(this.props.target);
    this.nameInput.value =
      sameFolder && this.op === "copy"
        ? freeName(name, source.isDirectory, this.props.existing, Messages.copySuffix)
        : name;
  }

  protected opLabel(op: TransferOp): string {
    return op === "copy"
      ? Messages.opCopy()
      : op === "move"
        ? Messages.opMove()
        : Messages.opRename();
  }

  protected radios(
    name: string,
    items: [string, string][],
    checked: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const group = document.createElement("div");
    group.className = `file-panels-radios ${name}`;
    group.setAttribute("role", "radiogroup");
    for (const [value, text] of items) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = name;
      input.value = value;
      input.checked = value === checked;
      input.addEventListener("change", () => input.checked && onChange(value));
      label.append(input, ` ${text}`);
      group.appendChild(label);
    }
    return group;
  }
}
