/** Server strings are English-only. `ServerLang` survives as a type so the
 *  existing `lang` plumbing keeps compiling; it always resolves to "en". */
export type ServerLang = string;

export function resolveServerLang(_locale?: string | null): ServerLang {
	return "en";
}
