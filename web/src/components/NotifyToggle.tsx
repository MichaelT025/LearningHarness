import { useEffect, useRef, useState } from "react";
import { FiBell } from "react-icons/fi";
import { useT } from "../i18n";
import {
	loadNotifySettings,
	saveNotifySettings,
	notifyBlockReason,
	notificationPermission,
	requestNotificationPermission,
	sendTestNotification,
	isWindowsPlatform,
	type NotifyDiagnostics,
	type NotifySettings,
} from "../notify";

const TEST_DELAY_MS = 5000;

export function NotifyToggle() {
	const t = useT();
	const [settings, setSettings] = useState<NotifySettings>(loadNotifySettings);
	const [perm, setPerm] = useState<NotificationPermission>(() => notificationPermission());
	const [test, setTest] = useState<NotifyDiagnostics | null>(null);
	const [pending, setPending] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mounted = useRef(true);
	const settingsRef = useRef(settings);
	const intentVersion = useRef(0);
	const testRun = useRef(0);
	settingsRef.current = settings;
	const block = notifyBlockReason();
	useEffect(() => {
		mounted.current = true;
		const sync = () => {
			setPerm(notificationPermission());
			const next = loadNotifySettings();
			settingsRef.current = next;
			setSettings(next);
		};
		const storage = (e: StorageEvent) => {
			if (e.key !== "pi-web-notify") return;
			intentVersion.current += 1;
			testRun.current += 1;
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			setPending(false);
			sync();
		};
		window.addEventListener("focus", sync);
		document.addEventListener("visibilitychange", sync);
		window.addEventListener("storage", storage);
		return () => {
			mounted.current = false;
			intentVersion.current += 1;
			testRun.current += 1;
			if (timer.current) {
				clearTimeout(timer.current);
				timer.current = null;
			}
			window.removeEventListener("focus", sync);
			document.removeEventListener("visibilitychange", sync);
			window.removeEventListener("storage", storage);
		};
	}, []);
	const toggle = async (enabled: boolean) => {
		const version = ++intentVersion.current;
		testRun.current += 1;
		if (timer.current) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		setPending(false);
		const next = { ...settingsRef.current, enabled };
		settingsRef.current = next;
		setSettings(next);
		if (!enabled) {
			saveNotifySettings(next);
			return;
		}
		try {
			const p = await requestNotificationPermission();
			if (!mounted.current || version !== intentVersion.current) return;
			setPerm(p);
			if (p === "granted") {
				settingsRef.current = next;
				setSettings(next);
				saveNotifySettings(next);
			} else {
				const off = { ...next, enabled: false };
				settingsRef.current = off;
				setSettings(off);
				saveNotifySettings(off);
			}
		} catch {
			if (!mounted.current || version !== intentVersion.current) return;
			setPerm("denied");
			const off = { ...next, enabled: false };
			settingsRef.current = off;
			setSettings(off);
			saveNotifySettings(off);
		}
	};
	const runTest = async () => {
		if (pending || block) return;
		const run = ++testRun.current;
		const version = intentVersion.current;
		setTest(null);
		setPending(true);
		try {
			let p = perm;
			if (p !== "granted") p = await requestNotificationPermission();
			if (!mounted.current || run !== testRun.current || version !== intentVersion.current) return;
			setPerm(p);
			if (p !== "granted") {
				setPending(false);
				return;
			}
			if (!settingsRef.current.enabled) {
				const next = { ...settingsRef.current, enabled: true };
				settingsRef.current = next;
				setSettings(next);
				saveNotifySettings(next);
			}
			timer.current = setTimeout(async () => {
				timer.current = null;
				try {
					const result = await sendTestNotification(t("notifyDoneTitle"), t("notifyTestBody"));
					if (mounted.current && run === testRun.current) {
						setTest(result);
						setPending(false);
					}
				} catch {
					if (mounted.current && run === testRun.current) setPending(false);
				}
			}, TEST_DELAY_MS);
		} catch {
			if (mounted.current && run === testRun.current) setPending(false);
		}
	};
	return (
		<div className="sound-menu notify-menu">
			<div className="dd-header">{t("notifyHeader")}</div>
			<label className={`sound-row sound-master${block ? " disabled" : ""}`}>
				<span className="sound-label">
					<FiBell className="sound-icon" />
					<span>{t("notifyEnable")}</span>
				</span>
				<input
					type="checkbox"
					checked={settings.enabled && !block}
					disabled={!!block}
					onChange={(e) => void toggle(e.target.checked)}
				/>
			</label>
			<div className="sound-hint">{t("notifyEnableDesc")}</div>
			{block === "insecure" && <div className="sound-hint">{t("notifyInsecure")}</div>}
			{block === "unsupported" && <div className="sound-hint">{t("notifyUnsupported")}</div>}
			{!block && perm === "denied" && <div className="sound-hint">{t("notifyDenied")}</div>}
			{!block && isWindowsPlatform() && <div className="sound-hint">{t("notifyWindowsHint")}</div>}
			{!block && (
				<>
					<div className="notify-actions">
						<button type="button" className="sound-preview" disabled={pending} onClick={() => void runTest()}>
							{pending ? t("notifyTestPending") : t("notifyTest")}
						</button>
					</div>
					<div className="sound-hint">{t("notifyTestInstruction")}</div>
				</>
			)}
			{test && (
				<div className="sound-hint notify-test-result">
					{test.suppressed
						? t("notifyTestGateSuppressed")
						: test.path === "none"
							? t("notifyTestFailed", { error: test.error ?? "?" })
							: t("notifyTestSent", { path: test.path })}
				</div>
			)}
		</div>
	);
}
