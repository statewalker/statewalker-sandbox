import { injectable } from "@theia/core/shared/inversify";
import type { MeshAdvertisement, MeshContribution, MeshMounts } from "@theia-shell/theia-httpeers";
import { createProxyTable, type ProxyTable, underMount } from "../common/proxy-table";
import { localStorageRouteStore } from "../common/route-store";

export const PROXY_MOUNT = "/proxy";
export const PROXY_ADVERT: MeshAdvertisement = { id: "proxy", kind: "proxy", title: "Proxy" };

/**
 * The proxy this browser serves to the mesh: the route table, mounted at
 * `/proxy` on the member and advertised while it has routes. Other members
 * call `/peers/<this peer>/proxy/<prefix>/…`; the member's rules
 * (`app:proxy.use`, granted to every member) decide who may.
 */
@injectable()
export class ProxyService implements MeshContribution {
  readonly table: ProxyTable = createProxyTable({ store: localStorageRouteStore() });
  readonly ready: Promise<void> = this.table.load();

  configureMounts(mounts: MeshMounts): void {
    mounts.provide(PROXY_MOUNT, async (request) => {
      await this.ready;
      return this.table.handle(await underMount(PROXY_MOUNT, request));
    });
  }

  advertisements(): MeshAdvertisement[] {
    return this.table.routes().length > 0 ? [PROXY_ADVERT] : [];
  }
}
