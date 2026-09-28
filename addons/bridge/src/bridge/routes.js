// SPDX-License-Identifier: MIT
import { createRoutes as baseRoutes, ROUTE_NAMES as BASE_NAMES } from "../../../shared/lib/mail-routes.js";
import { VALIDATORS } from "../../../shared/lib/approval-schema.js";
import { STATE_ROUTES, validateStateRequest } from "../../../shared/lib/state-request.js";
import { BridgeError } from "./validate.js";

export const ROUTE_NAMES = Object.freeze([...BASE_NAMES, "requests.cleanup", "requests.unsubscribe", "requests.folders"]);
export function createRoutes({ ops, version, relay = async () => { throw new BridgeError("unavailable", "Draftsafe Tools is required for approval."); } }) {
  const routes = { ...baseRoutes({ ops, version }) };
  if (relay.health) {
    const baseHealth = routes.health;
    routes.health = async params => ({ ...(await baseHealth(params)), tools: await relay.health() });
  }
  for (const route of STATE_ROUTES) {
    routes[route] = async params => {
      await validateStateRequest({ route, params });
      return relay("state", { route, params });
    };
  }
  for (const [route, kind] of [["requests.cleanup", "cleanup"], ["requests.unsubscribe", "unsubscribe"], ["requests.folders", "folders"]]) {
    routes[route] = async params => {
      try { VALIDATORS[kind](params); }
      catch { throw new BridgeError("invalid_params", "Invalid approval request; check its fields and limits."); }
      return relay(kind, params);
    };
  }
  return Object.freeze(routes);
}
