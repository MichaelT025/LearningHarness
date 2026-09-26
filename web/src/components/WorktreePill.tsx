import { memo, useEffect, useRef, useState } from "react";
import { FiCheck, FiGitBranch, FiLoader } from "react-icons/fi";
import type { ProjectSummary, WorktreeSummary } from "../types";
import type { WorktreeResult } from "../use-chat";
import { appSend, useAppField } from "../app-globals";
import { useT } from "../i18n";
import { cwdKey, worktreeLabel } from "./left-panel-nav";

interface WorktreePillProps {
	projects: ProjectSummary[];
	/** The active chat has no messages yet: the checkout can still be chosen. */
	emptyChat: boolean;
	worktreeResult: (WorktreeResult & { seq: number }) | null;
}

/** The project and checkout the active cwd belongs to, if it is a git repo. */
function findCheckout(projects: ProjectSummary[], cwd: string): { main: string; current: WorktreeSummary } | null {
	const key = cwdKey(cwd);
	for (const p of projects) {
		for (const w of p.worktrees ?? []) {
			if (cwdKey(w.path) === key) return { main: p.path, current: w };
		}
	}
	return null;
}

/**
 * Branch pill in the composer tool row (Claude-desktop style). It always
 * names the checkout the active chat runs in. While the chat is still empty
 * a **Worktree** checkbox sits beside it: ticking it asks for a branch name
 * (blank = generated) and, on confirm, the server creates the worktree and
 * moves this blank chat there; unticking it in a worktree chat goes back to
 * a blank chat in the main checkout. Once the first message is sent the
 * pill is a read-only badge — a chat never changes checkout mid-way.
 */
export const WorktreePill = memo(function WorktreePill({ projects, emptyChat, worktreeResult }: WorktreePillProps) {
	const t = useT();
	const cwd = useAppField("cwd");
	const checkout = findCheckout(projects, cwd);
	const [mode, setMode] = useState<"idle" | "naming" | "creating">("idle");
	const [name, setName] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	// Leaving the naming/creating state: the server answered (success moves
	// the chat, failure notices), or the chat/cwd changed under us.
	const seenSeq = useRef(worktreeResult?.seq ?? 0);
	useEffect(() => {
		if (!worktreeResult || worktreeResult.seq === seenSeq.current) return;
		seenSeq.current = worktreeResult.seq;
		if (worktreeResult.op === "add") setMode("idle");
	}, [worktreeResult]);
	useEffect(() => {
		setMode("idle");
		setName("");
	}, [cwd]);
	useEffect(() => {
		if (mode === "naming") inputRef.current?.focus();
	}, [mode]);

	if (!checkout) return null;
	const { main, current } = checkout;
	const inWorktree = !current.isMain;
	const branch = worktreeLabel(current);

	const create = () => {
		if (mode === "creating") return;
		setMode("creating");
		if (!appSend({ type: "worktree_add", cwd, branch: name.trim() || undefined })) setMode("idle");
	};
	const onToggle = (checked: boolean) => {
		if (mode === "creating") return;
		if (checked) {
			setMode("naming");
			return;
		}
		if (mode === "naming") {
			setMode("idle");
			setName("");
			return;
		}
		if (inWorktree) appSend({ type: "new_chat", cwd: main });
	};

	const checked = inWorktree || mode !== "idle";
	return (
		<div className={`wt-pill${inWorktree ? " in-worktree" : ""}`} data-worktree-mode={mode}>
			<span className="chip wt-pill-branch" title={current.path} aria-label={t("worktreeBranch", { branch })}>
				{mode === "creating" ? <FiLoader className="wt-spin" aria-hidden="true" /> : <FiGitBranch aria-hidden="true" />}
				<span className="wt-pill-label">{mode === "creating" ? t("worktreeCreating") : branch}</span>
			</span>
			{emptyChat && (
				<label className={`chip wt-toggle${checked ? " on" : ""}`} title={t("worktreeToggleTip")}>
					<input
						type="checkbox"
						checked={checked}
						disabled={mode === "creating"}
						onChange={(e) => onToggle(e.target.checked)}
					/>
					<span>{t("worktreeToggle")}</span>
				</label>
			)}
			{emptyChat && mode === "naming" && (
				<span className="wt-naming">
					<input
						ref={inputRef}
						className="wt-name"
						value={name}
						placeholder={t("worktreeNamePlaceholder")}
						spellCheck={false}
						aria-label={t("worktreeNameLabel")}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (e.key === "Enter" && !e.nativeEvent.isComposing) create();
							else if (e.key === "Escape") onToggle(false);
						}}
					/>
					<button type="button" className="chip wt-create" title={t("worktreeCreate")} onClick={create}>
						<FiCheck aria-hidden="true" />
						<span>{t("worktreeCreate")}</span>
					</button>
				</span>
			)}
		</div>
	);
});
