import codexIcon from "../assets/providers/openai-codex.svg";
import opencodeIcon from "../assets/providers/opencode-go.svg";
import commandCodeIcon from "../assets/providers/command-code.svg";
import neutralIcon from "../assets/providers/neutral.svg";

export interface ProviderBrandIconProps {
	providerId: string;
	className?: string;
}

const icons = new Map([
	["openai-codex", codexIcon],
	["opencode-go", opencodeIcon],
	["command-code", commandCodeIcon],
]);

/** A decorative, locally bundled provider mark. Unknown providers use a neutral glyph. */
export function ProviderBrandIcon({ providerId, className }: ProviderBrandIconProps) {
	return (
		<img
			src={icons.get(providerId) ?? neutralIcon}
			className={className}
			data-provider={providerId}
			alt=""
			aria-hidden="true"
		/>
	);
}
