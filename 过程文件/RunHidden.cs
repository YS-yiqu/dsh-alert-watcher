using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

// Windowless launcher: built with /target:winexe, so it has no console at all,
// and it starts the target with CreateNoWindow = true (truly no window flash).
// Usage: run-hidden.exe <script|bat> [args...]
class RunHidden
{
    [STAThread]
    static void Main(string[] args)
    {
        if (args == null || args.Length == 0) return;
        string here = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string target = args[0];
        if (!Path.IsPathRooted(target)) target = Path.Combine(here, target);

        string extra = "";
        for (int i = 1; i < args.Length; i++) extra += " " + args[i];

        string ext = Path.GetExtension(target).ToLowerInvariant();
        ProcessStartInfo psi = new ProcessStartInfo();
        if (ext == ".bat" || ext == ".cmd")
        {
            psi.FileName = "cmd.exe";
            psi.Arguments = "/c \"" + target + "\"" + extra;
        }
        else
        {
            psi.FileName = "powershell.exe";
            psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + target + "\"" + extra;
        }
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        psi.WorkingDirectory = here;

        try { Process.Start(psi); } catch { }
    }
}
