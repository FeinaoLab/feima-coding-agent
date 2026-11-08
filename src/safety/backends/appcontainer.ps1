# Feima AppContainer launcher
#
# Runs one command inside an AppContainer. stdout/stderr are redirected to two
# files that THIS script opens and passes as inherited handles; the Node side
# reads them back afterwards.
#
# Two things here were learned the hard way and must not be "simplified":
#
# 1. lpApplicationName is left NULL and the executable is named in the command
#    line. Passing an explicit C:\Windows\System32\cmd.exe makes CreateProcess
#    fail with a bare "2" (ERROR_FILE_NOT_FOUND) under an AppContainer token.
#    Letting the loader search PATH -- which is what a normal AppContainer
#    launch does -- works.
#
# 2. The stdio handles are created here, not inherited from PowerShell.
#    Node hands PowerShell pipes; a second hop of those pipes under an
#    AppContainer token is not reliable. Owning the handles removes the whole
#    class of failure, and costs nothing: tool execution is request/response.
#
# The command body travels as base64: quotes, newlines and non-ASCII text all
# survive without touching any escaping rules.
#
# THIS FILE MUST STAY PURE ASCII. Windows PowerShell 5.1 reads a BOM-less file
# as ANSI; a single UTF-8 Chinese comment here corrupts the script and
# surfaces as a parser error that looks like "the sandbox is broken".
param(
  [Parameter(Mandatory = $true)][string]$SidString,
  [Parameter(Mandatory = $true)][string]$Cwd,
  [Parameter(Mandatory = $true)][string]$CommandB64,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [Parameter(Mandatory = $true)][string]$ErrFile,
  [Parameter(Mandatory = $true)][string]$AuxFile
)

$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class FeimaAC {
  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_CAPABILITIES {
    public IntPtr AppContainerSid;
    public IntPtr Capabilities;
    public uint CapabilityCount;
    public uint Reserved;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public bool bInheritHandle;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ConvertStringSidToSidW")]
  public static extern bool ConvertStringSidToSid(string str, out IntPtr sid);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr val, IntPtr size, IntPtr prev, IntPtr ret);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool DeleteProcThreadAttributeList(IntPtr list);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr GetStdHandle(int which);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa,
    uint disposition, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcess(string app, string cmdline, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr h, uint ms);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr h, out uint code);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr h);

  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const short STARTF_USESTDHANDLES = 0x00000100;
  const uint GENERIC_READ = 0x80000000;
  const uint GENERIC_WRITE = 0x40000000;
  const uint FILE_SHARE_READ = 0x00000001;
  const uint FILE_SHARE_WRITE = 0x00000002;
  const uint CREATE_ALWAYS = 2;
  const uint OPEN_EXISTING = 3;
  const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;

  // PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES
  static readonly IntPtr ATTR_SECURITY_CAPABILITIES = (IntPtr)0x00020009;
  static readonly IntPtr INVALID_HANDLE = new IntPtr(-1);

  static IntPtr OpenInheritable(string path, uint access, uint disposition) {
    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
    sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
    sa.lpSecurityDescriptor = IntPtr.Zero;
    sa.bInheritHandle = true;
    IntPtr h = CreateFile(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE, ref sa, disposition, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
    if (h == INVALID_HANDLE) throw new Exception("CreateFile failed for " + path + ": " + Marshal.GetLastWin32Error());
    return h;
  }

  public static int Run(string sidString, string cmdline, string cwd, string outFile, string errFile) {
    IntPtr sid;
    if (!ConvertStringSidToSid(sidString, out sid)) {
      throw new Exception("invalid sid: " + sidString);
    }

    SECURITY_CAPABILITIES caps = new SECURITY_CAPABILITIES();
    caps.AppContainerSid = sid;
    caps.Capabilities = IntPtr.Zero;
    caps.CapabilityCount = 0;
    caps.Reserved = 0;

    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    IntPtr capsPtr = IntPtr.Zero;
    try {
      if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) {
        throw new Exception("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
      }
      capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
      Marshal.StructureToPtr(caps, capsPtr, false);
      if (!UpdateProcThreadAttribute(list, 0, ATTR_SECURITY_CAPABILITIES, capsPtr,
          (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero)) {
        throw new Exception("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
      }

      STARTUPINFOEX si = new STARTUPINFOEX();
      si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      si.StartupInfo.hStdInput = GetStdHandle(-10);
      si.StartupInfo.hStdOutput = GetStdHandle(-11);
      si.StartupInfo.hStdError = GetStdHandle(-12);
      si.lpAttributeList = list;

      PROCESS_INFORMATION pi;
      StringBuilder sb = new StringBuilder(cmdline);
      if (!CreateProcess(null, sb.ToString(), IntPtr.Zero, IntPtr.Zero, true,
          EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi)) {
        throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error() + " for [" + cmdline + "]");
      }

      try {
        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        return (int)code;
      } finally {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
      }
    } finally {
      if (capsPtr != IntPtr.Zero) {
        Marshal.FreeHGlobal(capsPtr);
      }
      DeleteProcThreadAttributeList(list);
      Marshal.FreeHGlobal(list);
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $src -Language CSharp
} catch {
  if ($_.Exception.Message -notmatch 'already exists') { throw }
}

# debug dump: proves what the launcher actually received
try {
  $dump = @()
  $dump += 'sysroot=[' + $env:SystemRoot + ']'
  $dump += 'comspec=[' + $env:ComSpec + ']'
  $dump += 'path=[' + $env:PATH + ']'
  $dump += 'temp=[' + $env:TEMP + ']'
  $dump += 'userprofile=[' + $env:USERPROFILE + ']'
  $dump += 'all=[' + (($env | Out-String) -replace "`r?`n", ' | ') + ']'
  $dump | Set-Content -Path ($ErrFile + '.env') -Encoding UTF8
} catch { }

$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CommandB64))
if ([string]::IsNullOrWhiteSpace($command)) {
  [Console]::Error.WriteLine('feima: empty command')
  exit 126
}

# chcp 65001 keeps child output in UTF-8; without it a Chinese Windows console
# emits GBK and the Node side decodes it into mojibake.
# chcp writes to a workspace file instead of the NUL device: an AppContainer
# cannot open NUL for redirection, and the failure would land in stderr as a
# bogus "access denied" line attached to every single command.
$inner = 'cmd.exe /d /c chcp 65001 > "' + $AuxFile + '" 2>&1 & cd /d "' + $Cwd + '" & ( ' + $command + ' ) > "' + $OutFile + '" 2> "' + $ErrFile + '"'

try {
  $code = [FeimaAC]::Run($SidString, $inner, $Cwd, $OutFile, $ErrFile)
  exit $code
} catch {
  [Console]::Error.WriteLine('feima: sandbox launch failed: ' + $_.Exception.Message)
  try {
    $lines = @()
    $lines += 'sysroot=[' + $env:SystemRoot + ']'
    $lines += 'path=[' + $env:PATH + ']'
    $lines += 'comspec=[' + $env:ComSpec + ']'
    $lines += 'cmd_exists=' + (Test-Path 'C://Windows//System32//cmd.exe')
    $lines += 'inner=[' + $inner + ']'
    $lines += 'startDir=[' + $startDir + ']'
    $lines | Set-Content -Path ($ErrFile + '.diag') -Encoding UTF8
  } catch { }
  exit 125
}
