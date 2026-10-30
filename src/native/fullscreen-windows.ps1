# Read-only native foreground/fullscreen detection. No window titles, executable
# paths, screenshots or user input are collected. Parent substitutes its numeric PID.
$ErrorActionPreference = 'Stop'
$OwnerProcessId = __PARENT_PID__
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PetFullscreenState {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public uint flags; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
    public static int Active(uint ownProcess) {
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero || !IsWindowVisible(window) || IsIconic(window)) return 0;
        uint process; GetWindowThreadProcessId(window, out process);
        if (process == ownProcess) return -1;
        StringBuilder name = new StringBuilder(256); GetClassName(window, name, name.Capacity);
        string type = name.ToString();
        if (type == "Progman" || type == "WorkerW" || type == "Shell_TrayWnd" || type == "Shell_SecondaryTrayWnd") return 0;
        int notification;
        if (SHQueryUserNotificationState(out notification) == 0 && (notification == 3 || notification == 4)) return 1;
        RECT rect; if (!GetWindowRect(window, out rect)) return 0;
        MONITORINFO monitor = new MONITORINFO(); monitor.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(MonitorFromWindow(window, 2), ref monitor)) return 0;
        return Math.Abs(rect.Left - monitor.rcMonitor.Left) <= 2 && Math.Abs(rect.Top - monitor.rcMonitor.Top) <= 2 &&
            Math.Abs(rect.Right - monitor.rcMonitor.Right) <= 2 && Math.Abs(rect.Bottom - monitor.rcMonitor.Bottom) <= 2 ? 1 : 0;
    }
    public static void Initialize() { SetProcessDPIAware(); }
}
'@
    [PetFullscreenState]::Initialize()
    while (Get-Process -Id $OwnerProcessId -ErrorAction SilentlyContinue) {
        $petIsFullscreen = [PetFullscreenState]::Active([uint32]$OwnerProcessId)
        if ($petIsFullscreen -eq -1) { [Console]::WriteLine('{"owned":true}') }
        elseif ($petIsFullscreen -eq 1) { [Console]::WriteLine('{"active":true}') }
        else { [Console]::WriteLine('{"active":false}') }
        [Console]::Out.Flush()
        Start-Sleep -Milliseconds 1000
    }
} catch {
    [Console]::WriteLine('{"error":"unavailable"}')
    [Console]::Out.Flush()
    exit 1
}
