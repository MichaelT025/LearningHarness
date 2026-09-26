import type { Express, Request } from "express";
import type { SubscriptionSnapshot } from "./subscriptions.js";

interface SubscriptionClient {
	getSubscriptions(providerId?: string): Promise<SubscriptionSnapshot>;
}

/** Same authentication middleware and origin policy as the rest of the host. */
export function registerSubscriptionRoutes(
	app: Express,
	getClient: (clientId: string) => SubscriptionClient | undefined,
	originAllowed: (req: Request) => boolean,
) {
	for (const method of ["get", "post"] as const) {
		app[method]("/api/subscriptions", async (req, res) => {
			res.setHeader("Cache-Control", "no-store");
			if (!originAllowed(req) || req.headers["sec-fetch-site"] === "cross-site") {
				res.status(403).json({ error: "Forbidden" });
				return;
			}
			const clientId = typeof req.query.clientId === "string" ? req.query.clientId : "";
			const client = clientId ? getClient(clientId) : undefined;
			if (!client) {
				res.status(409).json({ error: "Session not ready" });
				return;
			}
			const providerId = method === "post" ? req.body?.providerId : undefined;
			if (
				method === "post" &&
				(typeof providerId !== "string" || !["openai-codex", "opencode-go", "command-code"].includes(providerId))
			) {
				res.status(400).json({ error: "Unknown subscription provider" });
				return;
			}
			try {
				res.json(await client.getSubscriptions(providerId));
			} catch {
				// Never serialize SDK/auth/provider exceptions or upstream response bodies.
				res.status(503).json({ error: "Subscription usage unavailable" });
			}
		});
	}
}
