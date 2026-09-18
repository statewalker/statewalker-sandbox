/**
 * shell.react — mounts the React host into the element the application was given under
 * `shell.react:root`, and unmounts on deactivation.
 */
import { createRoot } from "react-dom/client";
import { type Activator, getKey, getStore, useFields } from "../../kernel/index.ts";
import { StoreProvider } from "./binding.ts";
import { ShellHost } from "./host.tsx";

export const ROOT_KEY = "shell.react:root";
const useAppFields = useFields({ store: getStore, root: (c) => getKey<HTMLElement>(c, ROOT_KEY) });

export const activate: Activator = async (context) => {
  const { store, root } = useAppFields(context);
  const react = createRoot(root);
  react.render(
    <StoreProvider store={store}>
      <ShellHost />
    </StoreProvider>,
  );
  return () => react.unmount();
};
