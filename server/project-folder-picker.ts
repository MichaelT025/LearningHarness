import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
let picking = false;

// IFileDialog's FOS_PICKFOLDERS opens the modern Windows Explorer folder
// selector. No user-provided text is interpolated into the PowerShell script.
const windowsPicker = `
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProjectFolderPicker {
 [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IFileDialog {
  [PreserveSig] int Show(IntPtr owner);
  void SetFileTypes(uint count, IntPtr types);
  void SetFileTypeIndex(uint index);
  void GetFileTypeIndex(out uint index);
  void Advise(IntPtr events, out uint cookie);
  void Unadvise(uint cookie);
  void SetOptions(uint options);
  void GetOptions(out uint options);
  void SetDefaultFolder(IntPtr folder);
  void SetFolder(IntPtr folder);
  void GetFolder(out IntPtr folder);
  void GetCurrentSelection(out IntPtr item);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
  void GetFileName(out IntPtr name);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
  void GetResult(out IShellItem item);
 }
 [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IShellItem {
  void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
  void GetParent(out IShellItem parent);
  void GetDisplayName(uint kind, out IntPtr name);
 }
 public static string Pick() {
  var dialog = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
  try {
   uint options;
   dialog.GetOptions(out options);
   dialog.SetOptions(options | 0x20 | 0x40 | 0x800); // folders, filesystem, existing path
   int result = dialog.Show(IntPtr.Zero);
   if (result == unchecked((int)0x800704C7)) return null; // Cancel
   Marshal.ThrowExceptionForHR(result);
   IShellItem item;
   dialog.GetResult(out item);
   try {
    IntPtr name;
    item.GetDisplayName(0x80058000, out name); // SIGDN_FILESYSPATH
    try { return Marshal.PtrToStringUni(name); }
    finally { Marshal.FreeCoTaskMem(name); }
   } finally { Marshal.ReleaseComObject(item); }
  } finally { Marshal.ReleaseComObject(dialog); }
 }
}
'@
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
[Console]::Write([ProjectFolderPicker]::Pick())
`;

/**
 * Turn a failed child process into a readable message. PowerShell writes its
 * error stream as CLIXML when stderr is not a console, and execFile's default
 * message would otherwise echo the whole base64-encoded script.
 */
export function describePickerFailure(file: string, stderr: string | undefined, fallback: string): string {
	const text = (stderr ?? "").trim();
	if (text.startsWith("#< CLIXML")) {
		// The first error record holds the exception message; later ones are
		// position and category noise.
		const first = /<S S="Error">([\s\S]*?)<\/S>/
			.exec(text)?.[1]
			.replace(/_x000D_|_x000A_/g, "")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&amp;/g, "&")
			.trim();
		return first ? `${file}: ${first}` : `${file} exited with an error`;
	}
	if (text) return `${file}: ${text}`;
	return fallback.split("\n")[0];
}

/** Only one native dialog at a time; cancel/repeated clicks make no changes. */
export async function pickProjectFolder(cwd: string): Promise<string | null> {
	if (picking) return null;
	picking = true;
	try {
		let file: string;
		let args: string[];
		if (process.platform === "win32") {
			file = "powershell.exe";
			args = ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(windowsPicker, "utf16le").toString("base64")];
		} else if (process.platform === "darwin") {
			file = "osascript";
			args = [
				"-e",
				"try",
				"-e",
				"POSIX path of (choose folder)",
				"-e",
				"on error number -128",
				"-e",
				'return ""',
				"-e",
				"end try",
			];
		} else {
			file = "zenity";
			args = ["--file-selection", "--directory", `--filename=${cwd}/`];
		}
		try {
			// No timeout: the dialog stays open as long as the user needs it.
			const { stdout } = await exec(file, args, { windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024 });
			return stdout.trim() || null;
		} catch (err) {
			const e = err as { code?: number | string; killed?: boolean; stderr?: string; message: string };
			if (process.platform === "linux" && e.code === 1) return null;
			// The child was killed (e.g. server shutdown) - treat like a cancel.
			if (e.killed) return null;
			throw new Error(describePickerFailure(file, e.stderr, e.message));
		}
	} finally {
		picking = false;
	}
}
