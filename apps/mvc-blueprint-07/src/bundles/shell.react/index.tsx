import { createRoot } from "react-dom/client";
import { type Controller, useFields } from "../../kernel/context.js";
import { getSlots } from "../../kernel/slots.js";
import { getReactRoot } from "../shell/api/react.js";
import { Host } from "./host.js";

const fields = useFields({ slots: getSlots, element: getReactRoot });

/** The React shell host bundle: mounts the host on the element the application provides. */
export const activate: Controller = async (context) => {
  const { slots, element } = fields(context);
  const root = createRoot(element);
  root.render(<Host slots={slots} />);
  return () => root.unmount();
};
