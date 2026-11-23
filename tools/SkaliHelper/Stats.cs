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
        var h = ProcessTree.OpenAlive(pid, 0);
        if (h == IntPtr.Zero) return new JsonObject { ["pid"] = pid, ["alive"] = false };
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
