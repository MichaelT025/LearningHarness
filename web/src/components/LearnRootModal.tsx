import { useEffect, useRef, useState } from "react";
import { FiFolder, FiX } from "react-icons/fi";
import type { LearnRootInfo } from "../types";
import { appSend } from "../app-globals";

/**
 * Choice of the learning folder. Two modes:
 *   - first run (no `onClose`): shown while the server reports the root as
 *     unconfigured; it disappears once `learn_root` comes back configured.
 *   - change (`onClose` given): opened from the sidebar; closes on Cancel,
 *     or once the server reports a different root.
 * Topics are plain folders inside it, next to anything the user already
 * keeps there (other folders are left alone).
 */
export function LearnRootModal({ info, onClose }: { info: LearnRootInfo; onClose?: () => void }) {
	const [path, setPath] = useState(info.root || info.defaultRoot);
	const [saving, setSaving] = useState(false);
	const openedWith = useRef(info.root);

	// Every learn_root push answers a save: re-enable the button (a refused
	// path comes back unchanged), and in change mode close once it moved.
	useEffect(() => {
		setSaving(false);
		if (onClose && info.configured && info.root !== openedWith.current) onClose();
	}, [info, onClose]);

	const save = () => {
		const root = path.trim();
		if (!root || saving || info.fromEnv) return;
		setSaving(true);
		appSend({ type: "set_learn_root", root });
	};

	return (
		<div className="modal-backdrop">
			<div className="modal setup-modal">
				{onClose && (
					<button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
						<FiX />
					</button>
				)}
				<div className="modal-head">
					<FiFolder className="modal-head-icon" />
					<h2>{onClose ? "Learning folder" : "Where should your learning live?"}</h2>
				</div>
				<p className="modal-desc">
					Each topic becomes a plain folder here: its roadmap, notes and chat history. Folders you already keep
					here are left alone.
					{onClose && " Topics in the old folder stay on disk; the sidebar lists the new folder's topics."}
				</p>
				<label className="field">
					<span className="field-label">Learning folder</span>
					<input
						type="text"
						value={path}
						spellCheck={false}
						disabled={info.fromEnv}
						onChange={(e) => setPath(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") save();
							else if (e.key === "Escape" && onClose) onClose();
						}}
					/>
					<div className="field-hint">
						{info.fromEnv ? "Set by LEARN_ROOT; unset it to choose here." : `Default: ${info.defaultRoot}`}
					</div>
				</label>
				<div className="setup-actions">
					<button
						type="button"
						className="btn primary"
						disabled={!path.trim() || saving || info.fromEnv}
						onClick={save}
					>
						{saving ? "Saving…" : "Use this folder"}
					</button>
					{onClose && (
						<button type="button" className="btn" onClick={onClose}>
							Cancel
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
