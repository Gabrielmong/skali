using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using static SkaliHelper.Native;

namespace SkaliHelper;

/// <summary><c>stats</c>: liveness, start time, and CPU / memory summed over each process tree.</summary>
internal static class Stats
{
    public static JsonNode Run(JsonNode request)
    {
        var processes = new JsonArray();
        foreach (var pidNode in request["pids"]?.AsArray() ?? throw new HelperException("pids is required"))
            processes.Add(One(pidNode!.GetValue<int>()));
        return new JsonObject { ["processes"] = processes };
    }

    private static JsonObject One(int pid)
    {
        var (state, h) = ProcessTree.Open(pid, 0);
        if (state == ProcessTree.State.Dead) return new JsonObject { ["pid"] = pid, ["alive"] = false };
        // Exists but we may not look at it: alive, nothing else known. Never report it as dead.
        if (state == ProcessTree.State.Denied) return new JsonObject { ["pid"] = pid, ["alive"] = true };
        long created;
        try
        {
            created = ProcessTree.CreationTime(h);
        }
        finally
        {
            CloseHandle(h);
        }

        long cpu100ns = 0, mem = 0;
        foreach (var p in ProcessTree.WithDescendants(pid, created))
        {
            var ph = ProcessTree.OpenAlive(p, 0);
            if (ph == IntPtr.Zero) continue;
            try
            {
                if (GetProcessTimes(ph, out _, out _, out var kernel, out var user)) cpu100ns += kernel + user;
                if (GetProcessMemoryInfo(ph, out var counters, Marshal.SizeOf<PROCESS_MEMORY_COUNTERS>()))
                    mem += (long)counters.WorkingSetSize;
            }
            finally
            {
                CloseHandle(ph);
            }
        }

        return new JsonObject
        {
            ["pid"] = pid,
            ["alive"] = true,
            ["startTime"] = ProcessTree.FormatTime(created),
            ["cpuMs"] = cpu100ns / 10_000,
            ["memBytes"] = mem,
        };
    }
}
