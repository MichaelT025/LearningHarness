import { useEffect, useState } from "react";
import { FiFolder } from "react-icons/fi";
import type { LearnRootInfo } from "../types";
import { appSend } from "../app-globals";

/**
 * First-run choice of the learning folder. Shown while the server reports
 * the root as unconfigured; closes itself once `learn_root` comes back
 * configured. Topics are plain folders inside it, next to anything the
 * user already keeps there (other folders are left alone).
 */
export function LearnRootModal({ info }: { info: LearnRootInfo }) {
	const [path, setPath] = useState(info.root || info.defaultRoot);
	const [saving, setSaving] = useState(false);

	// A refused path comes back still unconfigured: re-enable the button.
	useEffect(() => {
		setSaving(false);
	}, [info]);

	const save = () => {
		const root = path.trim();
		if (!root || saving) return;
		setSaving(true);
		appSend({ type: "set_learn_root", root });
	};

	return (
		<div className="modal-backdrop">
			<div className="modal setup-modal">
				<div className="modal-head">
					<FiFolder className="modal-head-icon" />
					<h2>Where should your learning live?</h2>
				</div>
				<p className="modal-desc">
					Each topic becomes a plain folder here: its roadmap, notes and chat history. Folders you already keep
					here are left alone.
				</p>
				<label className="field">
					<span className="field-label">Learning folder</span>
					<input
						type="text"
						value={path}
						spellCheck={false}
						onChange={(e) => setPath(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") save();
						}}
					/>
					<div className="field-hint">Default: {info.defaultRoot}</div>
				</label>
				<div className="setup-actions">
					<button type="button" className="btn primary" disabled={!path.trim() || saving} onClick={save}>
						{saving ? "Saving…" : "Use this folder"}
					</button>
				</div>
			</div>
		</div>
	);
}
