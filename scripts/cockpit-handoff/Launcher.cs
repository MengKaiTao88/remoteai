using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;

internal static class Launcher
{
    private static int Main()
    {
        bool firstInstance;
        using (var instance = new Mutex(true, @"Local\RemoteAIHandoff", out firstInstance))
        {
            if (firstInstance) Supervise();
        }
        return 0;
    }

    private static void Supervise()
    {
        var app = AppDomain.CurrentDomain.BaseDirectory;
        var state = Path.Combine(Directory.GetParent(app.TrimEnd(Path.DirectorySeparatorChar)).FullName, "state");
        var status = Path.Combine(state, "launcher-status.txt");
        while (!RunWorker(app, state, status)) Thread.Sleep(TimeSpan.FromSeconds(15));
    }

    private static bool RunWorker(string app, string state, string status)
    {
        var reason = "LAUNCHER_FAILED";
        try
        {
            var start = new ProcessStartInfo(Path.Combine(app, "node.exe"));
            start.Arguments = Quote(Path.Combine(app, "host.mjs")) + " run " + Quote(state);
            start.WorkingDirectory = app;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardError = true;
            using (var child = Process.Start(start))
            {
                string firstLine = child.StandardError.ReadLine();
                if (firstLine != null && Regex.IsMatch(firstLine, "^[A-Z0-9_]{1,100}$")) reason = firstLine;
                while (child.StandardError.ReadLine() != null) { }
                child.WaitForExit();
                if (child.ExitCode == 0) return true;
            }
        }
        catch (Exception)
        {
            // The launcher reports only a stable stage, never environment data or exception details.
        }
        try { File.WriteAllText(status, reason); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return false;
    }

    private static string Quote(string path)
    {
        return "\"" + path + "\"";
    }
}
