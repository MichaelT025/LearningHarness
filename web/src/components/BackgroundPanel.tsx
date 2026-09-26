import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiRefreshCw } from "react-icons/fi";
import type { BgServer, ClientMessage } from "../types";
import { useT } from "../i18n";
import "../css/background.css";

export interface BackgroundPanelProps {
	servers: BgServer[];
	send: (msg: ClientMessage) => boolean;
}

function relativeStart(since: number, now: number, t: ReturnType<typeof useT>): string {
	const elapsed = Math.max(0, now - since);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return t("bgTaskJustNow");
	if (minutes < 60) return t("bgTaskMinutes", { n: minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return t("bgTaskHours", { n: hours });
	return t("bgTaskDays", { n: Math.floor(hours / 24) });
}

export function BackgroundPanel({ servers, send }: BackgroundPanelProps) {
	const t = useT();
	const [now, setNow] = useState(() => Date.now());
	const [confirmPort, setConfirmPort] = useState<number | null>(null);
	const [confirmAll, setConfirmAll] = useState(false);
	const refreshRef = useRef<HTMLButtonElement>(null);
	const stopAllRef = useRef<HTMLButtonElement>(null);
	const stopRefs = useRef(new Map<number, HTMLButtonElement>());
	const confirmationCancelRef = useRef<HTMLButtonElement>(null);
	const pendingFocusRef = useRef<{ kind: "stop"; port: number } | { kind: "all" } | "refresh" | null>(null);

	useEffect(() => {
		send({ type: "list_bg_servers" });
	}, [send]);

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, []);

	const refresh = () => send({ type: "list_bg_servers" });
	const requestStop = (port: number) => {
		setConfirmAll(false);
		setConfirmPort((current) => (current === port ? null : port));
	};
	const stop = (port: number) => {
		pendingFocusRef.current = "refresh";
		send({ type: "kill_background_server", port });
		setConfirmPort(null);
	};
	const cancelStop = (port: number) => {
		pendingFocusRef.current = { kind: "stop", port };
		setConfirmPort(null);
	};
	const requestStopAll = () => {
		setConfirmPort(null);
		setConfirmAll((current) => (current ? false : true));
	};
	const stopAll = () => {
		pendingFocusRef.current = "refresh";
		send({ type: "kill_background_servers" });
		setConfirmAll(false);
	};
	const cancelStopAll = () => {
		pendingFocusRef.current = { kind: "all" };
		setConfirmAll(false);
	};

	const confirmingTargetPresent = confirmPort !== null && servers.some((server) => server.port === confirmPort);
	const confirmingAllTargetPresent = confirmAll && servers.length > 0;
	useLayoutEffect(() => {
		if (confirmPort !== null && !confirmingTargetPresent) {
			setConfirmPort(null);
			refreshRef.current?.focus();
			return;
		}
		if (confirmAll && !confirmingAllTargetPresent) {
			setConfirmAll(false);
			refreshRef.current?.focus();
			return;
		}
		if (confirmPort !== null || confirmAll) {
			// The trigger is replaced by the confirmation controls; keep focus in that
			// control group rather than leaving it on a detached button.
			confirmationCancelRef.current?.focus();
			return;
		}

		const pendingFocus = pendingFocusRef.current;
		pendingFocusRef.current = null;
		if (pendingFocus === "refresh") {
			refreshRef.current?.focus();
		} else if (pendingFocus?.kind === "all") {
			(stopAllRef.current ?? refreshRef.current)?.focus();
		} else if (pendingFocus?.kind === "stop") {
			(stopRefs.current.get(pendingFocus.port) ?? refreshRef.current)?.focus();
		}
	}, [confirmAll, confirmPort, confirmingAllTargetPresent, confirmingTargetPresent]);

	return (
		<div className="background-panel">
			<header className="background-panel-header">
				<div className="background-panel-titlebar">
					<div>
						<h2 className="background-panel-title">{t("bgTasks")}</h2>
						<p className="background-panel-desc">{t("bgTasksDesc")}</p>
					</div>
					<button
						ref={refreshRef}
						type="button"
						className="background-refresh"
						title={t("bgTaskRefresh")}
						aria-label={t("bgTaskRefresh")}
						onClick={refresh}
					>
						<FiRefreshCw aria-hidden="true" />
						<span>{t("bgTaskRefresh")}</span>
					</button>
				</div>
				{servers.length > 0 && (
					<div className="background-panel-actions">
						{confirmAll ? (
							<div className="background-confirm" role="status" aria-live="polite">
								<span>{t("confirmQ")}</span>
								<button type="button" className="background-confirm-stop" onClick={stopAll}>
									{t("bgTaskStopAll")}
								</button>
								<button
									ref={confirmationCancelRef}
									type="button"
									className="background-confirm-cancel"
									onClick={cancelStopAll}
								>
									{t("cancel")}
								</button>
							</div>
						) : (
							<button ref={stopAllRef} type="button" className="background-stop-all" onClick={requestStopAll}>
								{t("bgTaskStopAll")}
							</button>
						)}
					</div>
				)}
			</header>

			{servers.length === 0 ? (
				<div className="background-empty" role="status">
					<div className="background-empty-title">{t("bgTasksEmpty")}</div>
					<div className="background-empty-desc">{t("bgTasksDesc")}</div>
				</div>
			) : (
				<ul className="background-list" aria-label={t("bgTasks")}>
					{servers.map((server) => {
						const name = server.name?.trim() || `${t("bgTaskPort")} ${server.port}`;
						const confirming = confirmPort === server.port;
						return (
							<li className="background-row" key={server.port}>
								<div className="background-row-top">
									<div className="background-name" title={name}>
										{name}
									</div>
									<div className="background-row-actions">
										{confirming ? (
											<div className="background-confirm" role="status" aria-live="polite">
												<span>{t("confirmQ")}</span>
												<button type="button" className="background-confirm-stop" onClick={() => stop(server.port)}>
													{t("bgTaskStop")}
												</button>
												<button
													type="button"
													className="background-confirm-cancel"
													ref={confirmationCancelRef}
													onClick={() => cancelStop(server.port)}
												>
													{t("cancel")}
												</button>
											</div>
										) : (
											<button
												ref={(element) => {
													if (element) stopRefs.current.set(server.port, element);
													else stopRefs.current.delete(server.port);
												}}
												type="button"
												className="background-stop"
												title={`${t("bgTaskStop")}: ${name}`}
												aria-label={`${t("bgTaskStop")}: ${name}`}
												onClick={() => requestStop(server.port)}
											>
												{t("bgTaskStop")}
											</button>
										)}
									</div>
								</div>
								<div className="background-meta">
									<span>
										<span className="background-meta-label">{t("bgTaskPort")}</span> {server.port}
									</span>
									<span>
										<span className="background-meta-label">{t("bgTaskPid")}</span> {server.pid ?? "—"}
									</span>
									<span>
										<span className="background-meta-label">{t("bgTaskSince")}</span>{" "}
										{relativeStart(server.since, now, t)}
									</span>
								</div>
								{server.command && <code className="background-command">{server.command}</code>}
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
