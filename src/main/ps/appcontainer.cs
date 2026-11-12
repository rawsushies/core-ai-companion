// COre agent sandbox, Windows AppContainer launcher (loaded by job-run.ps1).
//
// The command runs as a low-box process in the "COre.AgentSandbox"
// AppContainer with no capabilities:
//   - files: only what is readable by "ALL APPLICATION PACKAGES" (Windows,
//     Program Files) plus the folders COre explicitly grants (the shared
//     project roots, read-write; the program's own folder, read-execute).
//     The user's profile, documents, SSH keys, browser data are not readable.
//   - network: none (no internetClient / privateNetwork capability, loopback
//     to the host blocked).
//   - no access to other processes' windows or objects outside the container.
// The launcher itself stays in the Job Object, and the child inherits it, so
// the process-tree, memory and UI limits still apply.
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class CoreBox {
  public const string Name = "COre.AgentSandbox";

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, int count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public int CapabilityCount; public int Reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr r, out IntPtr w, ref SECURITY_ATTRIBUTES sa, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, int mask, int flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out int code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  // The container's SID string (creates the profile on first use).
  public static string Sid() {
    IntPtr sid;
    int hr = CreateAppContainerProfile(Name, "COre agent sandbox", "Isolated commands run by the COre desktop agent", IntPtr.Zero, 0, out sid);
    if (hr != 0) {
      hr = DeriveAppContainerSidFromAppContainerName(Name, out sid);
      if (hr != 0) throw new Exception("AppContainer unavailable (0x" + hr.ToString("x8") + ")");
    }
    IntPtr s;
    if (!ConvertSidToStringSid(sid, out s)) throw new Exception("SID conversion failed " + Marshal.GetLastWin32Error());
    string str = Marshal.PtrToStringUni(s);
    LocalFree(s);
    return str;
  }

  static IntPtr Sid(out IntPtr raw) {
    int hr = DeriveAppContainerSidFromAppContainerName(Name, out raw);
    if (hr != 0) throw new Exception("AppContainer unavailable (0x" + hr.ToString("x8") + ")");
    return raw;
  }

  static void Pipe(out IntPtr parent, out IntPtr child, bool childWrites) {
    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = true };
    IntPtr r, w;
    if (!CreatePipe(out r, out w, ref sa, 0)) throw new Exception("CreatePipe failed " + Marshal.GetLastWin32Error());
    parent = childWrites ? r : w; child = childWrites ? w : r;
    SetHandleInformation(parent, 1, 0); // the parent's end is not inherited
  }

  static Thread Pump(IntPtr h, Stream to) {
    Thread t = new Thread(() => {
      using (FileStream from = new FileStream(new SafeFileHandle(h, true), FileAccess.Read)) {
        byte[] buf = new byte[8192]; int n;
        try { while ((n = from.Read(buf, 0, buf.Length)) > 0) { to.Write(buf, 0, n); to.Flush(); } } catch (IOException) { }
      }
    });
    t.IsBackground = true; t.Start();
    return t;
  }

  // Runs cmdLine in the container, streams its output, returns its exit code.
  public static int Run(string cmdLine, string cwd) {
    IntPtr sid; Sid(out sid);
    IntPtr inR, inW, outR, outW, errR, errW;
    Pipe(out inW, out inR, false);
    Pipe(out outR, out outW, true);
    Pipe(out errR, out errW, true);

    SECURITY_CAPABILITIES caps = new SECURITY_CAPABILITIES { AppContainerSid = sid, Capabilities = IntPtr.Zero, CapabilityCount = 0 };
    IntPtr capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
    Marshal.StructureToPtr(caps, capsPtr, false);
    IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
    Marshal.WriteIntPtr(handles, 0, inR); Marshal.WriteIntPtr(handles, IntPtr.Size, outW); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, errW);

    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    if (!InitializeProcThreadAttributeList(list, 2, 0, ref size)) throw new Exception("attribute list failed " + Marshal.GetLastWin32Error());
    // PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES 0x20009, PROC_THREAD_ATTRIBUTE_HANDLE_LIST 0x20002
    if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x20009, capsPtr, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero)) throw new Exception("security capabilities failed " + Marshal.GetLastWin32Error());
    if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x20002, handles, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) throw new Exception("handle list failed " + Marshal.GetLastWin32Error());

    STARTUPINFOEX si = new STARTUPINFOEX();
    si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    si.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES
    si.StartupInfo.hStdInput = inR; si.StartupInfo.hStdOutput = outW; si.StartupInfo.hStdError = errW;
    si.lpAttributeList = list;
    PROCESS_INFORMATION pi;
    // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW
    bool ok = CreateProcess(null, new StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, true, 0x80000 | 0x400 | 0x08000000, IntPtr.Zero, cwd, ref si, out pi);
    int err = Marshal.GetLastWin32Error();
    CloseHandle(inR); CloseHandle(outW); CloseHandle(errW); CloseHandle(inW);
    DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); Marshal.FreeHGlobal(handles); Marshal.FreeHGlobal(capsPtr);
    if (!ok) { CloseHandle(outR); CloseHandle(errR); throw new Exception("could not start in the sandbox (error " + err + ")"); }

    Thread a = Pump(outR, Console.OpenStandardOutput());
    Thread b = Pump(errR, Console.OpenStandardError());
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    a.Join(5000); b.Join(5000);
    int code; GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return code;
  }
}
